//! Changes the AI panel proposes to notes (docs/road/ai-panel-tools.md, stage 2). A proposal is
//! checked and described without touching the vault; applying it re-checks that the note is
//! still as the model saw it, writes an `ai-edit` version first, and can be undone by the same
//! versions history.

use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::TextDiff;

use crate::note_edit::{Edit, EditKind};

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
}

impl ProposalOp {
    fn path(&self) -> &str {
        match self {
            Self::New { path, .. } | Self::Append { path, .. } | Self::Replace { path, .. } => path,
        }
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
}

#[derive(Debug, PartialEq)]
pub enum UndoPlan {
    Restore { snapshot_id: String },
    Trash { path: String },
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
        ProposalOp::Append { content, .. } => {
            Edit::prepare(root, &path, None, EditKind::Append, content)
        }
        ProposalOp::Replace {
            old_text,
            new_text,
            replace_all,
            ..
        } => Edit::prepare_replace(root, &path, None, old_text, new_text, *replace_all)
            .map(|(edit, _)| edit),
    }
}

/// Checks a change and describes it; the vault is not touched.
pub fn propose(root: &Path, scope: &WriteScope, op: ProposalOp) -> Result<Proposal, &'static str> {
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

/// Writes a proposal if the note is still as it was proposed. A note that changed, appeared
/// or vanished since makes the proposal `outdated`; nothing is written then.
pub fn apply(
    root: &Path,
    scope: &WriteScope,
    proposal: &Proposal,
) -> Result<Applied, &'static str> {
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
        snapshot_id,
        after: digest(edit.after()),
    })
}

/// How to take an applied change back, if the note is exactly as the apply left it.
pub fn undo_plan(root: &Path, applied: &Applied) -> Result<UndoPlan, &'static str> {
    let file = crate::index::read_only::visible_note(root, &applied.path)?;
    let current = std::fs::read_to_string(file).map_err(|_| "unavailable")?;
    if digest(&current) != applied.after {
        return Err("changedSince");
    }
    Ok(match &applied.snapshot_id {
        Some(id) => UndoPlan::Restore {
            snapshot_id: id.clone(),
        },
        None => UndoPlan::Trash {
            path: applied.path.clone(),
        },
    })
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
        UndoPlan::Trash { .. } => Err("trashRequired"),
    }
}
