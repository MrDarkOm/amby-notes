//! Templates and daily notes for the CLI and MCP (docs/cli.md): the rules and the module
//! settings live in [`amby_core::note_templates`]; this file adds the write scope, previews and
//! the module switches.

use std::path::{Component, Path};

use amby_core::index::read_only::visible_note;
use amby_core::note_edit::EditKind;
pub use amby_core::note_templates::Moment;
use amby_core::note_templates::{self, NoteSettings};
use amby_core::vault::scan::is_service_directory;
use amby_core::vault_tools::modules::{Module, Modules};
use serde_json::{json, Value};

use crate::edit;

/// The templates of the vault, from the folder the Templates module is set to.
pub fn list(root: &Path) -> Result<Value, &'static str> {
    Modules::require(root, Module::Templates)?;
    let settings = NoteSettings::read(root)?;
    let templates = note_templates::list(root, &settings.templates_folder)?;
    Ok(json!({ "templates": templates }))
}

fn rendered(
    root: &Path,
    settings: &NoteSettings,
    template: &str,
    title: &str,
    moment: &Moment,
) -> Result<String, &'static str> {
    let text = note_templates::template_text(root, &settings.templates_folder, template)?;
    note_templates::render(&text, title, moment)
}

fn stem(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".md").unwrap_or(name)
}

/// Create the note at `path` from a template.
pub fn new_from_template(
    root: &Path,
    scope: Option<&Path>,
    path: &str,
    template: &str,
    dry_run: bool,
    ai: bool,
) -> Result<edit::EditResult, &'static str> {
    Modules::require(root, Module::Templates)?;
    let settings = NoteSettings::read(root)?;
    let content = rendered(root, &settings, template, stem(path), &Moment::now())?;
    edit::execute(root, scope, EditKind::New, path, &content, dry_run, ai)
}

pub struct Daily<'a> {
    pub moment: Moment,
    /// Overrides the folder the Daily notes module is set to.
    pub folder: Option<&'a str>,
    /// Overrides the template the Daily notes module is set to.
    pub template: Option<&'a str>,
    pub append: Option<&'a str>,
    pub dry_run: bool,
}

/// The daily-note folder, checked by the rules for a new note's path (no hidden or service
/// folders, no symlinks, inside the write scope). It may not exist yet.
fn folder_target(
    root: &Path,
    scope: Option<&Path>,
    folder: &str,
) -> Result<std::path::PathBuf, &'static str> {
    if folder.is_empty() {
        return Ok(root.to_path_buf());
    }
    for component in Path::new(folder).components() {
        let Component::Normal(name) = component else {
            return Err("accessDenied");
        };
        let name = name.to_str().ok_or("accessDenied")?;
        if name.starts_with('.') || is_service_directory(&name.to_ascii_lowercase()) {
            return Err("accessDenied");
        }
    }
    let target =
        amby_core::paths::confine_rel_no_symlinks(root, folder).map_err(|_| "accessDenied")?;
    if scope.is_some_and(|scope| !target.starts_with(scope)) {
        return Err("accessDenied");
    }
    Ok(target)
}

/// Open (create when missing) the note for one day, optionally appending text to it.
pub fn daily(
    root: &Path,
    scope: Option<&Path>,
    request: Daily<'_>,
    ai: bool,
) -> Result<Value, &'static str> {
    Modules::require(root, Module::Daily)?;
    let settings = NoteSettings::read(root)?;
    let folder = match request.folder {
        Some(folder) => {
            let folder = folder.replace('\\', "/");
            let folder = folder.trim_matches('/');
            if folder == "." {
                String::new()
            } else {
                folder.to_owned()
            }
        }
        None => settings.daily_folder.clone(),
    };
    let template = request
        .template
        .map(str::to_owned)
        .or_else(|| settings.daily_template.clone());
    let path = note_templates::daily_relative(&folder, &request.moment.date);
    if root.join(&path).is_file() {
        visible_note(root, &path)?;
        let Some(text) = request.append else {
            return Ok(json!({ "path": path, "created": false, "dryRun": request.dry_run }));
        };
        let result = edit::execute(
            root,
            scope,
            EditKind::Append,
            &path,
            text,
            request.dry_run,
            ai,
        )?;
        return Ok(with_created(json!(result), false));
    }
    let mut content = match &template {
        Some(template) => rendered(
            root,
            &settings,
            template,
            &request.moment.date,
            &request.moment,
        )?,
        None => String::new(),
    };
    if let Some(text) = request.append {
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(text);
    }
    let target = folder_target(root, scope, &folder)?;
    if !target.is_dir() {
        if request.dry_run {
            // Nothing to compare with: the folder itself would be new.
            return Ok(json!({ "path": path, "created": true, "dryRun": true }));
        }
        std::fs::create_dir_all(&target).map_err(|_| "unavailable")?;
    }
    let result = edit::execute(
        root,
        scope,
        EditKind::New,
        &path,
        &content,
        request.dry_run,
        ai,
    )?;
    Ok(with_created(json!(result), true))
}

fn with_created(mut result: Value, created: bool) -> Value {
    result["created"] = json!(created);
    result
}
