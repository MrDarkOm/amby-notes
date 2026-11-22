//! The versions history keeps of a note, for the CLI and MCP: list them, read one, put one back.
//!
//! Reads cover every visible note. A restore stays inside the write scope, snapshots the current
//! text first (so the restore itself can be undone) and refuses while a structural operation is
//! unfinished. The desktop sees the restore as an ordinary external edit.

use std::path::Path;

use serde_json::{json, Value};

use crate::history;
use crate::index::read_only::visible_note;
use crate::vault::scan::normalize_rel_path;

/// The most versions one listing returns; the newest come first.
pub const MAX_VERSIONS: usize = 50;
/// The largest version text returned whole.
pub const MAX_VERSION_BYTES: usize = 256 * 1024;

fn valid_id(id: &str) -> Result<(), &'static str> {
    id.parse::<ulid::Ulid>()
        .map(|_| ())
        .map_err(|_| "invalidArguments")
}

pub fn list(root: &Path, relative: &str) -> Result<Value, &'static str> {
    let relative = relative.replace('\\', "/");
    let path = visible_note(root, &relative)?;
    let versions = history::list_snapshots(root, &path).map_err(|_| "historyFailed")?;
    let total = versions.len();
    let versions: Vec<Value> = versions
        .into_iter()
        .take(MAX_VERSIONS)
        .map(|entry| {
            json!({
                "id": entry.id,
                "createdAtMs": entry.created_at_ms,
                "reason": entry.reason,
                "sizeBytes": entry.size_bytes,
            })
        })
        .collect();
    Ok(json!({ "path": relative, "versions": versions, "total": total }))
}

pub fn read(root: &Path, id: &str) -> Result<Value, &'static str> {
    valid_id(id)?;
    let snapshot = history::read_snapshot_text(root, id).map_err(|_| "notFound")?;
    visible_note(root, &snapshot.source_path)?;
    if snapshot.content.len() > MAX_VERSION_BYTES {
        return Err("resultTooLarge");
    }
    Ok(json!({ "id": id, "path": snapshot.source_path, "content": snapshot.content }))
}

/// Put a version back as the note's text. `scope` is the canonical write folder.
pub fn restore(root: &Path, scope: &Path, id: &str, dry_run: bool) -> Result<Value, &'static str> {
    valid_id(id)?;
    let prepared = history::prepare_snapshot_restore(root, id).map_err(|_| "notFound")?;
    let relative = prepared
        .path
        .strip_prefix(root)
        .map(normalize_rel_path)
        .map_err(|_| "accessDenied")?;
    let current_path = visible_note(root, &relative)?;
    if current_path != prepared.path || !prepared.path.starts_with(scope) {
        return Err("accessDenied");
    }
    let current = std::fs::read(&prepared.path).map_err(|_| "notFound")?;
    let changed = current != prepared.bytes;
    let mut result = json!({
        "path": relative,
        "id": id,
        "changed": changed,
        "dryRun": dry_run,
        "sizeBytes": prepared.bytes.len(),
    });
    if dry_run || !changed {
        return Ok(result);
    }
    crate::structural::ensure_clean_for_text_edit(root)?;
    history::commit_snapshot_restore(root, prepared).map_err(|_| "unavailable")?;
    result["restored"] = json!(true);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::note_edit::{Edit, EditKind};
    use std::fs;

    fn vault() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("amby-versions-{}", ulid::Ulid::generate()));
        fs::create_dir_all(root.join("Inside")).unwrap();
        fs::create_dir_all(root.join("Outside")).unwrap();
        root.canonicalize().unwrap()
    }

    fn edit(root: &Path, note: &str, text: &str) -> String {
        Edit::prepare(root, note, None, EditKind::Write, text)
            .unwrap()
            .commit(root, None, true)
            .unwrap()
            .unwrap()
    }

    #[test]
    fn an_ai_edit_is_listed_read_and_undone_and_the_undo_is_itself_a_version() {
        let root = vault();
        fs::write(root.join("Inside/Note.md"), "first").unwrap();
        let id = edit(&root, "Inside/Note.md", "second");
        let listed = list(&root, "Inside/Note.md").unwrap();
        assert_eq!(listed["versions"][0]["id"], id);
        assert_eq!(listed["versions"][0]["reason"], history::AI_EDIT_REASON);
        assert_eq!(read(&root, &id).unwrap()["content"], "first");

        let scope = root.join("Inside");
        let preview = restore(&root, &scope, &id, true).unwrap();
        assert_eq!(preview["changed"], true);
        assert_eq!(
            fs::read_to_string(root.join("Inside/Note.md")).unwrap(),
            "second"
        );
        restore(&root, &scope, &id, false).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("Inside/Note.md")).unwrap(),
            "first"
        );
        let after = list(&root, "Inside/Note.md").unwrap();
        assert_eq!(after["total"], 2);
        assert_eq!(after["versions"][0]["reason"], history::RESTORE_REASON);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_restore_outside_the_write_scope_is_refused() {
        let root = vault();
        fs::write(root.join("Outside/Note.md"), "first").unwrap();
        let id = edit(&root, "Outside/Note.md", "second");
        assert_eq!(
            restore(&root, &root.join("Inside"), &id, false),
            Err("accessDenied")
        );
        assert_eq!(
            fs::read_to_string(root.join("Outside/Note.md")).unwrap(),
            "second"
        );
        assert_eq!(read(&root, "not-an-id"), Err("invalidArguments"));
        fs::remove_dir_all(root).unwrap();
    }
}
