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
    fn path(&self) -> &str {
        match self {
            Self::New { path, .. }
            | Self::Append { path, .. }
            | Self::Replace { path, .. }
            | Self::SetProperty { path, .. }
            | Self::DeleteProperty { path, .. }
            | Self::RenameProperty { path, .. } => path,
            Self::CreateDatabaseRow { title, .. } => title,
            Self::SetDatabaseValue { note_id, .. } => note_id,
        }
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
}

fn digest(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

const DIFF_LIMIT: usize = 20_000;

fn prepare(root: &Path, scope: &WriteScope, op: &ProposalOp) -> Result<Edit, &'static str> {
    let mut path = op.path().replace('\\', "/");
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
fn as_paragraph(root: &Path, relative: &str, content: &str) -> String {
    let current = crate::index::read_only::visible_note(root, relative)
        .ok()
        .and_then(|file| std::fs::read_to_string(file).ok());
    match current {
        Some(text)
            if !text.is_empty()
                && !content.is_empty()
                && !content.starts_with('\n')
                && !text.ends_with("\n\n")
                && !text.ends_with("\r\n\r\n") =>
        {
            format!("\n{content}")
        }
        _ => content.to_owned(),
    }
}

/// Checks a change and describes it; the vault is not touched.
///
/// A property change reads the note's properties through `conn` (the vault's index connection).
pub fn propose(
    root: &Path,
    scope: &WriteScope,
    conn: Option<&Connection>,
    op: ProposalOp,
) -> Result<Proposal, &'static str> {
    if matches!(
        op,
        ProposalOp::CreateDatabaseRow { .. } | ProposalOp::SetDatabaseValue { .. }
    ) {
        return propose_database(root, scope, op);
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
    let path = op.path().replace('\\', "/");
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
            let shown = if value.is_null() {
                String::new()
            } else {
                value.to_string()
            };
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
    })
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
        snapshot_id,
        after: digest(&after),
    })
}

/// How to take an applied change back, if the note is exactly as the apply left it.
pub fn undo_plan(root: &Path, applied: &Applied) -> Result<UndoPlan, &'static str> {
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
        UndoPlan::Trash { .. } | UndoPlan::DeleteRow { .. } => Err("trashRequired"),
    }
}
