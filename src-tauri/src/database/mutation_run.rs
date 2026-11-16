//! The one sequence behind every database command: take the mutation gate, check the vault
//! generation and the module switch, lock the active vault, run the durable write, refresh the
//! SQLite projection, then tell the windows. `commands/database.rs` only says what is written and
//! how the projection is refreshed; it never repeats the sequence.
//!
//! The refresh is a hint (SQLite is rebuildable): a failed refresh never undoes the durable write.
//! It is reported as a typed [`ProjectionOutcome`] and, where the result carries warnings, as a
//! [`ProjectionWarning`] whose text is produced in this file only.
use crate::database::model::{DatabaseError, DatabaseModuleState, ProjectionVersion};
use crate::database::projection::{self, ProjectionReport};
use crate::database::rows::{index_created_database_row, CreatedDatabaseRow};
use crate::database::runtime_state::DatabaseRuntimeState;
use crate::database::{history::DatabaseUndoRedoResult, summary};
use crate::lock_util::LockExt;
use crate::vault_context::{ActiveVault, VaultContext};
use std::collections::HashMap;

/// How a projection refresh ended. A success has already been published to the runtime state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProjectionOutcome {
    Published(ProjectionVersion),
    Failed(String),
}

/// What a person is told when the refresh failed after the durable write succeeded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProjectionWarning {
    /// The whole projection could not be rebuilt.
    ProjectionRebuild,
    /// The note index could not take a created row.
    NoteIndexRebuild,
    /// A value batch could not update the rows it touched; carries the reason.
    IncrementalUpdate(String),
}

impl ProjectionWarning {
    /// The sentence carried in a result's `warnings` (the interface contract is a list of strings).
    pub fn message(&self) -> String {
        match self {
            Self::ProjectionRebuild => "Projection rebuild required".to_owned(),
            Self::NoteIndexRebuild => "Note index rebuild required".to_owned(),
            Self::IncrementalUpdate(reason) => {
                format!("Incremental projection update required: {reason}")
            }
        }
    }

    /// True when `warning` is exactly this warning, as carried in a stored result.
    pub fn is(&self, warning: &str) -> bool {
        self.message() == warning
    }

    pub fn push_into(&self, warnings: &mut Vec<String>) {
        warnings.push(self.message());
    }
}

impl ProjectionOutcome {
    pub fn is_failed(&self) -> bool {
        matches!(self, Self::Failed(_))
    }
}

/// What a command body may use: the generation it passed, the locked vault and a way to publish
/// projection versions. It exists only while the vault is locked.
pub struct DatabaseScope<'a> {
    pub generation: u64,
    pub active: &'a ActiveVault,
    runtime: &'a DatabaseRuntimeState,
}

impl From<&ProjectionReport> for ProjectionVersion {
    fn from(report: &ProjectionReport) -> Self {
        Self {
            epoch: report.epoch.clone(),
            seq: report.seq,
        }
    }
}

impl DatabaseScope<'_> {
    /// Records `report` as the current projection version and returns the new module state.
    pub fn set_projection(&self, report: &ProjectionReport) -> DatabaseModuleState {
        self.runtime
            .set_projection(self.generation, Some(ProjectionVersion::from(report)))
    }

    /// Publishes a finished refresh, or logs why it failed. The one place that turns a
    /// `ProjectionReport` into a runtime version.
    pub fn publish(&self, report: Result<ProjectionReport, String>) -> ProjectionOutcome {
        match report {
            Ok(report) => {
                self.set_projection(&report);
                ProjectionOutcome::Published(ProjectionVersion::from(&report))
            }
            Err(error) => {
                tracing::warn!(event = "database_projection_rebuild_failed", %error);
                ProjectionOutcome::Failed(error)
            }
        }
    }

    pub fn rebuild(&self) -> ProjectionOutcome {
        self.publish(projection::rebuild_database_projection(
            &self.active.connection,
            &self.active.root,
        ))
    }

    /// Rebuild; a failure adds `ProjectionRebuild` to `warnings`.
    pub fn rebuild_or_warn(&self, warnings: &mut Vec<String>) {
        if self.rebuild().is_failed() {
            ProjectionWarning::ProjectionRebuild.push_into(warnings);
        }
    }

    /// Rebuild only `database_ids` and the databases tied to them by relations; everything
    /// else keeps its published rows. Falls back to a full rebuild when that is not provably
    /// safe (see `projection::rebuild_database_projection_scoped`).
    pub fn rebuild_databases(&self, database_ids: &[&str]) -> ProjectionOutcome {
        self.publish(projection::rebuild_database_projection_scoped(
            &self.active.connection,
            &self.active.root,
            database_ids,
        ))
    }

    /// Scoped rebuild; a failure adds `ProjectionRebuild` to `warnings`.
    pub fn rebuild_databases_or_warn(&self, database_ids: &[&str], warnings: &mut Vec<String>) {
        if self.rebuild_databases(database_ids).is_failed() {
            ProjectionWarning::ProjectionRebuild.push_into(warnings);
        }
    }

    pub fn refresh_views(&self, database_id: &str) -> ProjectionOutcome {
        self.publish(projection::refresh_database_views(
            &self.active.connection,
            &self.active.root,
            database_id,
        ))
    }

    pub fn refresh_values(&self, database_id: &str, note_ids: &[String]) -> ProjectionOutcome {
        self.publish(projection::update_database_values_incremental(
            &self.active.connection,
            &self.active.root,
            database_id,
            note_ids,
        ))
    }

    /// Refresh the notes an undo or redo touched, each in the database it belongs to (the one
    /// that was undone when the projection does not know the note). A failed refresh is skipped:
    /// the durable change stands and the watcher will repair the projection.
    pub fn refresh_after_history(&self, database_id: &str, result: &DatabaseUndoRedoResult) {
        let mut notes_by_db: HashMap<String, Vec<String>> = HashMap::new();
        for note_id in &result.affected_notes {
            let owner = summary::member_database_id(&self.active.connection, note_id)
                .unwrap_or_else(|| database_id.to_owned());
            notes_by_db.entry(owner).or_default().push(note_id.clone());
        }
        for (owner, note_ids) in notes_by_db {
            if let Ok(report) = projection::update_database_values_incremental(
                &self.active.connection,
                &self.active.root,
                &owner,
                &note_ids,
            ) {
                self.publish(Ok(report));
            }
        }
    }

    /// Put a just-created row into the note index; a failure marks the index for rebuild and
    /// adds `NoteIndexRebuild` to the result.
    pub fn index_created_row(&self, created: &mut CreatedDatabaseRow) {
        if let Err(error) =
            index_created_database_row(&self.active.connection, &self.active.root, created)
        {
            tracing::warn!(event = "database_row_index_update_failed", %error);
            self.active
                .index_health
                .set(crate::model::IndexState::RebuildRequired);
            ProjectionWarning::NoteIndexRebuild.push_into(&mut created.warnings);
        }
    }

    /// The module state as the interface sees it right now.
    pub fn state(&self) -> DatabaseModuleState {
        self.runtime.state(Some(self.generation))
    }
}

pub fn active_generation(context: &VaultContext) -> Option<u64> {
    context
        .conn
        .lock_or_recover()
        .as_ref()
        .map(|active| active.generation)
}

/// Generation (when the caller passes the one it saw), module switch, then the locked vault.
/// Returns the generation the body ran under.
fn run_scoped<T>(
    context: &VaultContext,
    runtime: &DatabaseRuntimeState,
    expected_generation: Option<u64>,
    body: impl FnOnce(&DatabaseScope) -> Result<T, DatabaseError>,
) -> Result<(u64, T), DatabaseError> {
    let actual_generation = active_generation(context).ok_or(DatabaseError::VaultNotOpen)?;
    if let Some(expected) = expected_generation {
        if actual_generation != expected {
            return Err(DatabaseError::VaultGenerationConflict { actual_generation });
        }
    }
    if !runtime.state(Some(actual_generation)).enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let guard = context.conn.lock_or_recover();
    let active = guard.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    let scope = DatabaseScope {
        generation: actual_generation,
        active,
        runtime,
    };
    body(&scope).map(|result| (actual_generation, result))
}

/// A command that only reads: no mutation gate, no notification.
pub fn run_database_read<T>(
    context: &VaultContext,
    runtime: &DatabaseRuntimeState,
    expected_generation: Option<u64>,
    body: impl FnOnce(&DatabaseScope) -> Result<T, DatabaseError>,
) -> Result<T, DatabaseError> {
    run_scoped(context, runtime, expected_generation, body).map(|(_, result)| result)
}

/// A command that changes derived state under the mutation gate but writes no user data (a
/// projection refresh): no notification.
pub fn run_database_exclusive<T>(
    context: &VaultContext,
    runtime: &DatabaseRuntimeState,
    expected_generation: Option<u64>,
    body: impl FnOnce(&DatabaseScope) -> Result<T, DatabaseError>,
) -> Result<T, DatabaseError> {
    let _mutation_guard = context.mutation_gate.lock_or_recover();
    run_database_read(context, runtime, expected_generation, body)
}

/// A command that writes user data. The windows are told (`notify`, with the generation the write
/// ran under) only after the vault lock and the gate are released and only when the command
/// succeeded, so the notice reaches them even if the window that asked has closed.
pub fn run_database_mutation<T>(
    context: &VaultContext,
    runtime: &DatabaseRuntimeState,
    expected_generation: Option<u64>,
    notify: &dyn Fn(u64, &T),
    body: impl FnOnce(&DatabaseScope) -> Result<T, DatabaseError>,
) -> Result<T, DatabaseError> {
    let (generation, result) = {
        let _mutation_guard = context.mutation_gate.lock_or_recover();
        run_scoped(context, runtime, expected_generation, body)?
    };
    notify(generation, &result);
    Ok(result)
}
