//! Note templates and daily notes, the two workspace modules of docs/vault-format.md
//! (Templates and daily notes): their settings in `.amby/workspace.json`, the template list,
//! rendering a template into the text of a new note, and where the note for a day lives.
//! Shared by the desktop commands, the CLI and MCP.

use std::path::{Component, Path};

use serde::Serialize;
use serde_json::Value;

use crate::frontmatter;
use crate::index::read_only::{list_visible, visible_note};
use crate::vault::scan::is_service_directory;

pub const DEFAULT_TEMPLATES_FOLDER: &str = "Templates";
pub const DEFAULT_DAILY_FOLDER: &str = "Daily";
/// The Standard catalogue revision that added the two modules: a module list saved before it
/// gets them (see `vault_tools::modules`).
pub const NOTE_MODULES_REVISION: &str = "2026-11-20";
const MAX_TEMPLATES: usize = 500;

/// Local date and time for the placeholders.
pub struct Moment {
    pub date: String,
    pub time: String,
}

impl Moment {
    pub fn now() -> Self {
        let now = chrono::Local::now();
        Self {
            date: now.format("%Y-%m-%d").to_string(),
            time: now.format("%H:%M").to_string(),
        }
    }

    /// `date` as given (strict `YYYY-MM-DD`), with the current local time.
    pub fn on(date: &str) -> Option<Self> {
        let valid = date.len() == 10
            && chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .is_ok_and(|day| day.format("%Y-%m-%d").to_string() == date);
        valid.then(|| Self {
            date: date.to_owned(),
            ..Self::now()
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
pub struct NoteTemplate {
    /// The path under the templates folder without `.md` (`Work/Review`).
    pub name: String,
    /// The vault-relative path.
    pub path: String,
}

/// What the two modules are set to (`moduleSettings.templates` and `moduleSettings.daily`).
/// A missing or unsafe value means the default.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoteSettings {
    pub templates_folder: String,
    /// Vault-relative; empty for the vault root.
    pub daily_folder: String,
    pub daily_template: Option<String>,
}

impl Default for NoteSettings {
    fn default() -> Self {
        Self {
            templates_folder: DEFAULT_TEMPLATES_FOLDER.to_owned(),
            daily_folder: DEFAULT_DAILY_FOLDER.to_owned(),
            daily_template: None,
        }
    }
}

impl NoteSettings {
    pub fn read(root: &Path) -> Result<Self, &'static str> {
        let Some(workspace) = crate::vault_tools::modules::read_workspace(root)? else {
            return Ok(Self::default());
        };
        Ok(Self::from_workspace(&workspace))
    }

    pub fn from_workspace(workspace: &Value) -> Self {
        let settings = &workspace["moduleSettings"];
        let defaults = Self::default();
        let templates_folder =
            folder(&settings["templates"]["folder"], false).unwrap_or(defaults.templates_folder);
        let daily_folder =
            folder(&settings["daily"]["folder"], true).unwrap_or(defaults.daily_folder);
        let daily_template = settings["daily"]["template"]
            .as_str()
            .map(|name| name.trim().replace('\\', "/"))
            .filter(|name| !name.is_empty() && name.len() <= 1024);
        Self {
            templates_folder,
            daily_folder,
            daily_template,
        }
    }
}

/// A folder setting as a normalized vault-relative path, or `None` when it is unsafe: no
/// absolute paths, `..`, hidden or service folders. `.` (the root) only where allowed.
pub fn folder(value: &Value, root_allowed: bool) -> Option<String> {
    let text = value.as_str()?.trim().replace('\\', "/");
    let text = text.trim_end_matches('/');
    if text == "." {
        return root_allowed.then(String::new);
    }
    if text.is_empty() || text.starts_with('/') || text.len() > 1024 {
        return None;
    }
    let mut parts = Vec::new();
    for component in Path::new(text).components() {
        let Component::Normal(name) = component else {
            return None;
        };
        let name = name.to_str()?;
        if name.starts_with('.') || is_service_directory(&name.to_ascii_lowercase()) {
            return None;
        }
        parts.push(name);
    }
    Some(parts.join("/"))
}

/// Every Markdown note under `folder`, named by its path there without `.md`, sorted.
/// A missing folder has none.
pub fn list(root: &Path, folder: &str) -> Result<Vec<NoteTemplate>, &'static str> {
    let mut templates = Vec::new();
    let mut pending = vec![String::new()];
    while let Some(inner) = pending.pop() {
        let at = if inner.is_empty() {
            folder.to_owned()
        } else {
            format!("{folder}/{inner}")
        };
        let entries = match list_visible(root, &at) {
            Ok(entries) => entries,
            Err("notFound") if inner.is_empty() => Vec::new(),
            Err(code) => return Err(code),
        };
        for (name, is_dir) in entries {
            let child = if inner.is_empty() {
                name
            } else {
                format!("{inner}/{name}")
            };
            if is_dir {
                pending.push(child);
            } else if let Some(stem) = child.strip_suffix(".md") {
                templates.push(NoteTemplate {
                    name: stem.to_owned(),
                    path: format!("{folder}/{child}"),
                });
            }
        }
        if templates.len() > MAX_TEMPLATES {
            return Err("resultTooLarge");
        }
    }
    templates.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(templates)
}

/// A template by name under `folder` (`Work/Review`) or by vault path (`….md`).
pub fn template_text(root: &Path, folder: &str, name: &str) -> Result<String, &'static str> {
    let name = name.trim().replace('\\', "/");
    let relative = if name.to_ascii_lowercase().ends_with(".md") {
        name
    } else {
        format!("{folder}/{name}.md")
    };
    let file = visible_note(root, &relative)?;
    std::fs::read_to_string(file).map_err(|_| "invalidEncoding")
}

/// The template text for a new note: its own `amby-id` dropped (the note gets a new one) and
/// `{{title}}`, `{{date}}` and `{{time}}` filled in. Everything else is kept as written.
pub fn render(text: &str, title: &str, moment: &Moment) -> Result<String, &'static str> {
    let text = if frontmatter::parse_markdown(text).id.is_some() {
        frontmatter::remove_frontmatter_property(text, frontmatter::AMBY_ID_FIELD)
            .map_err(|_| "invalidFrontmatter")?
    } else {
        text.to_owned()
    };
    Ok(text
        .replace("{{title}}", title)
        .replace("{{date}}", &moment.date)
        .replace("{{time}}", &moment.time))
}

/// The vault-relative path of the note for `date` in `folder` (empty for the root).
pub fn daily_relative(folder: &str, date: &str) -> String {
    if folder.is_empty() {
        format!("{date}.md")
    } else {
        format!("{folder}/{date}.md")
    }
}

#[cfg(test)]
#[path = "note_templates_tests.rs"]
mod tests;
