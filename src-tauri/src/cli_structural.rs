//! The native endpoint accepts only the currently active vault. The desktop
//! publication and its index refresh share the gate used by editor writes.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use amby_core::cli_ipc::{self, Action, Payload, Request};
use amby_core::structural;
use tauri::{Emitter, Manager};

use crate::lock_util::LockExt;
use crate::model::PathChange;
use crate::{app_data, vault_context::VaultContext, watcher};

pub fn start(app: &tauri::AppHandle) {
    let Ok(profile) = app_data::app_root(app) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(mut listener) = cli_ipc::Listener::bind(&profile) else {
            return;
        };
        loop {
            let mut stream = match listener.accept().await {
                Ok(stream) => stream,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue
                }
                Err(_) => break,
            };
            let Ok(request) = cli_ipc::read_request(&mut stream).await else {
                continue;
            };
            let result = match request {
                Ok(request) => {
                    let app = app.clone();
                    tauri::async_runtime::spawn_blocking(move || handle(&app, request))
                        .await
                        .unwrap_or(Err("desktopRequestInterrupted"))
                }
                Err(code) => Err(code),
            }
            .map_err(str::to_owned);
            let _ = cli_ipc::write_response(&mut stream, result).await;
        }
    });
}

fn handle(app: &tauri::AppHandle, request: Request) -> Result<Payload, &'static str> {
    let context = app.state::<VaultContext>();
    let _gate = context.mutation_gate.lock_or_recover();
    let active = context.conn.lock_or_recover();
    let active = active.as_ref().ok_or("vaultNotActive")?;
    if request.vault != active.root
        || active.root.canonicalize().ok().as_ref() != Some(&active.root)
    {
        return Err("vaultNotActive");
    }
    let root = &active.root;
    let generation = active.generation;
    let mut changed = HashSet::new();
    let mut moves = Vec::new();
    let mut archive_changed = false;
    let result = if let Action::Tool {
        grant,
        request: tool,
    } = &request.action
    {
        if tool.required_module().is_some()
            && !app
                .state::<crate::database::runtime_state::DatabaseRuntimeState>()
                .state(Some(generation))
                .enabled
        {
            return Err("moduleDisabled");
        }
        let sync = app.state::<crate::sync::runtime::SyncRuntime>();
        let watcher = app.state::<watcher::WatcherState>();
        amby_core::vault_tools::execute(root, grant, tool, &watcher.self_writes, |changes| {
            sync.note_renames(root, changes);
            moves.extend_from_slice(changes);
        })
        .map(|published| {
            changed.extend(published.changed);
            archive_changed = published.archive_changed;
            Payload::Tool(published.output)
        })
    } else {
        let recovered = structural::recover_desktop(root).map_err(|_| "recoveryRequired");
        if recovered != Ok(false) {
            changed.insert(root.clone());
        }
        recovered.and_then(|recovered| {
            let Some(operation) = request.action.operation() else {
                return Ok(Payload::Recovery(recovered));
            };
            let sync = app.state::<crate::sync::runtime::SyncRuntime>();
            let outcome = structural::execute_active(root, operation, |changes| {
                sync.note_renames(root, changes);
                moves.extend_from_slice(changes);
            });
            match &outcome {
                Ok(outcome) => {
                    if outcome.source != outcome.destination
                        || matches!(
                            request.action,
                            Action::Archive { .. } | Action::Restore { .. }
                        )
                    {
                        if !matches!(request.action, Action::Restore { .. }) {
                            changed.insert(root.join(&outcome.source));
                        }
                        if !matches!(request.action, Action::Archive { .. }) {
                            changed.insert(root.join(&outcome.destination));
                        }
                    }
                    changed.extend(outcome.rewritten_paths.iter().map(|path| root.join(path)));
                }
                Err("recoveryRequired") => {
                    changed.insert(root.clone());
                }
                Err(_) => {}
            }
            outcome.map(Payload::Mutation)
        })
    };
    // A tool never resumes a prior operation. Only its own partial
    // publication needs an immediate refresh.
    if matches!(result, Err("recoveryRequired")) && !moves.is_empty() {
        changed.insert(root.clone());
    }
    archive_changed |= matches!(
        request.action,
        Action::Archive { .. } | Action::Restore { .. } | Action::Recover
    );

    if !changed.is_empty() {
        active
            .index_changes
            .lock_or_recover()
            .extend(changed.iter().cloned());
        // Refresh before the gate opens to queued saves. The watcher keeps
        // the invalidation on failure so the renderer can retry the index.
        let refresh = if matches!(request.action, Action::Tool { .. }) {
            active.refresh_pending_index_without_assigning_ids()
        } else {
            active.refresh_pending_index()
        };
        if refresh.is_err() {
            active.index_changes.lock_or_recover().insert(root.clone());
        }
        publish_changes(
            app,
            root,
            generation,
            changed,
            &moves,
            archive_changed,
            &result,
        );
    }
    result
}

fn publish_changes(
    app: &tauri::AppHandle,
    root: &Path,
    generation: u64,
    changed: HashSet<PathBuf>,
    moves: &[PathChange],
    archive_changed: bool,
    result: &Result<Payload, &'static str>,
) {
    if result.is_ok() {
        crate::commands::mutations::emit_paths_moved(app, "cli", generation, moves.to_vec());
    }
    for path in changed {
        let kind = if path.exists() { "rename" } else { "remove" };
        watcher::emit_external_change(
            app,
            root,
            generation,
            watcher::VaultFileChangedPayload {
                kind: kind.to_owned(),
                path: crate::bundle::path_string(&path),
                generation,
            },
        );
    }
    // A moved directory may have contained a database or a workshop even
    // when the reported path itself does not look like a manifest.
    if let Some(change) = app.try_state::<crate::database::runtime_state::DatabaseRuntimeState>() {
        if change.state(Some(generation)).enabled {
            use crate::database::events::{DatabaseChangeKind, DatabaseChangedPayload};
            let _ = app.emit(
                "database:changed",
                DatabaseChangedPayload {
                    kind: DatabaseChangeKind::Container,
                    path: String::new(),
                    container_path: String::new(),
                    generation,
                    requires_full_rebuild: true,
                },
            );
        }
    }
    let _ = app.emit(
        "project:changed",
        crate::project::model::ProjectChangedPayload {
            kind: "folder",
            path: String::new(),
            generation,
        },
    );
    if archive_changed || result.is_err() {
        let _ = app.emit("amby:archive-changed", generation);
    }
}
