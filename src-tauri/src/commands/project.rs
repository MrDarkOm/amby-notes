//! IPC boundary of the creative workshop layer. Commands only check the vault
//! generation and the database module, then call `project::`; they hold the
//! mutation gate while a workshop, story or section is written.

use crate::database::history::DatabaseHistoryState;
use crate::database::model::ProjectionVersion;
use crate::database::runtime_state::DatabaseRuntimeState;
use crate::project::create::{self, Env};
use crate::project::index;
use crate::project::links;
use crate::project::model::{
    AddStoryLinksRequest, AddTextStatusRequest, AddedStoryLinks, AddedTextStatus,
    CreateStoryRequest, CreateTextPageRequest, CreateWorkshopEntityRequest, CreateWorkshopRequest,
    CreateWorkshopSectionRequest, CreatedStory, CreatedTextPage, CreatedWorkshop,
    CreatedWorkshopEntity, CreatedWorkshopSectionResult, EnsurePlotLinksRequest, EnsuredPlotLinks,
    MoveTextPageRequest, MovedTextPage, NotebookCatalog, ProjectCatalog, ProjectError,
    RemoveWorkshopSectionRequest, RemovedWorkshopSection, ReorderWorkshopSectionsRequest,
    ReorderedWorkshopSections, UpdateTextLevelsRequest, UpdateWorkshopRequest, UpdatedTextLevels,
    UpdatedWorkshop,
};
use crate::project::notebooks;
use crate::project::references::{self, NoteReference};
use crate::project::settings;
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

/// Creative workshops are made of databases, so they follow the database module: with
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

/// Rebuilds the workshop projection from the files, then returns the catalog.
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
pub fn create_workshop(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: CreateWorkshopRequest,
) -> Result<CreatedWorkshop, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, request.expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    let env = Env {
        vault: &active.root,
        watcher: &watcher,
    };
    let mut created = create::create_workshop(&env, &request)?;
    if !created.replayed {
        refresh_after_write(active, &runtime, generation, &mut created.warnings);
    }
    Ok(created)
}

#[tauri::command]
#[specta::specta]
pub fn create_story(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: CreateStoryRequest,
) -> Result<CreatedStory, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, request.expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    let env = Env {
        vault: &active.root,
        watcher: &watcher,
    };
    let mut created = create::create_story(&env, &request)?;
    if !created.replayed {
        // Also index the card note into vault index
        let card_path = active.root.join(&created.card_path);
        if let Ok(source) = std::fs::read_to_string(&card_path) {
            let _ = crate::vault_index::index_update_note(
                &active.connection,
                &active.root,
                &card_path,
                &source,
            );
        }
        refresh_after_write(active, &runtime, generation, &mut created.warnings);
    }
    Ok(created)
}

#[tauri::command]
#[specta::specta]
pub fn create_workshop_section(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: CreateWorkshopSectionRequest,
) -> Result<CreatedWorkshopSectionResult, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, request.expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    let env = Env {
        vault: &active.root,
        watcher: &watcher,
    };
    let mut created = create::create_workshop_section(&env, &request)?;
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

/// Words and last-change time of every page of one database, from the note index. Read-only.
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

/// The notebooks (folders) of one base, read from the disk. Read-only; empty ones are listed too.
#[tauri::command]
#[specta::specta]
pub fn list_notebooks(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    database_id: String,
) -> Result<NotebookCatalog, ProjectError> {
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
    notebooks::list_notebooks_of(&active.connection, &active.root, &database_id)
}

#[tauri::command]
#[specta::specta]
pub fn update_workshop(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: UpdateWorkshopRequest,
) -> Result<UpdatedWorkshop, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, request.expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    let env = Env {
        vault: &active.root,
        watcher: &watcher,
    };
    let mut updated = settings::update_workshop(&env, &request)?;
    if !updated.replayed {
        if let Err(error) = index::rebuild_project_index(&active.connection, &active.root) {
            tracing::warn!(event = "project_index_rebuild_failed", %error);
            updated
                .warnings
                .push("Project index rebuild required".to_owned());
        }
    }
    Ok(updated)
}

#[tauri::command]
#[specta::specta]
pub fn remove_workshop_section(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: RemoveWorkshopSectionRequest,
) -> Result<RemovedWorkshopSection, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, request.expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    let env = Env {
        vault: &active.root,
        watcher: &watcher,
    };
    let mut removed = settings::remove_workshop_section(&env, &request)?;
    if !removed.replayed {
        if let Err(error) = index::rebuild_project_index(&active.connection, &active.root) {
            tracing::warn!(event = "project_index_rebuild_failed", %error);
            removed
                .warnings
                .push("Project index rebuild required".to_owned());
        }
    }
    Ok(removed)
}

#[tauri::command]
#[specta::specta]
pub fn reorder_workshop_sections(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: ReorderWorkshopSectionsRequest,
) -> Result<ReorderedWorkshopSections, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, request.expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    let env = Env {
        vault: &active.root,
        watcher: &watcher,
    };
    let mut reordered = settings::reorder_workshop_sections(&env, &request)?;
    if !reordered.replayed {
        if let Err(error) = index::rebuild_project_index(&active.connection, &active.root) {
            tracing::warn!(event = "project_index_rebuild_failed", %error);
            reordered
                .warnings
                .push("Project index rebuild required".to_owned());
        }
    }
    Ok(reordered)
}

#[tauri::command]
#[specta::specta]
pub fn update_text_levels(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: UpdateTextLevelsRequest,
) -> Result<UpdatedTextLevels, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, request.expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    let env = Env {
        vault: &active.root,
        watcher: &watcher,
    };
    let mut updated = settings::update_text_levels(&env, Some(&active.connection), &request)?;
    if !updated.replayed {
        refresh_after_write(active, &runtime, generation, &mut updated.warnings);
    }
    Ok(updated)
}

#[tauri::command]
#[specta::specta]
pub fn add_text_status(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: AddTextStatusRequest,
) -> Result<AddedTextStatus, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, request.expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    let env = Env {
        vault: &active.root,
        watcher: &watcher,
    };
    let mut added = settings::add_text_status(&env, &request)?;
    if !added.replayed {
        refresh_after_write(active, &runtime, generation, &mut added.warnings);
    }
    Ok(added)
}

#[tauri::command]
#[specta::specta]
pub fn add_story_links(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: AddStoryLinksRequest,
) -> Result<AddedStoryLinks, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, request.expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    let env = Env {
        vault: &active.root,
        watcher: &watcher,
    };
    let mut added = links::add_story_links(&env, &request)?;
    if !added.replayed {
        refresh_after_write(active, &runtime, generation, &mut added.warnings);
    }
    Ok(added)
}

#[tauri::command]
#[specta::specta]
pub fn ensure_plot_links(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: EnsurePlotLinksRequest,
) -> Result<EnsuredPlotLinks, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, request.expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    let env = Env {
        vault: &active.root,
        watcher: &watcher,
    };
    let mut ensured = links::ensure_plot_links(&env, &request)?;
    if !ensured.replayed && ensured.changed {
        refresh_after_write(active, &runtime, generation, &mut ensured.warnings);
    }
    Ok(ensured)
}

/// A page of a world section, linked to a story in the same write when one is chosen.
#[tauri::command]
#[specta::specta]
pub fn create_workshop_entity(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: CreateWorkshopEntityRequest,
) -> Result<CreatedWorkshopEntity, ProjectError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let generation = check_generation(&context, request.expected_generation)?;
    require_enabled(&runtime, generation)?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(ProjectError::VaultNotOpen)?;
    let env = Env {
        vault: &active.root,
        watcher: &watcher,
    };
    let mut created = links::create_entity(&env, &request)?;
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
        tracing::warn!(event = "workshop_entity_index_update_failed", %error);
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
