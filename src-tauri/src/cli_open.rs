//! A local argv request can open one visible Markdown note in the main window.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::Path;
use std::sync::Mutex;

use amby_core::desktop_launch::OPEN_NOTE_FLAG;
use amby_core::index::read_only::visible_note;
use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::lock_util::LockExt;
use crate::path_grants::PathGrants;

const EVENT: &str = "amby:cli-open";
const MAX_PENDING: usize = 16;

#[derive(Clone, Serialize, specta::Type)]
pub struct CliOpenNote {
    vault: String,
    path: String,
}

#[derive(Default)]
pub struct PendingCliOpens(Mutex<VecDeque<CliOpenNote>>);

fn parse(arguments: impl IntoIterator<Item = OsString>) -> Option<CliOpenNote> {
    let [flag, vault, path] = arguments.into_iter().collect::<Vec<_>>().try_into().ok()?;
    if flag != OPEN_NOTE_FLAG || !Path::new(&vault).is_absolute() {
        return None;
    }
    let vault = Path::new(&vault).canonicalize().ok()?;
    let path = path.into_string().ok()?;
    visible_note(&vault, &path).ok()?;
    Some(CliOpenNote {
        vault: vault.into_os_string().into_string().ok()?,
        path,
    })
}

pub fn enqueue(app: &tauri::AppHandle, arguments: impl IntoIterator<Item = OsString>) {
    let Some(request) = parse(arguments) else {
        return;
    };
    let queue = app.state::<PendingCliOpens>();
    let mut pending = queue.0.lock_or_recover();
    if pending.len() == MAX_PENDING {
        pending.pop_front();
    }
    pending.push_back(request);
    drop(pending);
    // The queue also covers launches before the main webview can listen.
    let _ = app.emit_to("main", EVENT, ());
}

#[tauri::command]
#[specta::specta]
pub fn take_cli_open(
    window: tauri::WebviewWindow,
    pending: tauri::State<'_, PendingCliOpens>,
    grants: tauri::State<'_, PathGrants>,
) -> Option<CliOpenNote> {
    if window.label() != "main" {
        return None;
    }
    let mut pending = pending.0.lock_or_recover();
    while let Some(request) = pending.pop_front() {
        let vault = Path::new(&request.vault);
        if vault.canonicalize().is_ok_and(|real| real == vault)
            && visible_note(vault, &request.path).is_ok()
        {
            // Only the validated argv request can grant a folder. The renderer
            // supplies no paths to this command.
            grants.grant_folder(vault);
            return Some(request);
        }
    }
    None
}
