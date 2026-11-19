//! Tauri entry points of the database module. Each command names what is written and how the
//! projection is refreshed; the sequence around it (gate, generation, module switch, lock,
//! notification) is `database::mutation_run`, and the SQL behind the lists is `database::summary`.
use crate::database::assets::{
    ImportDatabaseAssetRequest, ImportedDatabaseAsset, ResolveDatabaseAssetPathsRequest,
    ResolvedDatabaseAssetPaths,
};
use crate::database::discovery;
use crate::database::events::DatabaseChangeKind;
use crate::database::history::{
    DatabaseHistoryState, DatabaseHistoryStatus, DatabaseUndoRedoResult,
};
use crate::database::model::{
    CreateDatabaseViewRequest, DatabaseAggregateRequest, DatabaseAggregateResult,
    DatabaseChangedRequest, DatabaseError, DatabaseModuleState, DatabaseNoteContext,
    DatabaseQueryRequest, DatabaseQueryResult, DatabaseSummary, DatabaseViewDocument,
    DatabaseViewMutationResult, DatabaseViewRequest, DeleteDatabaseViewRequest, ProjectionVersion,
    RenameDatabaseViewRequest, ReorderDatabaseViewsRequest, UpdateDatabaseViewConfigRequest,
};
use crate::database::mutation_run::{
    active_generation, run_database_exclusive, run_database_mutation, run_database_read,
    ProjectionOutcome, ProjectionWarning,
};
use crate::database::mutation_state::DatabaseMutationState;
use crate::database::mutations::{
    ChangeDatabasePropertyTypeRequest, ChangedDatabasePropertyType, CreateDatabasePropertyRequest,
    CreateDatabaseRequest, CreatedDatabase, CreatedDatabaseProperty, DatabaseValueBatchRequest,
    DatabaseValueBatchResult, DeleteDatabasePropertyRequest, DeletedDatabaseProperty,
    RenameDatabasePropertyRequest, RenameDatabaseRequest, RenamedDatabase, RenamedDatabaseProperty,
    ReorderDatabasePropertiesRequest, ReorderedDatabaseProperties,
    UpdateDatabasePropertyConfigRequest, UpdateDatabasePropertyOptionsRequest,
    UpdateDatabaseRelationValueRequest, UpdateDatabaseRelationValueResult,
    UpdatedDatabasePropertyConfig, UpdatedDatabasePropertyOptions,
};
use crate::database::relation_lookup::{
    RelationCandidatePage, ResolveRecordReferencesRequest, ResolvedRecordReferences,
    SearchRelationCandidatesRequest,
};
use crate::database::rollup_config::{ConfigureDatabaseRollupRequest, ConfiguredDatabaseRollup};
use crate::database::rows::{
    CreateDatabaseRowRequest, CreatedDatabaseRow, DuplicateDatabaseRowRequest,
};
use crate::database::runtime_state::DatabaseRuntimeState;
use crate::database::summary;
use crate::database::yaml_sync::{
    DatabaseYamlResolveRequest, DatabaseYamlSyncRequest, DatabaseYamlSyncResult,
};
use crate::lock_util::LockExt;
use crate::vault_context::VaultContext;
use crate::watcher::WatcherState;

/// `.map_err(failed("code"))` for a backend message that becomes this command's failure.
fn failed(code: &'static str) -> impl Fn(String) -> DatabaseError {
    move |message| DatabaseError::failed(code, message)
}

#[tauri::command]
#[specta::specta]
pub fn database_layout_status(
    context: tauri::State<'_, VaultContext>,
    expected_generation: u64,
) -> Result<crate::database::layout::LayoutStatus, DatabaseError> {
    let guard = context.conn.lock_or_recover();
    let active = guard.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    if active.generation != expected_generation {
        return Err(DatabaseError::VaultGenerationConflict {
            actual_generation: active.generation,
        });
    }
    crate::database::layout::scan(&active.root)
        .map_err(|message| DatabaseError::failed("databaseLayoutFailed", message))
}

#[tauri::command]
#[specta::specta]
pub async fn upgrade_database_layout(
    app: tauri::AppHandle,
    expected_generation: u64,
) -> Result<crate::database::layout::LayoutStatus, DatabaseError> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let context = app.state::<VaultContext>();
        let _guard = context.mutation_gate.lock_or_recover();
        let root = {
            let guard = context.conn.lock_or_recover();
            let active = guard.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
            if active.generation != expected_generation {
                return Err(DatabaseError::VaultGenerationConflict {
                    actual_generation: active.generation,
                });
            }
            active.root.clone()
        };
        // Stop and join the sync writer before changing a multi-file layout. The link and
        // credentials remain intact; always resume the same vault after success or failure.
        if let Some(sync) = app.try_state::<crate::sync::runtime::SyncRuntime>() {
            sync.deactivate_vault();
        }
        let mut result = crate::database::layout::upgrade(&root)
            .map_err(|message| DatabaseError::failed("databaseLayoutFailed", message));
        if result.is_ok() {
            let guard = context.conn.lock_or_recover();
            if let Some(active) = guard.as_ref() {
                match crate::database::projection::rebuild_database_projection(
                    &active.connection,
                    &root,
                ) {
                    Ok(report) => {
                        app.state::<DatabaseRuntimeState>().set_projection(
                            expected_generation,
                            Some(ProjectionVersion::from(&report)),
                        );
                    }
                    Err(message) => {
                        result = Err(DatabaseError::failed("projectionRebuildFailed", message))
                    }
                }
            }
        }
        if let Err(error) = &result {
            tracing::warn!(event = "database.layout_upgrade_failed", error = ?error);
        }
        use tauri::Emitter;
        let _ = app.emit(
            "amby:database-written",
            serde_json::json!({"generation": expected_generation, "paths": [root.to_string_lossy()], "noteIds": [], "allNotes": true}),
        );
        crate::watcher::notify_published_files(
            &app,
            &root,
            expected_generation,
            std::slice::from_ref(&root),
            None,
        );
        crate::sync::activate_for_open_vault(&app, root);
        result
    })
    .await
    .map_err(|error| DatabaseError::failed("databaseLayoutFailed", error.to_string()))?
}

fn projection_error(message: String) -> DatabaseError {
    DatabaseError::failed("projectionRefreshFailed", message)
}

#[tauri::command]
#[specta::specta]
pub fn get_database_module_state(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
) -> Result<DatabaseModuleState, DatabaseError> {
    Ok(runtime.state(active_generation(&context)))
}

/// Enabling the module rebuilds only the derived SQLite projection. Durable
/// manifest, shard and template files remain untouched; the feature gate is a
/// frontend/app setting and must still be followed by an explicit enable.
#[tauri::command]
#[specta::specta]
pub fn set_database_module_enabled(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    enabled: bool,
    expected_generation: u64,
) -> Result<DatabaseModuleState, DatabaseError> {
    let _mutation_guard = context.mutation_gate.lock_or_recover();
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    if !enabled {
        return Ok(runtime.set_enabled(actual_generation, false));
    }

    let active = context.conn.lock_or_recover();
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    runtime.set_enabled(actual_generation, true);
    if let Some(projection) =
        crate::database::projection::cached_projection_version(&active.connection, &active.root)
            .map_err(|message| DatabaseError::failed("projectionReadFailed", message))?
    {
        return Ok(runtime.set_projection(actual_generation, Some(projection)));
    }
    let report =
        crate::database::projection::rebuild_database_projection(&active.connection, &active.root)
            .map_err(failed("projectionRebuildFailed"))?;
    Ok(runtime.set_projection(actual_generation, Some(ProjectionVersion::from(&report))))
}

/// Refresh only the projection slice affected by a watcher event. A manifest,
/// template, or unknown container change still takes the safe full rebuild
/// path; record and view changes avoid rereading every row in the vault.
#[tauri::command]
#[specta::specta]
pub fn refresh_database_change(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    change: DatabaseChangedRequest,
) -> Result<DatabaseModuleState, DatabaseError> {
    run_database_exclusive(&context, &runtime, Some(change.generation), |scope| {
        let state = scope.state();
        let kind = match change.kind.as_str() {
            "manifest" => DatabaseChangeKind::Manifest,
            "record" => DatabaseChangeKind::Record,
            "view" => DatabaseChangeKind::View,
            "template" => DatabaseChangeKind::Template,
            "note" => DatabaseChangeKind::Note,
            "container" => DatabaseChangeKind::Container,
            _ => {
                return Err(DatabaseError::failed(
                    "invalidDatabaseChange",
                    "Unknown database watcher change kind".to_owned(),
                ));
            }
        };
        let active = scope.active;
        active
            .refresh_pending_index()
            .map_err(failed("projectionRebuildFailed"))?;
        if matches!(kind, DatabaseChangeKind::Note) {
            return Ok(state);
        }
        let database_id = || {
            summary::database_id_for_container(&active.connection, &change.container_path)
                .map_err(|error| projection_error(error.to_string()))
        };
        let rebuild = || {
            crate::database::projection::rebuild_database_projection(
                &active.connection,
                &active.root,
            )
            .map_err(projection_error)
        };
        let report = match kind {
            DatabaseChangeKind::Record => {
                let note_id = std::path::Path::new(&change.path)
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .filter(|value| !value.is_empty());
                match (database_id()?, note_id) {
                    (Some(database_id), Some(note_id)) => {
                        crate::database::projection::update_database_values_incremental(
                            &active.connection,
                            &active.root,
                            &database_id,
                            &[note_id.to_owned()],
                        )
                        .map_err(projection_error)?
                    }
                    _ => rebuild()?,
                }
            }
            DatabaseChangeKind::View => match database_id()? {
                Some(database_id) => crate::database::projection::refresh_database_views(
                    &active.connection,
                    &active.root,
                    &database_id,
                )
                .map_err(projection_error)?,
                None => rebuild()?,
            },
            DatabaseChangeKind::Manifest
            | DatabaseChangeKind::Template
            | DatabaseChangeKind::Container => rebuild()?,
            DatabaseChangeKind::Note => unreachable!(),
        };
        Ok(scope.set_projection(&report))
    })
}

#[tauri::command]
#[specta::specta]
pub fn rebuild_database_projection(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
) -> Result<DatabaseModuleState, DatabaseError> {
    run_database_exclusive(&context, &runtime, None, |scope| {
        let report = crate::database::projection::rebuild_after_pending_index(scope.active)
            .map_err(failed("projectionRebuildFailed"))?;
        Ok(scope.set_projection(&report))
    })
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseWrittenPayload {
    generation: u64,
    paths: Vec<String>,
    note_ids: Vec<String>,
    all_notes: bool,
}

/// Notify windows after durable database publication, even if the initiating renderer closes.
fn notify_database_written<T: serde::Serialize>(
    app: &tauri::AppHandle,
    generation: u64,
    result: &T,
) {
    use tauri::Emitter;
    let value = serde_json::to_value(result).unwrap_or_default();
    let paths = ["notePath", "manifestPath"]
        .iter()
        .filter_map(|key| {
            value
                .get(key)
                .and_then(|item| item.as_str())
                .map(str::to_owned)
        })
        .collect();
    let mut note_ids: Vec<String> = Vec::new();
    if let Some(id) = value.get("noteId").and_then(|item| item.as_str()) {
        note_ids.push(id.to_owned());
    }
    for field in ["revisions", "affectedNotes"] {
        if let Some(items) = value.get(field).and_then(|item| item.as_array()) {
            for item in items {
                if let Some(id) = item
                    .as_str()
                    .or_else(|| item.get("noteId").and_then(|id| id.as_str()))
                {
                    note_ids.push(id.to_owned());
                }
            }
        }
    }
    note_ids.sort();
    note_ids.dedup();
    let all_notes = note_ids.is_empty()
        && value
            .get("changed")
            .and_then(|item| item.as_bool())
            .unwrap_or(false);
    if let Err(error) = app.emit(
        "amby:database-written",
        DatabaseWrittenPayload {
            generation,
            paths,
            note_ids,
            all_notes,
        },
    ) {
        tracing::warn!(event = "database_written_event_failed", %error);
    }
}

#[tauri::command]
#[specta::specta]
pub fn create_database(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: CreateDatabaseRequest,
) -> Result<CreatedDatabase, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let mut request = request;
            let root = &scope.active.root;
            request.parent_path = request
                .parent_path
                .as_deref()
                .map(|path| crate::paths::confine(root, std::path::Path::new(path)))
                .transpose()
                .map_err(failed("invalidParentPath"))?
                .map(|path| path.to_string_lossy().to_string());
            request.note_path = request
                .note_path
                .as_deref()
                .map(|path| crate::paths::confine(root, std::path::Path::new(path)))
                .transpose()
                .map_err(failed("invalidNotePath"))?
                .map(|path| path.to_string_lossy().to_string());
            let mut created =
                crate::database::mutations::create_database(root, &watcher.self_writes, &request)
                    .map_err(failed("databaseCreateFailed"))?;
            scope.rebuild_or_warn(&mut created.warnings);
            Ok(created)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn create_database_property(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: CreateDatabasePropertyRequest,
) -> Result<CreatedDatabaseProperty, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let mut created = crate::database::mutations::create_database_property(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databasePropertyCreateFailed"))?;
            scope.rebuild_databases_or_warn(&[request.database_id.as_str()], &mut created.warnings);
            tracing::info!(
                event = "create_database_property",
                database_id = %request.database_id,
                property_id = %created.property_id,
                property_name = %created.name,
            );
            Ok(created)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn change_database_property_type(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: ChangeDatabasePropertyTypeRequest,
) -> Result<ChangedDatabasePropertyType, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let mut changed = crate::database::mutations::change_database_property_type(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databasePropertyTypeChangeFailed"))?;
            scope.rebuild_databases_or_warn(&[request.database_id.as_str()], &mut changed.warnings);
            tracing::info!(
                event = "change_database_property_type",
                database_id = %request.database_id,
                property_id = %request.property_id,
                target_type = ?request.property_type,
            );
            Ok(changed)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn delete_database_property(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: DeleteDatabasePropertyRequest,
) -> Result<DeletedDatabaseProperty, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let mut deleted = crate::database::mutations::delete_database_property(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databasePropertyDeleteFailed"))?;
            scope.rebuild_databases_or_warn(&[request.database_id.as_str()], &mut deleted.warnings);
            tracing::info!(
                event = "delete_database_property",
                database_id = %request.database_id,
                property_id = %request.property_id,
            );
            Ok(deleted)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn reorder_database_properties(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: ReorderDatabasePropertiesRequest,
) -> Result<ReorderedDatabaseProperties, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let mut reordered = crate::database::mutations::reorder_database_properties(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databasePropertiesReorderFailed"))?;
            scope.rebuild_databases_or_warn(
                &[request.database_id.as_str()],
                &mut reordered.warnings,
            );
            Ok(reordered)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn rename_database(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: RenameDatabaseRequest,
) -> Result<RenamedDatabase, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let mut renamed = crate::database::mutations::rename_database(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databaseRenameFailed"))?;
            scope.rebuild_or_warn(&mut renamed.warnings);
            Ok(renamed)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn rename_database_property(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: RenameDatabasePropertyRequest,
) -> Result<RenamedDatabaseProperty, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let mut renamed = crate::database::mutations::rename_database_property(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databasePropertyRenameFailed"))?;
            scope.rebuild_databases_or_warn(&[request.database_id.as_str()], &mut renamed.warnings);
            tracing::info!(
                event = "rename_database_property",
                database_id = %request.database_id,
                property_id = %request.property_id,
                new_name = %request.name,
            );
            Ok(renamed)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn update_database_property_config(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: UpdateDatabasePropertyConfigRequest,
) -> Result<UpdatedDatabasePropertyConfig, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let mut updated = crate::database::mutations::update_database_property_config(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databasePropertyConfigFailed"))?;
            scope.rebuild_databases_or_warn(&[request.database_id.as_str()], &mut updated.warnings);
            tracing::info!(
                event = "update_database_property_config",
                database_id = %request.database_id,
                property_id = %request.property_id,
            );
            Ok(updated)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn update_database_property_options(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: UpdateDatabasePropertyOptionsRequest,
) -> Result<UpdatedDatabasePropertyOptions, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let mut updated = crate::database::mutations::update_database_property_options(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databasePropertyOptionsFailed"))?;
            scope.rebuild_databases_or_warn(&[request.database_id.as_str()], &mut updated.warnings);
            tracing::info!(
                event = "update_database_property_options",
                database_id = %request.database_id,
                property_id = %request.property_id,
                option_count = updated.options.len(),
            );
            Ok(updated)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn configure_database_rollup(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: ConfigureDatabaseRollupRequest,
) -> Result<ConfiguredDatabaseRollup, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let mut configured = crate::database::rollup_config::configure_database_rollup(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databaseRollupConfigureFailed"))?;
            scope.rebuild_databases_or_warn(
                &[request.database_id.as_str()],
                &mut configured.warnings,
            );
            Ok(configured)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn apply_database_value_batch(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    mutation_state: tauri::State<'_, DatabaseMutationState>,
    watcher: tauri::State<'_, WatcherState>,
    history: tauri::State<'_, DatabaseHistoryState>,
    request: DatabaseValueBatchRequest,
) -> Result<DatabaseValueBatchResult, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            mutation_state.reset_for_generation(scope.generation);
            let cached = mutation_state
                .get(scope.generation, &request)
                .map_err(failed("databaseValueBatchFailed"))?;
            let mut result = match cached {
                Some(result) => result,
                None => crate::database::mutations::apply_value_batch(
                    &scope.active.root,
                    &watcher.self_writes,
                    &request,
                    Some(&history),
                )
                .map_err(failed("databaseValueBatchFailed"))?,
            };
            // A remembered result may carry the old full-rebuild warning; this call refreshes
            // only the touched rows and reports its own outcome.
            result
                .warnings
                .retain(|warning| !ProjectionWarning::ProjectionRebuild.is(warning));
            let note_ids = request
                .cells
                .iter()
                .map(|cell| cell.note_id.clone())
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            if let ProjectionOutcome::Failed(error) =
                scope.refresh_values(&request.database_id, &note_ids)
            {
                ProjectionWarning::IncrementalUpdate(error).push_into(&mut result.warnings);
            }
            tracing::info!(
                event = "apply_database_value_batch",
                database_id = %request.database_id,
                updates_count = request.cells.len(),
            );
            mutation_state.remember(scope.generation, request, result.clone());
            Ok(result)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn update_database_relation_value(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    history: tauri::State<'_, DatabaseHistoryState>,
    request: UpdateDatabaseRelationValueRequest,
) -> Result<UpdateDatabaseRelationValueResult, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let mut result = crate::database::mutations::update_database_relation_value(
                &scope.active.root,
                &watcher.self_writes,
                &request,
                Some(&history),
            )
            .map_err(failed("updateDatabaseRelationValueFailed"))?;
            let projection = crate::database::projection::update_relation_values_incremental(
                &scope.active.connection,
                &scope.active.root,
                &result.affected_notes,
            );
            if let Some(report) = projection.projection {
                scope.set_projection(&report);
            }
            result.warnings.extend(projection.warnings);
            Ok(result)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn undo_database_mutation(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    history: tauri::State<'_, DatabaseHistoryState>,
    database_id: String,
) -> Result<DatabaseUndoRedoResult, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        None,
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let result = history
                .undo(&scope.active.root, &watcher.self_writes, &database_id)
                .map_err(failed("undoDatabaseMutationFailed"))?;
            scope.refresh_after_history(&database_id, &result);
            Ok(result)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn redo_database_mutation(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    history: tauri::State<'_, DatabaseHistoryState>,
    database_id: String,
) -> Result<DatabaseUndoRedoResult, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        None,
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let result = history
                .redo(&scope.active.root, &watcher.self_writes, &database_id)
                .map_err(failed("redoDatabaseMutationFailed"))?;
            scope.refresh_after_history(&database_id, &result);
            Ok(result)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn get_database_history_status(
    history: tauri::State<'_, DatabaseHistoryState>,
    database_id: String,
) -> Result<DatabaseHistoryStatus, DatabaseError> {
    Ok(history.status(&database_id))
}

#[tauri::command]
#[specta::specta]
pub fn create_database_row(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: CreateDatabaseRowRequest,
) -> Result<CreatedDatabaseRow, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let mut created = crate::database::rows::create_database_row(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databaseRowCreateFailed"))?;
            scope.index_created_row(&mut created);
            scope.rebuild_databases_or_warn(&[request.database_id.as_str()], &mut created.warnings);
            tracing::info!(
                event = "create_database_row",
                database_id = %request.database_id,
                title = %request.title,
                row_id = %created.note_id,
            );
            Ok(created)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn duplicate_database_row(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: DuplicateDatabaseRowRequest,
) -> Result<CreatedDatabaseRow, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let mut created = crate::database::rows::duplicate_database_row(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databaseRowDuplicateFailed"))?;
            scope.index_created_row(&mut created);
            scope.rebuild_databases_or_warn(&[request.database_id.as_str()], &mut created.warnings);
            tracing::info!(
                event = "duplicate_database_row",
                database_id = %request.database_id,
                source_row_id = %request.note_id,
                row_id = %created.note_id,
            );
            Ok(created)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn import_database_asset(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: ImportDatabaseAssetRequest,
) -> Result<ImportedDatabaseAsset, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            crate::database::assets::import_database_asset(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databaseAssetImportFailed"))
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn resolve_database_asset_paths(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    request: ResolveDatabaseAssetPathsRequest,
) -> Result<ResolvedDatabaseAssetPaths, DatabaseError> {
    run_database_read(
        &context,
        &runtime,
        Some(request.expected_generation),
        |scope| {
            crate::database::assets::resolve_database_asset_paths(&scope.active.root, &request)
                .map_err(failed("databaseAssetResolveFailed"))
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn search_relation_candidates(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    request: SearchRelationCandidatesRequest,
) -> Result<RelationCandidatePage, DatabaseError> {
    run_database_read(
        &context,
        &runtime,
        Some(request.expected_generation),
        |scope| {
            crate::database::relation_lookup::search_relation_candidates(
                &scope.active.connection,
                &request,
            )
            .map_err(failed("relationSearchFailed"))
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn resolve_record_references(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    request: ResolveRecordReferencesRequest,
) -> Result<ResolvedRecordReferences, DatabaseError> {
    run_database_read(
        &context,
        &runtime,
        Some(request.expected_generation),
        |scope| {
            crate::database::relation_lookup::resolve_record_references(
                &scope.active.connection,
                &request,
            )
            .map_err(failed("recordReferenceResolveFailed"))
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn sync_database_yaml(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: DatabaseYamlSyncRequest,
) -> Result<DatabaseYamlSyncResult, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let result = crate::database::yaml_sync::sync_note(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databaseYamlSyncFailed"))?;
            if result.changed {
                scope.rebuild();
            }
            Ok(result)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn resolve_database_yaml_conflict(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: DatabaseYamlResolveRequest,
) -> Result<DatabaseYamlSyncResult, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let result = crate::database::yaml_sync::resolve_yaml_conflict(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databaseYamlConflictResolutionFailed"))?;
            if result.changed {
                scope.rebuild();
            }
            Ok(result)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn get_database_view(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    request: DatabaseViewRequest,
) -> Result<DatabaseViewDocument, DatabaseError> {
    run_database_read(
        &context,
        &runtime,
        Some(request.expected_generation),
        |scope| {
            crate::database::views::get_view(&scope.active.root, &request)
                .map_err(failed("databaseViewReadFailed"))
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn create_database_view(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: CreateDatabaseViewRequest,
) -> Result<DatabaseViewDocument, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let result = crate::database::views::create_view(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databaseViewCreateFailed"))?;
            scope.refresh_views(&request.database_id);
            Ok(result)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn rename_database_view(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: RenameDatabaseViewRequest,
) -> Result<DatabaseViewMutationResult, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let result = crate::database::views::rename_view(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databaseViewRenameFailed"))?;
            scope.refresh_views(&request.database_id);
            Ok(result)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn update_database_view_config(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: UpdateDatabaseViewConfigRequest,
) -> Result<DatabaseViewMutationResult, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let result = crate::database::views::update_view_config(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databaseViewUpdateFailed"))?;
            scope.refresh_views(&request.database_id);
            Ok(result)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn duplicate_database_view(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: DatabaseViewRequest,
) -> Result<DatabaseViewDocument, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let result = crate::database::views::duplicate_view(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databaseViewDuplicateFailed"))?;
            scope.refresh_views(&request.database_id);
            Ok(result)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn delete_database_view(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: DeleteDatabaseViewRequest,
) -> Result<DatabaseViewMutationResult, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let result = crate::database::views::delete_view(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databaseViewDeleteFailed"))?;
            scope.refresh_views(&request.database_id);
            Ok(result)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn reorder_database_views(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: ReorderDatabaseViewsRequest,
) -> Result<DatabaseViewMutationResult, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let result = crate::database::views::reorder_views(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databaseViewReorderFailed"))?;
            scope.refresh_views(&request.database_id);
            Ok(result)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn set_default_database_view(
    app: tauri::AppHandle,
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: DatabaseViewRequest,
) -> Result<DatabaseViewMutationResult, DatabaseError> {
    run_database_mutation(
        &context,
        &runtime,
        Some(request.expected_generation),
        &|generation, result| notify_database_written(&app, generation, result),
        |scope| {
            let result = crate::database::views::set_default_view(
                &scope.active.root,
                &watcher.self_writes,
                &request,
            )
            .map_err(failed("databaseViewDefaultFailed"))?;
            scope.refresh_views(&request.database_id);
            Ok(result)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn list_databases(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
) -> Result<Vec<DatabaseSummary>, DatabaseError> {
    let state = runtime.state(active_generation(&context));
    if !state.enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    if state.vault_generation.is_none() {
        return Err(DatabaseError::VaultNotOpen);
    }
    let active = context.conn.lock_or_recover();
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    discovery::discover_vault(&active.root)
        .map_err(failed("discoveryFailed"))
        .map(|result| summary::list_database_summaries(&active.connection, result))
}

#[tauri::command]
#[specta::specta]
pub fn get_database_note_context(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    note_id: String,
) -> Result<Option<DatabaseNoteContext>, DatabaseError> {
    database_note_context_inner(&context, &runtime, note_id)
}

/// The body of `get_database_note_context` without the Tauri state wrappers, so a test can ask it
/// right after a real move.
pub(crate) fn database_note_context_inner(
    context: &VaultContext,
    runtime: &DatabaseRuntimeState,
    note_id: String,
) -> Result<Option<DatabaseNoteContext>, DatabaseError> {
    let state = runtime.state(active_generation(context));
    if !state.enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let vault_generation = state.vault_generation.ok_or(DatabaseError::VaultNotOpen)?;
    if ulid::Ulid::from_string(&note_id).is_err() {
        return Err(DatabaseError::failed(
            "invalidNoteId",
            "noteId must be a canonical ULID".to_owned(),
        ));
    }
    let active = context.conn.lock_or_recover();
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    summary::database_note_context(&active.connection, vault_generation, &note_id)
}

#[tauri::command]
#[specta::specta]
pub fn query_database(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    request: DatabaseQueryRequest,
) -> Result<DatabaseQueryResult, DatabaseError> {
    run_database_read(
        &context,
        &runtime,
        Some(request.expected_generation),
        |scope| {
            crate::database::query::query_database(&scope.active.connection, &request)
                .map_err(Into::into)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn aggregate_database(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    request: DatabaseAggregateRequest,
) -> Result<DatabaseAggregateResult, DatabaseError> {
    run_database_read(
        &context,
        &runtime,
        Some(request.expected_generation),
        |scope| {
            crate::database::query::aggregate_database(&scope.active.connection, &request)
                .map_err(Into::into)
        },
    )
}
