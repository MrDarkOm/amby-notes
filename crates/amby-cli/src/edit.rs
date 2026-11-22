use std::fs;
use std::io::{self, Read};
use std::path::Path;

use amby_core::note_edit::{Edit, EditKind};
use serde::Serialize;
use similar::TextDiff;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    pub path: String,
    pub changed: bool,
    pub dry_run: bool,
    pub snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff_truncated: Option<bool>,
}

pub fn read_input(file: Option<&Path>) -> Result<String, &'static str> {
    let bytes = match file {
        Some(file) => fs::read(file),
        None => {
            let mut bytes = Vec::new();
            io::stdin().lock().read_to_end(&mut bytes).map(|_| bytes)
        }
    }
    .map_err(|_| "unavailable")?;
    String::from_utf8(bytes).map_err(|_| "invalidEncoding")
}

pub fn execute(
    root: &Path,
    scope: Option<&Path>,
    kind: EditKind,
    note: &str,
    content: &str,
    dry_run: bool,
    ai: bool,
) -> Result<EditResult, &'static str> {
    let edit = Edit::prepare(root, note, scope, kind, content)?;
    finish(&edit, root, scope, dry_run, ai)
}

/// Preview (a unified diff, bounded for AI) or publish a prepared edit.
pub fn finish(
    edit: &Edit,
    root: &Path,
    scope: Option<&Path>,
    dry_run: bool,
    ai: bool,
) -> Result<EditResult, &'static str> {
    let mut result = EditResult {
        path: edit.path().to_owned(),
        changed: edit.changed(),
        dry_run,
        snapshot_id: None,
        diff: None,
        diff_truncated: None,
    };
    if dry_run {
        let old_path = edit.before().map_or("/dev/null", |_| edit.path());
        let mut diff = TextDiff::from_lines(edit.before().unwrap_or(""), edit.after())
            .unified_diff()
            .header(old_path, edit.path())
            .to_string();
        if ai {
            // Keep tool output on the same scale as existing read operations.
            let limit = diff.char_indices().nth(20_000).map(|(i, _)| i);
            result.diff_truncated = Some(limit.is_some());
            if let Some(limit) = limit {
                diff.truncate(limit);
            }
        }
        result.diff = Some(diff);
    } else {
        result.snapshot_id = edit.commit(root, scope, ai)?;
    }
    Ok(result)
}
