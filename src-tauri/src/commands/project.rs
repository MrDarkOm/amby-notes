//! IPC boundary of the creative-project layer. Commands only check the vault
//! generation and the database module, then call `project::`; they hold the
//! mutation gate while a project or section is written.

use crate::database::history::DatabaseHistoryState;
use crate::database::model::ProjectionVersion;
use crate::database::runtime_state::DatabaseRuntimeState;
use crate::project::create::{self, Env};
use crate::project::index;
use crate::project::model::{
    CreateProjectRequest, CreateProjectSectionRequest, CreateTextPageRequest, CreatedProject,
    CreatedSection, CreatedTextPage, MoveTextPageRequest, MovedTextPage, ProjectCatalog,
    ProjectError,
};
use crate::project::references::{self, NoteReference};
use crate::project::text;
use crate::project::text_stats::{self, TextPageStat};
use crate::vault_context::VaultContext;
use crate::watcher::WatcherState;

fn active_generation(context: &VaultContext) -> Option<u64> {
    context
        .conn
        .lock()
        .expect("vault context poisoned")
        .as_ref()
        .map(|active| active.generation)
}

/// Projects are made of databases, so they follow the database module: with
/// the module off the files stay readable as ordinary folders and notes.
fn require_enabled(runtime: &DatabaseRuntimeState, generation: u64) -> Result<(), ProjectError> {
    if runtime.state(Some(generation)).enabled {
        Ok(())
    } else {
        Err(ProjectError::ModuleDisabled)
    }
}

fn check_generation(context: &VaultContext, expected: u64) -> Result<u64, ProjectError> {
    let actual = active_generation(context).ok_or(ProjectError::VaultNotOpen)?;
    if actual != expected {
        return Err(ProjectError::VaultGenerationConflict {
            actual_generation: actual,
        });
    }
    Ok(actual)
}

#[tauri::command]
#[specta::specta]
pub fn list_projects(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
) -> Result<ProjectCatalog, ProjectError> {
    let generation = active_generation(&context).ok_or(ProjectError::VaultNotOpen)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    index::load_catalog(&active.connection, &active.root, active.generation)
        .map_err(|message| ProjectError::failed("projectIndexFailed", message))
}

/// Rebuilds the project projection from the files, then returns the catalog.
/// The interface calls this after a `project:changed` event.
#[tauri::command]
#[specta::specta]
pub fn refresh_projects(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    expected_generation: u64,
) -> Result<ProjectCatalog, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    index::rebuild_project_index(&active.connection, &active.root)
        .and_then(|_| index::load_catalog(&active.connection, &active.root, generation))
        .map_err(|message| ProjectError::failed("projectIndexFailed", message))
}

/// Publishes what a write changed: the new databases first (sections resolve
/// through them), then the project index. A failure is a warning, never a loss.
fn refresh_after_write(
    active: &crate::vault_context::ActiveVault,
    runtime: &DatabaseRuntimeState,
    generation: u64,
    warnings: &mut Vec<String>,
) {
    match crate::database::projection::rebuild_database_projection(&active.connection, &active.root)
    {
        Ok(report) => {
            runtime.set_projection(
                generation,
                Some(ProjectionVersion {
                    epoch: report.epoch,
                    seq: report.seq,
                }),
            );
        }
        Err(error) => {
            tracing::warn!(event = "database_projection_rebuild_failed", %error);
            warnings.push("Projection rebuild required".to_owned());
        }
    }
    if let Err(error) = index::rebuild_project_index(&active.connection, &active.root) {
        tracing::warn!(event = "project_index_rebuild_failed", %error);
        warnings.push("Project index rebuild required".to_owned());
    }
}

#[tauri::command]
#[specta::specta]
pub fn create_project(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: CreateProjectRequest,
) -> Result<CreatedProject, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, request.expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    let env = Env {
        vault: &active.root,
        watcher: &watcher,
    };
    let mut created = create::create_project(&env, &request)?;
    if !created.replayed {
        refresh_after_write(active, &runtime, generation, &mut created.warnings);
    }
    Ok(created)
}

#[tauri::command]
#[specta::specta]
pub fn create_project_section(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: CreateProjectSectionRequest,
) -> Result<CreatedSection, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, request.expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    let env = Env {
        vault: &active.root,
        watcher: &watcher,
    };
    let mut created = create::create_project_section(&env, &request)?;
    if !created.replayed {
        refresh_after_write(active, &runtime, generation, &mut created.warnings);
    }
    Ok(created)
}

#[tauri::command]
#[specta::specta]
pub fn create_text_page(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: CreateTextPageRequest,
) -> Result<CreatedTextPage, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, request.expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    let env = Env {
        vault: &active.root,
        watcher: &watcher,
    };
    let mut created = text::create_page(&env, &active.connection, &request)?;
    // The app's own write is not echoed by the watcher, so the page is published to the
    // note index here, before the database projection is rebuilt.
    let note_path = std::path::Path::new(&created.note_path);
    let indexed = std::fs::read_to_string(note_path)
        .map_err(|error| error.to_string())
        .and_then(|source| {
            crate::vault_index::index_update_note(
                &active.connection,
                &active.root,
                note_path,
                &source,
            )
        });
    if let Err(error) = indexed {
        tracing::warn!(event = "text_page_index_update_failed", %error);
        active
            .index_health
            .set(crate::model::IndexState::RebuildRequired);
        created
            .warnings
            .push("Note index rebuild required".to_owned());
    }
    match crate::database::projection::rebuild_database_projection(&active.connection, &active.root)
    {
        Ok(report) => {
            runtime.set_projection(
                generation,
                Some(ProjectionVersion {
                    epoch: report.epoch,
                    seq: report.seq,
                }),
            );
        }
        Err(error) => {
            tracing::warn!(event = "database_projection_rebuild_failed", %error);
            created
                .warnings
                .push("Projection rebuild required".to_owned());
        }
    }
    Ok(created)
}

#[tauri::command]
#[specta::specta]
pub fn move_text_page(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    history: tauri::State<'_, DatabaseHistoryState>,
    request: MoveTextPageRequest,
) -> Result<MovedTextPage, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, request.expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    let env = Env {
        vault: &active.root,
        watcher: &watcher,
    };
    let mut moved = text::move_page(&env, &active.connection, Some(&history), &request)?;
    match crate::database::projection::update_database_values_incremental(
        &active.connection,
        &active.root,
        &moved.database_id,
        std::slice::from_ref(&moved.note_id),
    ) {
        Ok(report) => {
            runtime.set_projection(
                generation,
                Some(ProjectionVersion {
                    epoch: report.epoch,
                    seq: report.seq,
                }),
            );
        }
        Err(error) => {
            tracing::warn!(event = "database_projection_rebuild_failed", %error);
            moved
                .warnings
                .push(format!("Incremental projection update required: {error}"));
        }
    }
    Ok(moved)
}

/// The relations of one note in both directions, for the dossier. Read-only.
#[tauri::command]
#[specta::specta]
pub fn list_note_references(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    note_id: String,
) -> Result<Vec<NoteReference>, ProjectError> {
    let generation = active_generation(&context).ok_or(ProjectError::VaultNotOpen)?;
    require_enabled(&runtime, generation)?;
    if ulid::Ulid::from_string(&note_id).is_err() {
        return Err(ProjectError::failed(
            "invalidNoteId",
            "noteId must be a canonical ULID",
        ));
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    references::list_references(&active.connection, &note_id)
}

/// Words and last-change time of every page of one database (a story's text), from the note
/// index. Read-only; the numbers are as fresh as the index, which the watcher keeps current.
#[tauri::command]
#[specta::specta]
pub fn list_text_stats(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    database_id: String,
) -> Result<Vec<TextPageStat>, ProjectError> {
    let generation = active_generation(&context).ok_or(ProjectError::VaultNotOpen)?;
    require_enabled(&runtime, generation)?;
    if database_id.is_empty() || database_id.len() > 128 {
        return Err(ProjectError::failed(
            "invalidDatabaseId",
            "databaseId must be a database ID",
        ));
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    text_stats::list_text_stats(&active.connection, &database_id)
}
