use crate::database::assets::{ImportDatabaseAssetRequest, ImportedDatabaseAsset};
use crate::database::discovery;
use crate::database::format::{DatabaseViewFile, FieldRef};
use crate::database::model::{
    DatabaseError, DatabaseFieldRef, DatabaseModuleState, DatabaseQueryRequest,
    DatabaseQueryResult, DatabaseSummary, DatabaseViewSummary,
};
use crate::database::mutation_state::DatabaseMutationState;
use crate::database::mutations::{
    CreateDatabaseRequest, CreatedDatabase, DatabaseValueBatchRequest, DatabaseValueBatchResult,
};
use crate::database::rows::{CreateDatabaseRowRequest, CreatedDatabaseRow};
use crate::database::runtime_state::DatabaseRuntimeState;
use crate::database::yaml_sync::{
    DatabaseYamlResolveRequest, DatabaseYamlSyncRequest, DatabaseYamlSyncResult,
};
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
    let created = crate::database::mutations::create_database(&active.root, &watcher, &request)
        .map_err(|message| DatabaseError::Failed {
            code: "databaseCreateFailed".to_owned(),
            message,
        })?;
    let report =
        crate::database::projection::rebuild_database_projection(&active.connection, &active.root)
            .map_err(|message| DatabaseError::Failed {
                code: "projectionRebuildFailed".to_owned(),
                message,
            })?;
    runtime.set_projection(
        actual_generation,
        Some(crate::database::model::ProjectionVersion {
            epoch: report.epoch,
            seq: report.seq,
        }),
    );
    Ok(created)
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
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != request.expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    if !runtime.state(Some(actual_generation)).enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    mutation_state.reset_for_generation(actual_generation);
    if let Some(result) = mutation_state.get(actual_generation, &request.operation_id) {
        return Ok(result);
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    let mut result =
        crate::database::mutations::apply_value_batch(&active.root, &watcher, &request).map_err(
            |message| DatabaseError::Failed {
                code: "databaseValueBatchFailed".to_owned(),
                message,
            },
        )?;
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
    mutation_state.remember(actual_generation, result.clone());
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
    let actual_generation = active_generation(&context).ok_or(DatabaseError::VaultNotOpen)?;
    if actual_generation != request.expected_generation {
        return Err(DatabaseError::VaultGenerationConflict { actual_generation });
    }
    if !runtime.state(Some(actual_generation)).enabled {
        return Err(DatabaseError::ModuleDisabled);
    }
    let active = context.conn.lock().expect("vault context poisoned");
    let active = active.as_ref().ok_or(DatabaseError::VaultNotOpen)?;
    crate::database::rows::create_database_row(&active.root, &watcher, &request).map_err(
        |message| DatabaseError::Failed {
            code: "databaseRowCreateFailed".to_owned(),
            message,
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn import_database_asset(
    context: tauri::State<'_, VaultContext>,
    runtime: tauri::State<'_, DatabaseRuntimeState>,
    watcher: tauri::State<'_, WatcherState>,
    request: ImportDatabaseAssetRequest,
) -> Result<ImportedDatabaseAsset, DatabaseError> {
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
