//! Changes the AI panel proposes to notes (docs/road/ai-panel-tools.md, stage 2). A proposal is
//! checked and described without touching the vault; applying it re-checks that the note is
//! still as the model saw it, writes an `ai-edit` version first, and can be undone by the same
//! versions history.

use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use similar::TextDiff;

use crate::note_edit::{Edit, EditKind};
use crate::vault_tools::{properties, Mutation};

#[cfg(test)]
mod tests;

/// Where the panel may write: the notes and folders in the context, or the whole vault when the
/// conversation's switch is on. The model never widens it.
#[derive(Clone, Debug, Default)]
pub struct WriteScope {
    pub vault: bool,
    /// Vault-relative paths of the chosen notes.
    pub notes: Vec<String>,
    /// Vault-relative chosen folders.
    pub folders: Vec<String>,
}

impl WriteScope {
    pub fn allows(&self, relative: &str) -> bool {
        let relative = relative.replace('\\', "/");
        if relative.is_empty()
            || relative
                .split('/')
                .any(|part| part.is_empty() || part == ".." || part == ".")
        {
            return false;
        }
        self.vault
            || self.notes.contains(&relative)
            || self
                .folders
                .iter()
                .any(|folder| !folder.is_empty() && relative.starts_with(&format!("{folder}/")))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProposalOp {
    New {
        path: String,
        content: String,
    },
    Append {
        path: String,
        content: String,
    },
    Replace {
        path: String,
        old_text: String,
        new_text: String,
        replace_all: bool,
    },
    SetProperty {
        path: String,
        name: String,
        value: Value,
        property_type: Option<String>,
    },
    DeleteProperty {
        path: String,
        name: String,
    },
    RenameProperty {
        path: String,
        name: String,
        new_name: String,
    },
    /// A new blank row in a database (the database's folder sets the scope).
    CreateDatabaseRow {
        database_id: String,
        title: String,
    },
    /// Structural changes (stage 4): they go through the same engine as `amby move` and friends,
    /// and a deletion only ever goes to the vault's trash.
    Move {
        path: String,
        folder: String,
    },
    Rename {
        path: String,
        name: String,
    },
    Archive {
        path: String,
    },
    Delete {
        path: String,
    },
    /// A typed value in one cell. `expected_revision` and `operation_id` are filled in when the
    /// change is proposed, so a row that changed since is refused.
    SetDatabaseValue {
        database_id: String,
        note_id: String,
        property_id: String,
        value: Value,
        expected_revision: String,
        operation_id: String,
    },
}

impl ProposalOp {
    /// The path of an existing note a text or property change names; `None` for other changes.
    fn existing_note_path(&mut self) -> Option<&mut String> {
        match self {
            Self::Append { path, .. }
            | Self::Replace { path, .. }
            | Self::SetProperty { path, .. }
            | Self::DeleteProperty { path, .. }
            | Self::RenameProperty { path, .. } => Some(path),
            _ => None,
        }
    }

    fn path(&self) -> &str {
        match self {
            Self::New { path, .. }
            | Self::Append { path, .. }
            | Self::Replace { path, .. }
            | Self::SetProperty { path, .. }
            | Self::DeleteProperty { path, .. }
            | Self::RenameProperty { path, .. }
            | Self::Move { path, .. }
            | Self::Rename { path, .. }
            | Self::Archive { path }
            | Self::Delete { path } => path,
            Self::CreateDatabaseRow { title, .. } => title,
            Self::SetDatabaseValue { note_id, .. } => note_id,
        }
    }

    /// The structural request and its engine word, for a move, rename, archive or deletion.
    fn structural_mutation(&self) -> Option<(Mutation, &'static str)> {
        Some(match self {
            Self::Move { path, folder } => (
                Mutation::Move {
                    path: path.clone(),
                    folder: folder.clone(),
                },
                "move",
            ),
            Self::Rename { path, name } => (
                Mutation::Rename {
                    path: path.clone(),
                    name: name.clone(),
                },
                "rename",
            ),
            Self::Archive { path } => (Mutation::Archive { path: path.clone() }, "archive"),
            Self::Delete { path } => (Mutation::Delete { path: path.clone() }, "delete"),
            _ => return None,
        })
    }

    /// A move, rename, archive or deletion.
    pub fn is_structural(&self) -> bool {
        self.structural_mutation().is_some()
    }

    /// A change that goes through the property or database engine, not a text edit.
    pub fn is_engine_change(&self) -> bool {
        self.engine_mutation().is_some()
    }

    /// The engine's request for a property or database change; `None` for a text change.
    fn engine_mutation(&self) -> Option<Mutation> {
        Some(match self {
            Self::SetProperty {
                path,
                name,
                value,
                property_type,
            } => Mutation::SetProperty(properties::SetProperty {
                path: path.clone(),
                name: name.clone(),
                value: value.clone(),
                property_type: property_type.clone(),
            }),
            Self::DeleteProperty { path, name } => Mutation::DeleteProperty {
                path: path.clone(),
                name: name.clone(),
            },
            Self::RenameProperty {
                path,
                name,
                new_name,
            } => Mutation::RenameProperty {
                path: path.clone(),
                name: name.clone(),
                new_name: new_name.clone(),
            },
            Self::CreateDatabaseRow { database_id, title } => serde_json::from_value(
                serde_json::json!({"kind":"createDatabaseRow","databaseId":database_id,"title":title}),
            )
            .ok()?,
            Self::SetDatabaseValue {
                database_id,
                note_id,
                property_id,
                value,
                expected_revision,
                operation_id,
            } => serde_json::from_value(serde_json::json!({
                "kind":"setDatabaseValue","databaseId":database_id,"noteId":note_id,
                "propertyId":property_id,"value":value,
                "expectedRevision":expected_revision,"operationId":operation_id
            }))
            .ok()?,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub op: ProposalOp,
    /// The note's vault-relative path (`.md` is added to a new note's).
    pub path: String,
    /// SHA-256 of the note as the proposal saw it; `None` for a new note.
    pub base: Option<String>,
    pub diff: String,
    pub diff_truncated: bool,
    /// Every file and folder a structural change touches: the item and what is inside it, where
    /// it goes, and the notes whose links are rewritten. Empty for other changes.
    #[serde(default)]
    pub affected: Vec<String>,
    #[serde(default)]
    pub affected_truncated: bool,
}

impl Proposal {
    /// Does a change touch one of these vault-relative paths (a note with unsaved edits, say)?
    /// A folder in the list covers what is inside it.
    pub fn touches(&self, paths: &[String]) -> bool {
        touches(&self.affected, paths) || paths.contains(&self.path)
    }
}

/// Does one of `paths` equal an `affected` entry or lie inside one?
pub fn touches(affected: &[String], paths: &[String]) -> bool {
    paths.iter().any(|path| {
        affected
            .iter()
            .any(|item| path == item || path.starts_with(&format!("{item}/")))
    })
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub path: String,
    /// The `ai-edit` version holding the text before the change; `None` for a new note.
    pub snapshot_id: Option<String>,
    /// SHA-256 of the note as the apply left it.
    pub after: String,
    /// The apply created the note, so undoing it moves the note to the trash.
    #[serde(default)]
    pub created: bool,
    /// The database row the apply created, which undoing deletes through the database domain.
    #[serde(default)]
    pub row: Option<RowRef>,
    /// What undoes a structural change.
    #[serde(default)]
    pub inverse: Option<Inverse>,
    /// A deletion to the system trash: it cannot be undone from here.
    #[serde(default)]
    pub removed: bool,
    /// The files the change touched, for the unsaved-notes check before an undo.
    #[serde(default)]
    pub affected: Vec<String>,
}

/// How a structural change is taken back.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Inverse {
    /// Move the item (now at `path`) back into its old folder (`.` is the vault root).
    Move { path: String, folder: String },
    /// Give the item (now at `path`) its old name back.
    Rename { path: String, name: String },
    /// Bring an archived item back; `path` is its place in the archive.
    Restore { path: String },
}

impl Inverse {
    /// Where the applied change left the item; it must be unchanged for an undo.
    fn current(&self) -> Option<String> {
        match self {
            Self::Move { path, .. } | Self::Rename { path, .. } => Some(path.clone()),
            Self::Restore { path } => Some(format!(".amby/archive/{path}")),
        }
    }

    fn mutation(&self) -> Option<Mutation> {
        Some(match self {
            Self::Move { path, folder } => Mutation::Move {
                path: path.clone(),
                folder: folder.clone(),
            },
            Self::Rename { path, name } => Mutation::Rename {
                path: path.clone(),
                name: name.clone(),
            },
            Self::Restore { path } => Mutation::Restore { path: path.clone() },
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RowRef {
    pub database_id: String,
    pub note_id: String,
}

#[derive(Debug, PartialEq)]
pub enum UndoPlan {
    Restore {
        snapshot_id: String,
    },
    Trash {
        path: String,
    },
    DeleteRow {
        database_id: String,
        note_id: String,
    },
    /// A structural change goes back by its inverse operation.
    Structural(Inverse),
}

fn digest(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

const DIFF_LIMIT: usize = 20_000;

/// The vault-relative path of an existing note the AI named, with `.md` added when it named the
/// note by its path without the extension (as models often do) and only that note exists.
fn note_path(root: &Path, named: &str) -> String {
    let path = named.replace('\\', "/");
    if path.to_lowercase().ends_with(".md") || root.join(&path).is_file() {
        return path;
    }
    let with_extension = format!("{path}.md");
    if root.join(&with_extension).is_file() {
        with_extension
    } else {
        path
    }
}

fn prepare(root: &Path, scope: &WriteScope, op: &ProposalOp) -> Result<Edit, &'static str> {
    let mut path = note_path(root, op.path());
    if matches!(op, ProposalOp::New { .. }) && !path.to_lowercase().ends_with(".md") {
        path.push_str(".md");
    }
    if !scope.allows(&path) {
        return Err("outsideWriteScope");
    }
    match op {
        ProposalOp::New { content, .. } => Edit::prepare(root, &path, None, EditKind::New, content),
        ProposalOp::Append { content, .. } => Edit::prepare(
            root,
            &path,
            None,
            EditKind::Append,
            &as_paragraph(root, &path, content),
        ),
        ProposalOp::Replace {
            old_text,
            new_text,
            replace_all,
            ..
        } => Edit::prepare_replace(root, &path, None, old_text, new_text, *replace_all)
            .map(|(edit, _)| edit),
        // Property changes go through the property engine, not a text edit.
        _ => Err("invalidArguments"),
    }
}

/// Appended text begins a new paragraph: a bare line break after a quote, list or table would
/// continue it instead. A note that already ends with a blank line, or is empty, gets nothing extra.
/// Two exceptions keep the note as it was written: list items appended to a note that ends with a
/// list of the same kind continue that list, and a note that ended with a line break still does.
fn as_paragraph(root: &Path, relative: &str, content: &str) -> String {
    let current = crate::index::read_only::visible_note(root, relative)
        .ok()
        .and_then(|file| std::fs::read_to_string(file).ok());
    let Some(text) = current.filter(|text| !text.is_empty()) else {
        return content.to_owned();
    };
    if content.is_empty() {
        return content.to_owned();
    }
    // `Edit` itself ends an unterminated last line and writes the note's own line endings, so
    // only the extra blank line is added here.
    let blank = !content.starts_with('\n')
        && !continues_list(&text, content)
        && !text.ends_with("\n\n")
        && !text.ends_with("\r\n\r\n");
    let after = text.ends_with('\n') && !content.ends_with('\n');
    format!(
        "{}{content}{}",
        if blank { "\n" } else { "" },
        if after { "\n" } else { "" }
    )
}

/// The list marker of a Markdown list line (`-`, `*`, `+`, or a number with `.` or `)`), or
/// `None` for any other line; task boxes count as the same list.
fn list_marker(line: &str) -> Option<char> {
    let line = line.trim_start();
    let mut chars = line.chars();
    let first = chars.next()?;
    if matches!(first, '-' | '*' | '+') {
        return chars.next().filter(|c| *c == ' ').map(|_| first);
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    let rest = &line[digits..];
    (digits > 0 && (rest.starts_with(". ") || rest.starts_with(") "))).then_some('1')
}

/// Whether appended `content` is more items of the list the note ends with.
fn continues_list(text: &str, content: &str) -> bool {
    let last = text.lines().rev().find(|line| !line.trim().is_empty());
    let first = content.lines().find(|line| !line.trim().is_empty());
    match (last.and_then(list_marker), first.and_then(list_marker)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// Checks a change and describes it; the vault is not touched.
///
/// A property change reads the note's properties through `conn` (the vault's index connection).
pub fn propose(
    root: &Path,
    scope: &WriteScope,
    conn: Option<&Connection>,
    mut op: ProposalOp,
) -> Result<Proposal, &'static str> {
    // The change itself carries the found note's path, so applying it later finds the note too.
    if let Some(path) = op.existing_note_path() {
        *path = note_path(root, path);
    }
    if matches!(
        op,
        ProposalOp::CreateDatabaseRow { .. } | ProposalOp::SetDatabaseValue { .. }
    ) {
        return propose_database(root, scope, op);
    }
    if op.is_structural() {
        return propose_structural(root, scope, op);
    }
    if op.is_engine_change() {
        return propose_property(root, scope, conn.ok_or("unavailable")?, op);
    }
    let edit = prepare(root, scope, &op)?;
    if !edit.changed() {
        return Err("noChange");
    }
    let before = edit.before().unwrap_or("");
    let old_name = if edit.before().is_some() {
        edit.path()
    } else {
        "/dev/null"
    };
    let mut diff = TextDiff::from_lines(before, edit.after())
        .unified_diff()
        .header(old_name, edit.path())
        .to_string();
    let cut = diff.char_indices().nth(DIFF_LIMIT).map(|(index, _)| index);
    if let Some(cut) = cut {
        diff.truncate(cut);
    }
    Ok(Proposal {
        id: ulid::Ulid::generate().to_string(),
        path: edit.path().to_owned(),
        base: edit.before().map(digest),
        op,
        diff,
        diff_truncated: cut.is_some(),
        affected: Vec::new(),
        affected_truncated: false,
    })
}

/// The text of a visible note, for a property proposal.
fn note_text(root: &Path, relative: &str) -> Result<String, &'static str> {
    let file = crate::index::read_only::visible_note(root, relative)?;
    std::fs::read_to_string(file).map_err(|_| "unavailable")
}

fn same_name(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// How a property's value reads in a diff line.
fn shown(property: &Value) -> String {
    let items: Vec<&str> = property["items"]
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if items.is_empty() {
        property["value"].as_str().unwrap_or_default().to_owned()
    } else {
        format!("[{}]", items.join(", "))
    }
}

fn shown_input(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|item| item
                    .as_str()
                    .map_or_else(|| item.to_string(), str::to_owned))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        other => other.to_string(),
    }
}

fn propose_property(
    root: &Path,
    scope: &WriteScope,
    conn: &Connection,
    op: ProposalOp,
) -> Result<Proposal, &'static str> {
    let path = note_path(root, op.path());
    if !scope.allows(&path) {
        return Err("outsideWriteScope");
    }
    let text = note_text(root, &path)?;
    let listing = properties::read(conn, root, &path)?;
    let existing = |name: &str| {
        listing["properties"].as_array().and_then(|all| {
            all.iter()
                .find(|p| p["name"].as_str().is_some_and(|n| same_name(n, name)))
        })
    };
    let (removed, added): (Option<String>, Option<String>) = match &op {
        ProposalOp::SetProperty {
            name,
            value,
            property_type,
            ..
        } => {
            let old = existing(name);
            let new = shown_input(value);
            if old.is_some_and(|p| shown(p) == new && property_type.is_none()) {
                return Err("noChange");
            }
            (
                old.map(|p| format!("{}: {}", name, shown(p))),
                Some(format!("{name}: {new}")),
            )
        }
        ProposalOp::DeleteProperty { name, .. } => {
            let old = existing(name).ok_or("notFound")?;
            (Some(format!("{name}: {}", shown(old))), None)
        }
        ProposalOp::RenameProperty { name, new_name, .. } => {
            let old = existing(name).ok_or("notFound")?;
            if same_name(name, new_name) {
                return Err("noChange");
            }
            (
                Some(format!("{name}: {}", shown(old))),
                Some(format!("{new_name}: {}", shown(old))),
            )
        }
        _ => return Err("invalidArguments"),
    };
    let mut diff = format!("--- {path}\n+++ {path}\n@@ properties @@\n");
    if let Some(line) = removed {
        diff.push_str(&format!("-{line}\n"));
    }
    if let Some(line) = added {
        diff.push_str(&format!("+{line}\n"));
    }
    Ok(Proposal {
        id: ulid::Ulid::generate().to_string(),
        path,
        base: Some(digest(&text)),
        op,
        diff,
        diff_truncated: false,
        affected: Vec::new(),
        affected_truncated: false,
    })
}

fn propose_database(
    root: &Path,
    scope: &WriteScope,
    mut op: ProposalOp,
) -> Result<Proposal, &'static str> {
    use crate::vault_tools::database;
    let (path, base, diff) = match &mut op {
        ProposalOp::CreateDatabaseRow { database_id, title } => {
            let title = title.trim().to_owned();
            if title.is_empty() || title.len() > 1024 {
                return Err("invalidArguments");
            }
            let path = format!("{}/{title}.md", database::container(root, database_id)?);
            if !scope.allows(&path) {
                return Err("outsideWriteScope");
            }
            let diff = format!("--- /dev/null\n+++ {path}\n@@ database row @@\n+{title}\n");
            (path, None, diff)
        }
        ProposalOp::SetDatabaseValue {
            database_id,
            note_id,
            property_id,
            value,
            expected_revision,
            operation_id,
        } => {
            let path = database::row_path(root, root, database_id, note_id)?;
            if !scope.allows(&path) {
                return Err("outsideWriteScope");
            }
            let file = crate::index::read_only::visible_note(root, &path)?;
            let bytes = std::fs::read(file).map_err(|_| "unavailable")?;
            *expected_revision = crate::database::format::raw_revision(&bytes);
            *operation_id = ulid::Ulid::generate().to_string();
            let name = database::read(root, database_id)?["properties"]
                .as_array()
                .and_then(|all| all.iter().find(|p| p["id"] == *property_id))
                .and_then(|p| p["name"].as_str().map(str::to_owned))
                .unwrap_or_else(|| property_id.clone());
            let shown = cell_text(value);
            let diff = format!("--- {path}\n+++ {path}\n@@ database cell @@\n+{name}: {shown}\n");
            (path, Some(digest(&String::from_utf8_lossy(&bytes))), diff)
        }
        _ => return Err("invalidArguments"),
    };
    Ok(Proposal {
        id: ulid::Ulid::generate().to_string(),
        path,
        base,
        op,
        diff,
        diff_truncated: false,
        affected: Vec::new(),
        affected_truncated: false,
    })
}

/// A cell value as the user reads it: the text, number, date or option names inside the typed
/// value object, not its JSON.
fn cell_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(cell_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(", "),
        Value::Object(fields) => ["value", "name", "title", "start"]
            .iter()
            .find_map(|key| fields.get(*key))
            .map(cell_text)
            .unwrap_or_else(|| value.to_string()),
        other => other.to_string(),
    }
}

fn apply_new_row(
    root: &Path,
    scope: &WriteScope,
    proposal: &Proposal,
    database_id: &str,
    mutation: &Mutation,
    run: &dyn Fn(&Mutation) -> Result<Value, &'static str>,
) -> Result<Applied, &'static str> {
    if !scope.allows(&proposal.path) {
        return Err("outsideWriteScope");
    }
    let output = run(mutation)?;
    let path = output["path"].as_str().ok_or("unavailable")?.to_owned();
    let note_id = output["noteId"].as_str().ok_or("unavailable")?.to_owned();
    Ok(Applied {
        after: digest(&note_text(root, &path)?),
        path,
        snapshot_id: None,
        created: true,
        row: Some(RowRef {
            database_id: database_id.to_owned(),
            note_id,
        }),
        inverse: None,
        removed: false,
        affected: Vec::new(),
    })
}

/// Writes a proposal if the note is still as it was proposed. A note that changed, appeared
/// or vanished since makes the proposal `outdated`; nothing is written then.
pub fn apply(
    root: &Path,
    scope: &WriteScope,
    proposal: &Proposal,
) -> Result<Applied, &'static str> {
    apply_with(root, scope, proposal, &|mutation| {
        crate::vault_tools::execute_offline(root, "", mutation)
    })
}

/// Like [`apply`]; `run` carries out a property change. The desktop passes its own, which goes
/// through the mutation gate and the open vault's index. It runs on this thread.
pub fn apply_with(
    root: &Path,
    scope: &WriteScope,
    proposal: &Proposal,
    run: &dyn Fn(&Mutation) -> Result<Value, &'static str>,
) -> Result<Applied, &'static str> {
    apply_deleting(
        root,
        scope,
        proposal,
        crate::recycle_bin::DeleteMode::System,
        run,
    )
}

/// Like [`apply_with`]; `mode` is the user's deletion setting, which a deletion follows.
pub fn apply_deleting(
    root: &Path,
    scope: &WriteScope,
    proposal: &Proposal,
    mode: crate::recycle_bin::DeleteMode,
    run: &dyn Fn(&Mutation) -> Result<Value, &'static str>,
) -> Result<Applied, &'static str> {
    if proposal.op.is_structural() {
        return apply_structural(root, scope, proposal, mode, run);
    }
    if let Some(mutation) = proposal.op.engine_mutation() {
        return match &proposal.op {
            ProposalOp::CreateDatabaseRow { database_id, .. } => {
                apply_new_row(root, scope, proposal, database_id, &mutation, run)
            }
            _ => apply_property(root, scope, proposal, &mutation, run),
        };
    }
    let edit = match prepare(root, scope, &proposal.op) {
        Err("alreadyExists" | "notFound" | "textNotFound" | "textNotUnique") => {
            return Err("outdated")
        }
        other => other?,
    };
    if edit.before().map(digest) != proposal.base {
        return Err("outdated");
    }
    // `commit` compares the note with `before` again under the write lock.
    let snapshot_id = match edit.commit(root, None, true) {
        Err("revisionConflict" | "alreadyExists") => return Err("outdated"),
        other => other?,
    };
    Ok(Applied {
        path: edit.path().to_owned(),
        created: edit.before().is_none(),
        row: None,
        inverse: None,
        removed: false,
        affected: Vec::new(),
        snapshot_id,
        after: digest(edit.after()),
    })
}

fn apply_property(
    root: &Path,
    scope: &WriteScope,
    proposal: &Proposal,
    mutation: &Mutation,
    run: &dyn Fn(&Mutation) -> Result<Value, &'static str>,
) -> Result<Applied, &'static str> {
    if !scope.allows(&proposal.path) {
        return Err("outsideWriteScope");
    }
    let file = crate::index::read_only::visible_note(root, &proposal.path)?;
    let before = note_text(root, &proposal.path)?;
    if Some(digest(&before)) != proposal.base {
        return Err("outdated");
    }
    let known: Vec<String> = crate::history::list_snapshots(root, &file)
        .map_err(|_| "historyFailed")?
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    {
        let _versions = crate::history::AiPropertyEdit::enter();
        run(mutation)?;
    }
    let after = note_text(root, &proposal.path)?;
    // The engine may keep more than one version (a type change and then the value); the oldest
    // new one holds the note as it was proposed.
    let snapshot_id = crate::history::list_snapshots(root, &file)
        .map_err(|_| "historyFailed")?
        .into_iter()
        .rfind(|entry| !known.contains(&entry.id) && entry.reason == crate::history::AI_EDIT_REASON)
        .map(|entry| entry.id);
    Ok(Applied {
        path: proposal.path.clone(),
        created: false,
        row: None,
        inverse: None,
        removed: false,
        affected: Vec::new(),
        snapshot_id,
        after: digest(&after),
    })
}

/// The engine request that takes a structural change back; `None` for a deletion, which the
/// desktop takes out of the trash by its ID.
pub fn inverse_mutation(inverse: &Inverse) -> Option<Mutation> {
    inverse.mutation()
}

/// How to take an applied change back, if the note is exactly as the apply left it.
pub fn undo_plan(root: &Path, applied: &Applied) -> Result<UndoPlan, &'static str> {
    if applied.removed {
        return Err("undoUnavailable");
    }
    if let Some(inverse) = &applied.inverse {
        return undo_structural_plan(root, applied, inverse);
    }
    let file = crate::index::read_only::visible_note(root, &applied.path)?;
    let current = std::fs::read_to_string(file).map_err(|_| "unavailable")?;
    if digest(&current) != applied.after {
        return Err("changedSince");
    }
    if let Some(row) = &applied.row {
        return Ok(UndoPlan::DeleteRow {
            database_id: row.database_id.clone(),
            note_id: row.note_id.clone(),
        });
    }
    match (&applied.snapshot_id, applied.created) {
        (Some(id), _) => Ok(UndoPlan::Restore {
            snapshot_id: id.clone(),
        }),
        (None, true) => Ok(UndoPlan::Trash {
            path: applied.path.clone(),
        }),
        // Nothing to go back to: never guess by removing the note.
        (None, false) => Err("undoUnavailable"),
    }
}

/// Undoes a change that had a version: the current text becomes a version first, so the undo
/// can itself be undone. A new note has no version; the desktop moves it to the trash.
pub fn undo(root: &Path, scope: &WriteScope, applied: &Applied) -> Result<(), &'static str> {
    if !scope.allows(&applied.path) {
        return Err("outsideWriteScope");
    }
    match undo_plan(root, applied)? {
        UndoPlan::Restore { snapshot_id } => {
            crate::note_versions::restore(root, root, &snapshot_id, false).map(|_| ())
        }
        UndoPlan::Structural(inverse) => match inverse.mutation() {
            Some(mutation) => crate::vault_tools::execute_offline(root, "", &mutation).map(|_| ()),
            None => Err("undoUnavailable"),
        },
        UndoPlan::Trash { .. } | UndoPlan::DeleteRow { .. } => Err("trashRequired"),
    }
}

/// The most files a structural change may cover; more is refused as too large.
const WALK_LIMIT: usize = 2_000;
/// The most files the card lists.
const LISTED: usize = 200;
const WHOLE_FILE: u64 = 4 * 1024 * 1024;

fn relative_of(root: &Path, path: &Path) -> Option<String> {
    Some(
        path.strip_prefix(root)
            .ok()?
            .to_string_lossy()
            .replace('\\', "/"),
    )
}

/// The item at `relative` and everything inside it, vault-relative, parents first.
fn walk(root: &Path, relative: &str, out: &mut Vec<String>) -> Result<(), &'static str> {
    out.push(relative.to_owned());
    let path = root.join(relative);
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        return Ok(());
    };
    if !meta.is_dir() {
        return Ok(());
    }
    let mut children: Vec<_> = std::fs::read_dir(&path)
        .map_err(|_| "unavailable")?
        .flatten()
        .filter_map(|entry| relative_of(root, &entry.path()))
        .collect();
    children.sort();
    for child in children {
        if out.len() >= WALK_LIMIT {
            return Err("operationTooLarge");
        }
        walk(root, &child, out)?;
    }
    Ok(())
}

/// A fingerprint of the items at `paths` and what is inside them: names, kinds and contents. A
/// path that does not exist counts too, so a destination that appears changes it.
fn stamp(root: &Path, paths: &[String]) -> Result<String, &'static str> {
    let mut all = Vec::new();
    for path in paths {
        walk(root, path, &mut all)?;
    }
    all.sort();
    all.dedup();
    let mut text = String::new();
    for path in &all {
        let state = match std::fs::symlink_metadata(root.join(path)) {
            Err(_) => "missing".to_owned(),
            Ok(meta) if meta.is_dir() => "dir".to_owned(),
            Ok(meta) if meta.len() <= WHOLE_FILE => std::fs::read(root.join(path))
                .map(|bytes| digest(&String::from_utf8_lossy(&bytes)) + &bytes.len().to_string())
                .map_err(|_| "unavailable")?,
            Ok(meta) => format!("large:{}", meta.len()),
        };
        text.push_str(&format!("{path}\t{state}\n"));
    }
    Ok(digest(&text))
}

struct StructuralPreview {
    mutation: Mutation,
    word: &'static str,
    source: String,
    destination: String,
    roots: Vec<String>,
    affected: Vec<String>,
    truncated: bool,
    stamp: String,
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// What the engine says a structural change would do, within the scope. Nothing is written.
fn preview_structural(
    root: &Path,
    scope: &WriteScope,
    op: &ProposalOp,
) -> Result<StructuralPreview, &'static str> {
    let (mutation, word) = op.structural_mutation().ok_or("invalidArguments")?;
    let path = op.path().replace('\\', "/");
    if !scope.allows(&path) {
        return Err("outsideWriteScope");
    }
    // The engine reports an unchanged move or rename as a conflict; say what it is.
    let current = Path::new(&path);
    let same_folder = |folder: &str| {
        let parent = current
            .parent()
            .map(|parent| parent.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let folder = folder.trim_matches('/');
        parent == if folder == "." { "" } else { folder }
    };
    match op {
        ProposalOp::Move { folder, .. } if same_folder(folder) => return Err("noChange"),
        ProposalOp::Rename { name, .. } => {
            let own = if root.join(&path).is_file() {
                current.file_stem()
            } else {
                current.file_name()
            };
            if own.and_then(|own| own.to_str()) == Some(name.trim()) {
                return Err("noChange");
            }
        }
        _ => {}
    }
    let output = crate::vault_tools::preview(root, "", &mutation)?;
    let text = |key: &str| output[key].as_str().map(str::to_owned);
    let (source, destination, mut roots) = if word == "delete" {
        let source = text("path").ok_or("unavailable")?;
        (source.clone(), String::new(), vec![source])
    } else {
        let source = text("source").ok_or("unavailable")?;
        let destination = text("destination").ok_or("unavailable")?;
        let mut roots = vec![source.clone()];
        roots.extend(strings(&output["rewrittenPaths"]));
        // An archived item goes to the archive, not to a vault path.
        if word != "archive" {
            roots.push(destination.clone());
        }
        (source, destination, roots)
    };
    if word != "archive" && word != "delete" && source == destination && roots.len() == 2 {
        return Err("noChange");
    }
    // Every place the change reaches, links included, must be in the scope.
    if roots.iter().any(|item| !scope.allows(item)) {
        return Err("outsideWriteScope");
    }
    roots.sort();
    roots.dedup();
    let mut all = Vec::new();
    for item in &roots {
        walk(root, item, &mut all)?;
    }
    all.dedup();
    let truncated = all.len() > LISTED;
    let mut affected = all.clone();
    affected.truncate(LISTED);
    Ok(StructuralPreview {
        stamp: stamp(root, &roots)?,
        mutation,
        word,
        source,
        destination,
        roots,
        affected,
        truncated,
    })
}

fn propose_structural(
    root: &Path,
    scope: &WriteScope,
    op: ProposalOp,
) -> Result<Proposal, &'static str> {
    let preview = preview_structural(root, scope, &op)?;
    let mut diff = format!(
        "--- {}\n+++ {}\n@@ {} @@\n",
        preview.source,
        {
            if preview.word == "move" || preview.word == "rename" {
                &preview.destination
            } else {
                &preview.source
            }
        },
        preview.word
    );
    diff.push_str(&format!("-{}\n", preview.source));
    if preview.word == "move" || preview.word == "rename" {
        diff.push_str(&format!("+{}\n", preview.destination));
    }
    Ok(Proposal {
        id: ulid::Ulid::generate().to_string(),
        path: preview.source,
        base: Some(preview.stamp),
        op,
        diff,
        diff_truncated: false,
        affected: preview.affected,
        affected_truncated: preview.truncated,
    })
}

fn apply_structural(
    root: &Path,
    scope: &WriteScope,
    proposal: &Proposal,
    mode: crate::recycle_bin::DeleteMode,
    run: &dyn Fn(&Mutation) -> Result<Value, &'static str>,
) -> Result<Applied, &'static str> {
    // The same preview again: any affected file that changed, or any note that would now be
    // rewritten and was not before, makes the proposal outdated.
    let fresh = match preview_structural(root, scope, &proposal.op) {
        Err("notFound" | "mutationConflict" | "noChange" | "alreadyExists") => {
            return Err("outdated")
        }
        other => other?,
    };
    if Some(&fresh.stamp) != proposal.base.as_ref() {
        return Err("outdated");
    }
    let source_is_file = root.join(&fresh.source).is_file();
    // A deletion follows the user's deletion setting: the system trash (no way back from here),
    // or the archive, which can be undone. It is never permanent.
    let archive_instead = fresh.word == "delete" && mode == crate::recycle_bin::DeleteMode::Archive;
    let word = if archive_instead {
        "archive"
    } else {
        fresh.word
    };
    let mutation = if archive_instead {
        Mutation::Archive {
            path: fresh.source.clone(),
        }
    } else {
        fresh.mutation
    };
    let output = run(&mutation)?;
    let affected = proposal.affected.clone();
    let (inverse, current) = match word {
        "move" => {
            let parent = Path::new(&fresh.source)
                .parent()
                .map(|parent| parent.to_string_lossy().replace('\\', "/"))
                .filter(|parent| !parent.is_empty())
                .unwrap_or_else(|| ".".into());
            (
                Some(Inverse::Move {
                    path: fresh.destination.clone(),
                    folder: parent,
                }),
                Some(fresh.destination.clone()),
            )
        }
        "rename" => {
            let old = Path::new(&fresh.source);
            let name = if source_is_file {
                old.file_stem()
            } else {
                old.file_name()
            }
            .and_then(|name| name.to_str())
            .ok_or("unavailable")?
            .to_owned();
            (
                Some(Inverse::Rename {
                    path: fresh.destination.clone(),
                    name,
                }),
                Some(fresh.destination.clone()),
            )
        }
        "archive" => {
            let id = output["destination"]
                .as_str()
                .ok_or("unavailable")?
                .to_owned();
            let inverse = Inverse::Restore { path: id };
            let current = inverse.current();
            (Some(inverse), current)
        }
        // A deletion with the system trash has no way back from here.
        _ => (None, None),
    };
    let after = match &current {
        Some(path) => stamp(root, std::slice::from_ref(path))?,
        None => String::new(),
    };
    let _ = &fresh.roots;
    Ok(Applied {
        path: fresh.source,
        snapshot_id: None,
        after,
        created: false,
        row: None,
        inverse,
        removed: word == "delete",
        affected,
    })
}

fn undo_structural_plan(
    root: &Path,
    applied: &Applied,
    inverse: &Inverse,
) -> Result<UndoPlan, &'static str> {
    if let Some(path) = inverse.current() {
        if !root.join(&path).exists() || stamp(root, &[path])? != applied.after {
            return Err("changedSince");
        }
    }
    Ok(UndoPlan::Structural(inverse.clone()))
}
