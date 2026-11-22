//! The Templates and Daily notes modules in the app (docs/vault-format.md, Templates and daily
//! notes): the template list, a new note from a template, and today's note. The rules and the
//! module settings are shared with the CLI in `amby_core::note_templates`; the notes are created
//! through `create_note_with_body`, the path of every new note.

use std::fs;
use std::path::Path;

use amby_core::index::read_only::visible_note;
use amby_core::note_templates::{self, Moment, NoteSettings, NoteTemplate};
use amby_core::vault_tools::modules::{Module, Modules};
use serde::Serialize;

use super::mutations::{
    create_note_with_body, mutation_paths, notify_structural_mutation, tree_patch_for,
};
use crate::bundle::path_string;
use crate::lock_util::LockExt;
use crate::model::MutationOutcome;
use crate::storage_error::{StorageError, StorageErrorCode};
use crate::vault_context::VaultContext;
use crate::watcher::{self, PathFingerprint, WatcherState};

/// Today's note: where it is and, when it was just made, the creation to apply to the tree.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DailyNoteOutcome {
    pub path: String,
    pub created: bool,
    pub mutation: Option<MutationOutcome>,
}

/// A code from the shared rules as a storage error; the interface shows its own notice.
fn refused(code: &'static str) -> StorageError {
    let kind = match code {
        "notFound" => StorageErrorCode::NotFound,
        "alreadyExists" => StorageErrorCode::AlreadyExists,
        "accessDenied" => StorageErrorCode::InvalidPath,
        _ => StorageErrorCode::Failed,
    };
    StorageError::new(kind, code)
}

fn settings(root: &Path, module: Module) -> Result<NoteSettings, StorageError> {
    Modules::require(root, module).map_err(refused)?;
    NoteSettings::read(root).map_err(refused)
}

fn rendered(
    root: &Path,
    settings: &NoteSettings,
    template: &str,
    title: &str,
    moment: &Moment,
) -> Result<String, StorageError> {
    let text = note_templates::template_text(root, &settings.templates_folder, template)
        .map_err(refused)?;
    note_templates::render(&text, title, moment).map_err(refused)
}

#[tauri::command]
#[specta::specta]
pub fn list_note_templates(
    db: tauri::State<'_, VaultContext>,
) -> Result<Vec<NoteTemplate>, StorageError> {
    let root = db.root()?;
    let settings = settings(&root, Module::Templates)?;
    note_templates::list(&root, &settings.templates_folder).map_err(refused)
}

#[tauri::command]
#[specta::specta]
pub fn create_note_from_template(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    parent_path: String,
    name: String,
    template: String,
) -> Result<MutationOutcome, StorageError> {
    let outcome = create_from_template_inner(&db, &watcher_state, parent_path, name, &template)?;
    notify_structural_mutation(&app, &db, &outcome);
    Ok(outcome)
}

pub(crate) fn create_from_template_inner(
    db: &VaultContext,
    watcher_state: &WatcherState,
    parent_path: String,
    name: String,
    template: &str,
) -> Result<MutationOutcome, StorageError> {
    let root = db.root()?;
    let settings = settings(&root, Module::Templates)?;
    let body = rendered(&root, &settings, template, name.trim(), &Moment::now())?;
    Ok(create_note_with_body(
        db,
        watcher_state,
        parent_path,
        name,
        Some(&body),
    )?)
}

#[tauri::command]
#[specta::specta]
pub fn open_daily_note(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
) -> Result<DailyNoteOutcome, StorageError> {
    let (outcome, new_folder) = open_daily_inner(&db, &watcher_state, &Moment::now())?;
    if let Some(folder) = new_folder {
        watcher::notify_published_files(&app, &db.root()?, db.generation()?, &[folder], None);
    }
    if let Some(mutation) = &outcome.mutation {
        notify_structural_mutation(&app, &db, mutation);
    }
    Ok(outcome)
}

/// A note in a module's folder (vault-relative, empty for the root), made with the folder when
/// it is missing. Returns the creation and the highest folder it had to make.
fn create_in_folder(
    db: &VaultContext,
    watcher_state: &WatcherState,
    root: &Path,
    relative: &str,
    name: String,
    body: &str,
) -> Result<(MutationOutcome, Option<std::path::PathBuf>), StorageError> {
    let folder = if relative.is_empty() {
        root.to_path_buf()
    } else {
        crate::paths::confine_rel_no_symlinks(root, relative)
            .map_err(|_| refused("accessDenied"))?
    };
    let mut new_folder = None;
    if !folder.is_dir() {
        // The highest folder that is new: the tree patch must bring it, with what is below it.
        let top = folder
            .ancestors()
            .take_while(|ancestor| *ancestor != root && !ancestor.exists())
            .last()
            .unwrap_or(&folder)
            .to_path_buf();
        let _mutation_guard = db.mutation_gate.lock_or_recover();
        let prepared = watcher_state
            .self_writes
            .prepare_write([(&folder, PathFingerprint::Directory)]);
        if let Err(error) = fs::create_dir_all(&folder) {
            watcher_state.self_writes.cancel_prepared_write(&prepared);
            return Err(StorageError::from_io(&error));
        }
        watcher_state.self_writes.confirm_prepared_write(&prepared);
        new_folder = Some(top);
    }
    let mut mutation =
        create_note_with_body(db, watcher_state, path_string(&folder), name, Some(body))?;
    if let Some(top) = &new_folder {
        // Without the new folder the patch names a parent the window does not have yet, and the
        // note shows at the root until the folder arrives on its own.
        mutation.mutation.also_touched.push(top.clone());
        mutation.mutation.tree_patch = tree_patch_for(
            db,
            root,
            "create_note",
            &mutation_paths(&mutation.mutation),
            &[],
        );
    }
    Ok((mutation, new_folder))
}

/// What a new template starts with: the placeholders, so the person sees how they work.
const NEW_TEMPLATE_BODY: &str = "# {{title}}\n\n{{date}}\n";

#[tauri::command]
#[specta::specta]
pub fn create_note_template(
    app: tauri::AppHandle,
    db: tauri::State<'_, VaultContext>,
    watcher_state: tauri::State<'_, WatcherState>,
    name: String,
) -> Result<MutationOutcome, StorageError> {
    let (outcome, new_folder) = create_template_inner(&db, &watcher_state, name)?;
    if let Some(folder) = new_folder {
        watcher::notify_published_files(&app, &db.root()?, db.generation()?, &[folder], None);
    }
    notify_structural_mutation(&app, &db, &outcome);
    Ok(outcome)
}

/// A new template in the templates folder (made when missing); an existing one is never replaced.
pub(crate) fn create_template_inner(
    db: &VaultContext,
    watcher_state: &WatcherState,
    name: String,
) -> Result<(MutationOutcome, Option<std::path::PathBuf>), StorageError> {
    let root = db.root()?;
    let settings = settings(&root, Module::Templates)?;
    create_in_folder(
        db,
        watcher_state,
        &root,
        &settings.templates_folder,
        name,
        NEW_TEMPLATE_BODY,
    )
}

/// Today's note, created (with its folder) when missing. Also returns a folder it had to make.
pub(crate) fn open_daily_inner(
    db: &VaultContext,
    watcher_state: &WatcherState,
    moment: &Moment,
) -> Result<(DailyNoteOutcome, Option<std::path::PathBuf>), StorageError> {
    let root = db.root()?;
    let settings = settings(&root, Module::Daily)?;
    let relative = note_templates::daily_relative(&settings.daily_folder, &moment.date);
    if root.join(&relative).is_file() {
        let note = visible_note(&root, &relative).map_err(refused)?;
        let outcome = DailyNoteOutcome {
            path: path_string(&note),
            created: false,
            mutation: None,
        };
        return Ok((outcome, None));
    }
    let body = match &settings.daily_template {
        Some(template) => rendered(&root, &settings, template, &moment.date, moment)?,
        None => String::new(),
    };
    let (mutation, new_folder) = create_in_folder(
        db,
        watcher_state,
        &root,
        &settings.daily_folder,
        moment.date.clone(),
        &body,
    )?;
    let folder = root.join(&settings.daily_folder);
    let path = mutation
        .mutation
        .primary_path
        .clone()
        .unwrap_or_else(|| path_string(&folder.join(format!("{}.md", moment.date))));
    let outcome = DailyNoteOutcome {
        path,
        created: true,
        mutation: Some(mutation),
    };
    Ok((outcome, new_folder))
}
