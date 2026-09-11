use crate::database::assets::{ImportDatabaseAssetRequest, ImportedDatabaseAsset};
use crate::database::discovery;
use crate::database::format::{DatabaseViewFile, FieldRef};
use crate::database::model::{
    DatabaseError, DatabaseFieldRef, DatabaseModuleState, DatabaseNoteContext,
    DatabaseOptionSummary, DatabasePropertySummary, DatabaseQueryRequest, DatabaseQueryResult,
    DatabaseRow, DatabaseSummary, DatabaseTemplateSummary, DatabaseViewSummary,
};
use crate::database::mutation_state::DatabaseMutationState;
use crate::database::mutations::{
    CreateDatabasePropertyRequest, CreateDatabaseRequest, CreatedDatabase, CreatedDatabaseProperty,
    DatabaseValueBatchRequest, DatabaseValueBatchResult, DeleteDatabasePropertyRequest,
    DeletedDatabaseProperty, RenameDatabasePropertyRequest, RenameDatabaseRequest, RenamedDatabase,
    RenamedDatabaseProperty, ReorderDatabasePropertiesRequest, ReorderedDatabaseProperties,
};
use crate::database::rows::{CreateDatabaseRowRequest, CreatedDatabaseRow};
use crate::database::runtime_state::DatabaseRuntimeState;
use crate::database::yaml_sync::{
    DatabaseYamlResolveRequest, DatabaseYamlSyncRequest, DatabaseYamlSyncResult,
};
use crate::vault_context::VaultContext;
use crate::watcher::WatcherState;
use rusqlite::OptionalExtension;

fn active_generation(context: &VaultContext) -> Option<u64> {
    context
        .conn
        .lock()
        .expect("vault context poisoned")
        .as_ref()
        .map(|active| active.generation)
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
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    if !enabled {
        return Ok(runtime.set_enabled(actual_generation, false));
    }

    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    let report =
        crate::database::projection::rebuild_database_projection(&active.connection, &active.root)
            .map_err(|message| DatabaseError::Failed {
                code: "projectionRebuildFailed".to_owned(),
                message,
            })?;
    runtime.set_enabled(actual_generation, true);
    Ok(runtime.set_projection(
        actual_generation,
        Some(crate::database::model::ProjectionVersion {
            epoch: report.epoch,
            seq: report.seq,
        }),
    ))
}

#[tauri::command]
#[specta::specta]
pub fn rebuild_database_projection(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
) -> Result<DatabaseModuleState, DatabaseError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    let state = runtime.state(Some(actual_generation));
    if !state.enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    let report =
        crate::database::projection::rebuild_database_projection(&active.connection, &active.root)
            .map_err(|message| DatabaseError::Failed {
                code: "projectionRebuildFailed".to_owned(),
                message,
            })?;
    Ok(runtime.set_projection(
        actual_generation,
        Some(crate::database::model::ProjectionVersion {
            epoch: report.epoch,
            seq: report.seq,
        }),
    ))
}

#[tauri::command]
#[specta::specta]
pub fn create_database(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: CreateDatabaseRequest,
) -> Result<CreatedDatabase, DatabaseError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != request.expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    if !runtime.state(Some(actual_generation)).enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let mut request = request;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    request.parent_path = request
        .parent_path
        .as_deref()
        .map(|path| crate::paths::confine(&active.root, std::path::Path::new(path)))
        .transpose()
        .map_err(|message| DatabaseError::Failed {
            code: "invalidParentPath".to_owned(),
            message,
        })?
        .map(|path| path.to_string_lossy().to_string());
    request.note_path = request
        .note_path
        .as_deref()
        .map(|path| crate::paths::confine(&active.root, std::path::Path::new(path)))
        .transpose()
        .map_err(|message| DatabaseError::Failed {
            code: "invalidNotePath".to_owned(),
            message,
        })?
        .map(|path| path.to_string_lossy().to_string());
    let mut created = crate::database::mutations::create_database(&active.root, &watcher, &request)
        .map_err(|message| DatabaseError::Failed {
            code: "databaseCreateFailed".to_owned(),
            message,
        })?;
    match crate::database::projection::rebuild_database_projection(&active.connection, &active.root)
    {
        Ok(report) => {
            runtime.set_projection(
                actual_generation,
                Some(crate::database::model::ProjectionVersion {
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
pub fn create_database_property(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: CreateDatabasePropertyRequest,
) -> Result<CreatedDatabaseProperty, DatabaseError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != request.expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    if !runtime.state(Some(actual_generation)).enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    let mut created =
        crate::database::mutations::create_database_property(&active.root, &watcher, &request)
            .map_err(|message| DatabaseError::Failed {
                code: "databasePropertyCreateFailed".to_owned(),
                message,
            })?;
    match crate::database::projection::rebuild_database_projection(&active.connection, &active.root)
    {
        Ok(report) => {
            runtime.set_projection(
                actual_generation,
                Some(crate::database::model::ProjectionVersion {
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
pub fn delete_database_property(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: DeleteDatabasePropertyRequest,
) -> Result<DeletedDatabaseProperty, DatabaseError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != request.expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    if !runtime.state(Some(actual_generation)).enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    let mut deleted =
        crate::database::mutations::delete_database_property(&active.root, &watcher, &request)
            .map_err(|message| DatabaseError::Failed {
                code: "databasePropertyDeleteFailed".to_owned(),
                message,
            })?;
    match crate::database::projection::rebuild_database_projection(&active.connection, &active.root)
    {
        Ok(report) => {
            runtime.set_projection(
                actual_generation,
                Some(crate::database::model::ProjectionVersion {
                    epoch: report.epoch,
                    seq: report.seq,
                }),
            );
        }
        Err(error) => {
            tracing::warn!(event = "database_projection_rebuild_failed", %error);
            deleted
                .warnings
                .push("Projection rebuild required".to_owned());
        }
    };
    Ok(deleted)
}

#[tauri::command]
#[specta::specta]
pub fn reorder_database_properties(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: ReorderDatabasePropertiesRequest,
) -> Result<ReorderedDatabaseProperties, DatabaseError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != request.expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    if !runtime.state(Some(actual_generation)).enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    let mut reordered =
        crate::database::mutations::reorder_database_properties(&active.root, &watcher, &request)
            .map_err(|message| DatabaseError::Failed {
            code: "databasePropertiesReorderFailed".to_owned(),
            message,
        })?;
    match crate::database::projection::rebuild_database_projection(&active.connection, &active.root)
    {
        Ok(report) => {
            runtime.set_projection(
                actual_generation,
                Some(crate::database::model::ProjectionVersion {
                    epoch: report.epoch,
                    seq: report.seq,
                }),
            );
        }
        Err(error) => {
            tracing::warn!(event = "database_projection_rebuild_failed", %error);
            reordered
                .warnings
                .push("Projection rebuild required".to_owned());
        }
    }
    Ok(reordered)
}

#[tauri::command]
#[specta::specta]
pub fn rename_database(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: RenameDatabaseRequest,
) -> Result<RenamedDatabase, DatabaseError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != request.expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    if !runtime.state(Some(actual_generation)).enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    let mut renamed = crate::database::mutations::rename_database(&active.root, &watcher, &request)
        .map_err(|message| DatabaseError::Failed {
            code: "databaseRenameFailed".to_owned(),
            message,
        })?;
    match crate::database::projection::rebuild_database_projection(&active.connection, &active.root)
    {
        Ok(report) => {
            runtime.set_projection(
                actual_generation,
                Some(crate::database::model::ProjectionVersion {
                    epoch: report.epoch,
                    seq: report.seq,
                }),
            );
        }
        Err(error) => {
            tracing::warn!(event = "database_projection_rebuild_failed", %error);
            renamed
                .warnings
                .push("Projection rebuild required".to_owned());
        }
    }
    Ok(renamed)
}

#[tauri::command]
#[specta::specta]
pub fn rename_database_property(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: RenameDatabasePropertyRequest,
) -> Result<RenamedDatabaseProperty, DatabaseError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != request.expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    if !runtime.state(Some(actual_generation)).enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    let mut renamed =
        crate::database::mutations::rename_database_property(&active.root, &watcher, &request)
            .map_err(|message| DatabaseError::Failed {
                code: "databasePropertyRenameFailed".to_owned(),
                message,
            })?;
    match crate::database::projection::rebuild_database_projection(&active.connection, &active.root)
    {
        Ok(report) => {
            runtime.set_projection(
                actual_generation,
                Some(crate::database::model::ProjectionVersion {
                    epoch: report.epoch,
                    seq: report.seq,
                }),
            );
        }
        Err(error) => {
            tracing::warn!(event = "database_projection_rebuild_failed", %error);
            renamed
                .warnings
                .push("Projection rebuild required".to_owned());
        }
    }
    Ok(renamed)
}

#[tauri::command]
#[specta::specta]
pub fn apply_database_value_batch(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    mutation_state: tauri::State<'_, DatabaseMutationState>,
    watcher: tauri::State<'_, WatcherState>,
    request: DatabaseValueBatchRequest,
) -> Result<DatabaseValueBatchResult, DatabaseError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != request.expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    if !runtime.state(Some(actual_generation)).enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    mutation_state.reset_for_generation(actual_generation);
    let cached = mutation_state
        .get(actual_generation, &request)
        .map_err(|message| DatabaseError::Failed {
            code: "databaseValueBatchFailed".to_owned(),
            message,
        })?;
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    let mut result = match cached {
        Some(result) => result,
        None => crate::database::mutations::apply_value_batch(&active.root, &watcher, &request)
            .map_err(|message| DatabaseError::Failed {
                code: "databaseValueBatchFailed".to_owned(),
                message,
            })?,
    };
    result
        .warnings
        .retain(|warning| warning != "Projection rebuild required");
    match crate::database::projection::rebuild_database_projection(&active.connection, &active.root)
    {
        Ok(report) => {
            runtime.set_projection(
                actual_generation,
                Some(crate::database::model::ProjectionVersion {
                    epoch: report.epoch,
                    seq: report.seq,
                }),
            );
        }
        Err(error) => {
            tracing::warn!(event = "database_projection_rebuild_failed", %error);
            result
                .warnings
                .push("Projection rebuild required".to_owned());
        }
    }
    mutation_state.remember(actual_generation, request, result.clone());
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn create_database_row(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: CreateDatabaseRowRequest,
) -> Result<CreatedDatabaseRow, DatabaseError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != request.expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    if !runtime.state(Some(actual_generation)).enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    let mut created = crate::database::rows::create_database_row(&active.root, &watcher, &request)
        .map_err(|message| DatabaseError::Failed {
            code: "databaseRowCreateFailed".to_owned(),
            message,
        })?;
    if let Err(error) = crate::database::rows::index_created_database_row(
        &active.connection,
        &active.root,
        &created,
    ) {
        tracing::warn!(event = "database_row_index_update_failed", %error);
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
                actual_generation,
                Some(crate::database::model::ProjectionVersion {
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
pub fn import_database_asset(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: ImportDatabaseAssetRequest,
) -> Result<ImportedDatabaseAsset, DatabaseError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != request.expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    if !runtime.state(Some(actual_generation)).enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    crate::database::assets::import_database_asset(&active.root, &watcher, &request).map_err(
        |message| DatabaseError::Failed {
            code: "databaseAssetImportFailed".to_owned(),
            message,
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn sync_database_yaml(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: DatabaseYamlSyncRequest,
) -> Result<DatabaseYamlSyncResult, DatabaseError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != request.expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    if !runtime.state(Some(actual_generation)).enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    let result = crate::database::yaml_sync::sync_note(&active.root, &watcher, &request).map_err(
        |message| DatabaseError::Failed {
            code: "databaseYamlSyncFailed".to_owned(),
            message,
        },
    )?;
    if result.changed {
        match crate::database::projection::rebuild_database_projection(
            &active.connection,
            &active.root,
        ) {
            Ok(report) => {
                runtime.set_projection(
                    actual_generation,
                    Some(crate::database::model::ProjectionVersion {
                        epoch: report.epoch,
                        seq: report.seq,
                    }),
                );
            }
            Err(error) => tracing::warn!(event = "database_projection_rebuild_failed", %error),
        }
    }
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn resolve_database_yaml_conflict(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: DatabaseYamlResolveRequest,
) -> Result<DatabaseYamlSyncResult, DatabaseError> {
    let _mutation_guard = context.mutation_gate.lock().unwrap();
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != request.expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    if !runtime.state(Some(actual_generation)).enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    let result =
        crate::database::yaml_sync::resolve_yaml_conflict(&active.root, &watcher, &request)
            .map_err(|message| DatabaseError::Failed {
                code: "databaseYamlConflictResolutionFailed".to_owned(),
                message,
            })?;
    if result.changed {
        match crate::database::projection::rebuild_database_projection(
            &active.connection,
            &active.root,
        ) {
            Ok(report) => {
                runtime.set_projection(
                    actual_generation,
                    Some(crate::database::model::ProjectionVersion {
                        epoch: report.epoch,
                        seq: report.seq,
                    }),
                );
            }
            Err(error) => tracing::warn!(event = "database_projection_rebuild_failed", %error),
        }
    }
    Ok(result)
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
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    discovery::discover_vault(&active.root)
        .map_err(|message| DatabaseError::Failed {
            code: "discoveryFailed".to_owned(),
            message,
        })
        .map(|result| {
            let diagnostics = result.diagnostics;
            result
                .databases
                .into_iter()
                .map(|database| DatabaseSummary {
                    database_id: database.database_id.clone(),
                    title: database.name,
                    icon: database.icon,
                    attached_note_id: active
                        .connection
                        .query_row(
                            "SELECT attached_note_id FROM db_databases WHERE database_id = ?1",
                            [database.database_id.as_str()],
                            |row| row.get(0),
                        )
                        .ok()
                        .flatten(),
                    manifest_revision: database.revision,
                    locked: active
                        .connection
                        .query_row(
                            "SELECT locked FROM db_databases WHERE database_id = ?1",
                            [database.database_id.as_str()],
                            |row| row.get::<_, bool>(0),
                        )
                        .unwrap_or(database.read_only),
                    properties: database_properties(&active.connection, &database.database_id),
                    views: active
                        .connection
                        .prepare(
                            "SELECT view_id, name, layout, revision, query_json FROM db_views WHERE database_id = ?1 ORDER BY position",
                        )
                        .ok()
                        .and_then(|mut statement| {
                            statement
                                .query_map([database.database_id.as_str()], |row| {
                                    Ok(DatabaseViewSummary {
                                        view_id: row.get(0)?,
                                        title: row.get(1)?,
                                        layout: row.get(2)?,
                                        revision: row.get(3)?,
                                        group_field: row
                                            .get::<_, String>(4)
                                            .ok()
                                            .and_then(|json| serde_json::from_str::<DatabaseViewFile>(&json).ok())
                                            .and_then(|view| view.group)
                                            .and_then(|group| database_field_ref(&group.field)),
                                    })
                                })
                                .ok()
                                .map(|rows| rows.filter_map(Result::ok).collect())
                        })
                        .unwrap_or_default(),
                    templates: active
                        .connection
                        .prepare(
                            "SELECT template_id, name, revision FROM db_templates WHERE database_id = ?1 ORDER BY position",
                        )
                        .ok()
                        .and_then(|mut statement| {
                            statement
                                .query_map([database.database_id.as_str()], |row| {
                                    Ok(DatabaseTemplateSummary {
                                        template_id: row.get(0)?,
                                        name: row.get(1)?,
                                        revision: row.get(2)?,
                                    })
                                })
                                .ok()
                                .map(|rows| rows.filter_map(Result::ok).collect())
                        })
                        .unwrap_or_default(),
                    diagnostics: diagnostics
                        .iter()
                        .filter(|diagnostic| {
                            diagnostic.path == database.relative_container_path
                                || diagnostic.path.starts_with(&format!(
                                    "{}/",
                                    database.relative_container_path
                                ))
                        })
                        .map(|diagnostic| crate::database::model::DatabaseDiagnostic {
                            code: format!("{:?}", diagnostic.code),
                            severity: format!("{:?}", diagnostic.severity),
                            path: diagnostic.path.clone(),
                            message: diagnostic.message.clone(),
                        })
                        .collect(),
                })
                .collect()
        })
}

#[tauri::command]
#[specta::specta]
pub fn get_database_note_context(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    note_id: String,
) -> Result<Option<DatabaseNoteContext>, DatabaseError> {
    let state = runtime.state(active_generation(&context));
    if !state.enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let vault_generation = state.vault_generation.ok_or(DatabaseError::VaultNotOpen)?;
    if ulid::Ulid::from_string(&note_id).is_err() {
        return Err(DatabaseError::Failed {
            code: "invalidNoteId".to_owned(),
            message: "noteId must be a canonical ULID".to_owned(),
        });
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    let row = active
        .connection
        .query_row(
            "SELECT m.database_id, d.name, d.icon, d.manifest_revision, d.locked, m.note_id, n.title, m.relative_path, m.parent_note_id, m.depth, m.category_path, COALESCE(r.revision, '') FROM db_members m JOIN db_databases d ON d.database_id = m.database_id JOIN notes n ON n.id = m.note_id LEFT JOIN db_record_revisions r ON r.database_id = m.database_id AND r.note_id = m.note_id WHERE m.note_id = ?1",
            [&note_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, i64>(9)?.max(0) as usize,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                ))
            },
        )
        .optional()
        .map_err(|error| DatabaseError::Failed {
            code: "databaseNoteContextFailed".to_owned(),
            message: error.to_string(),
        })?;
    let Some((
        database_id,
        database_title,
        database_icon,
        manifest_revision,
        locked,
        note_id,
        title,
        relative_path,
        parent_note_id,
        depth,
        category_path,
        row_revision,
    )) = row
    else {
        return Ok(None);
    };
    let mut statement = active
        .connection
        .prepare("SELECT property_id, canonical_json FROM db_values WHERE database_id = ?1 AND note_id = ?2 ORDER BY property_id")
        .map_err(|error| DatabaseError::Failed {
            code: "databaseNoteContextFailed".to_owned(),
            message: error.to_string(),
        })?;
    let values = statement
        .query_map([database_id.as_str(), note_id.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| DatabaseError::Failed {
            code: "databaseNoteContextFailed".to_owned(),
            message: error.to_string(),
        })?
        .filter_map(Result::ok)
        .fold(
            serde_json::Map::new(),
            |mut values, (property_id, value)| {
                values.insert(
                    property_id,
                    serde_json::from_str(&value).unwrap_or(serde_json::Value::String(value)),
                );
                values
            },
        );
    let values_json = serde_json::to_string(&values).map_err(|error| DatabaseError::Failed {
        code: "databaseNoteContextFailed".to_owned(),
        message: error.to_string(),
    })?;
    Ok(Some(DatabaseNoteContext {
        vault_generation,
        properties: database_properties(&active.connection, &database_id),
        database_id,
        database_title,
        database_icon,
        manifest_revision,
        locked,
        row: DatabaseRow {
            note_id,
            title,
            relative_path,
            parent_note_id,
            depth,
            category_path: serde_json::from_str(&category_path).unwrap_or_default(),
            values_json,
            row_revision,
        },
    }))
}

fn database_properties(
    connection: &rusqlite::Connection,
    database_id: &str,
) -> Vec<DatabasePropertySummary> {
    let Ok(mut statement) = connection.prepare(
        "SELECT property_id, name, property_type, config_json FROM db_properties WHERE database_id = ?1 ORDER BY position",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([database_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .map(
            |(property_id, name, property_type, config_json)| DatabasePropertySummary {
                options: database_options(connection, database_id, &property_id),
                property_id,
                name,
                property_type,
                config_json,
            },
        )
        .collect()
}

fn database_options(
    connection: &rusqlite::Connection,
    database_id: &str,
    property_id: &str,
) -> Vec<DatabaseOptionSummary> {
    let Ok(mut statement) = connection.prepare(
        "SELECT option_id, name, color FROM db_options WHERE database_id = ?1 AND property_id = ?2 ORDER BY position",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([database_id, property_id], |row| {
        Ok(DatabaseOptionSummary {
            option_id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
        })
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

fn database_field_ref(field: &FieldRef) -> Option<DatabaseFieldRef> {
    match field {
        FieldRef::System { field, .. } => Some(DatabaseFieldRef::System {
            field: field.clone(),
        }),
        FieldRef::Property { property_id, .. } => Some(DatabaseFieldRef::Property {
            property_id: property_id.clone(),
        }),
        FieldRef::Opaque(_) => None,
    }
}

#[tauri::command]
#[specta::specta]
pub fn query_database(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    request: DatabaseQueryRequest,
) -> Result<DatabaseQueryResult, DatabaseError> {
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != request.expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    let state = runtime.state(Some(actual_generation));
    if !state.enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    crate::database::query::query_database(&active.connection, &request).map_err(Into::into)
}
