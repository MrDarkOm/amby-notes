//! Shadow check of the point update (development builds only).
//!
//! After a tree patch or a refresh by path, a background thread reads the vault again from
//! nothing, into memory and without writing a byte to the vault, and compares what it finds with
//! the tree the patches have built (a mirror kept here) and with the live index. A difference is
//! reported as the log event `tree_patch.shadow_mismatch` (counts only: the structured log keeps
//! no free text) and as lines in `shadow-mismatch.log` beside the debug log (paths, ids and
//! titles, never note text).
//!
//! The check never takes the mutation gate or the index connection: it opens the index file
//! read-only. It runs one at a time and only for the latest update (a burst is one check). A
//! difference is reported only if it is still there after a short wait and no update came
//! meanwhile.
//!
//! Limits: the renderer's own copy of the tree (`tree-patch.ts`) is not seen from here, so the
//! patch is checked through a Rust copy of its rules. A vault with a note that has no `amby-id`
//! yet, or with notes stored under conflict keys, is skipped: a read-only full load cannot give
//! the same answer there. In a release build every entry point is empty.

use crate::vault::tree::TreeItem;
use crate::vault::tree_patch::TreePatch;
use std::path::Path;

#[cfg(debug_assertions)]
mod enabled {
    use super::*;
    use crate::vault::tree_patch::TreePatchOp;
    use rusqlite::{Connection, OpenFlags};
    use std::collections::{BTreeSet, HashMap};
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::Duration;

    const DEBOUNCE: Duration = Duration::from_millis(800);
    const RECHECK: Duration = Duration::from_millis(700);
    const MAX_LINES: usize = 20;

    #[derive(Default)]
    struct State {
        report: Option<PathBuf>,
        root: Option<PathBuf>,
        generation: u64,
        mirror: Option<Vec<TreeItem>>,
        action: String,
        touched: usize,
        /// Bumped by every update; a check that sees it change has been overtaken.
        seq: u64,
        running: bool,
    }

    static STATE: Mutex<State> = Mutex::new(State {
        report: None,
        root: None,
        generation: 0,
        mirror: None,
        action: String::new(),
        touched: 0,
        seq: 0,
        running: false,
    });

    /// Turn the check on; `report` is the file the differences are written to.
    pub fn enable(report: PathBuf) {
        if std::env::var("AMBY_SHADOW_CHECK").is_ok_and(|value| value == "0") {
            return;
        }
        if let Ok(mut state) = STATE.lock() {
            state.report = Some(report);
        }
    }

    pub fn note_full_tree(root: &Path, generation: u64, tree: &[TreeItem]) {
        let Ok(mut state) = STATE.lock() else { return };
        if state.report.is_none() {
            return;
        }
        state.root = Some(root.to_path_buf());
        state.generation = generation;
        state.mirror = Some(tree.to_vec());
        state.seq += 1;
    }

    pub fn note_patch(
        root: &Path,
        generation: u64,
        action: &str,
        touched: usize,
        patch: &TreePatch,
    ) {
        let Ok(mut state) = STATE.lock() else { return };
        if state.report.is_none() {
            return;
        }
        if state.generation != generation || state.root.as_deref() != Some(root) {
            // A mirror of another vault or generation says nothing about this one.
            state.mirror = None;
            return;
        }
        let Some(mirror) = state.mirror.as_mut() else {
            return;
        };
        if apply_patch(mirror, root, patch).is_err() {
            state.mirror = None;
            return;
        }
        state.action = action.to_string();
        state.touched = touched;
        state.seq += 1;
        if !state.running {
            state.running = true;
            std::thread::spawn(worker);
        }
    }

    fn worker() {
        loop {
            std::thread::sleep(DEBOUNCE);
            let Some((root, mirror, seq, action, touched, report)) = snapshot() else {
                return;
            };
            let outcome = check_once(&root, &mirror, &action, touched, seq, &report);
            if matches!(outcome, Checked::Overtaken) {
                continue;
            }
            let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
            if state.seq == seq {
                state.running = false;
                return;
            }
        }
    }

    fn snapshot() -> Option<(PathBuf, Vec<TreeItem>, u64, String, usize, PathBuf)> {
        let mut state = STATE.lock().ok()?;
        let (Some(root), Some(mirror), Some(report)) = (
            state.root.clone(),
            state.mirror.clone(),
            state.report.clone(),
        ) else {
            state.running = false;
            return None;
        };
        Some((
            root,
            mirror,
            state.seq,
            state.action.clone(),
            state.touched,
            report,
        ))
    }

    enum Checked {
        Done,
        Overtaken,
    }

    fn current_seq() -> u64 {
        STATE.lock().map(|state| state.seq).unwrap_or(0)
    }

    fn check_once(
        root: &Path,
        mirror: &[TreeItem],
        action: &str,
        touched: usize,
        seq: u64,
        report: &Path,
    ) -> Checked {
        let Ok(first) = diff_against_full(root, mirror) else {
            return Checked::Done;
        };
        if first.is_empty() {
            tracing::debug!(event = "tree_patch.shadow_ok", count = touched as u64);
            return Checked::Done;
        }
        // The disk may have moved while we read it: look again before saying anything.
        std::thread::sleep(RECHECK);
        if current_seq() != seq {
            return Checked::Overtaken;
        }
        let Ok(second) = diff_against_full(root, mirror) else {
            return Checked::Done;
        };
        if second.is_empty() || current_seq() != seq {
            return Checked::Done;
        }
        tracing::warn!(
            event = "tree_patch.shadow_mismatch",
            count = second.len() as u64,
            files = touched as u64
        );
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(report)
        {
            let _ = writeln!(
                file,
                "== tree_patch.shadow_mismatch action={action} touched={touched} vault={}",
                root.display()
            );
            for line in &second {
                let _ = writeln!(file, "{line}");
            }
        }
        Checked::Done
    }

    // ── comparison ─────────────────────────────────────────────────────────────────────────

    /// The ways the mirror tree and the live index differ from a full read of the disk, as short
    /// lines (empty: they agree). `Err` when the comparison cannot be made (see the module
    /// documentation).
    pub fn diff_against_full(root: &Path, mirror: &[TreeItem]) -> Result<Vec<String>, String> {
        let live = Connection::open_with_flags(
            crate::index::db_path(root),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|error| error.to_string())?;
        let live_rows = index_rows(&live)?;
        if live_rows.has_conflict_keys {
            return Err("notes stored under conflict keys".to_string());
        }
        let oracle = Connection::open_in_memory().map_err(|error| error.to_string())?;
        crate::index::init_schema(&oracle)?;
        let full = crate::index::load_vault_read_only(&oracle, root)?;
        let full_rows = index_rows(&oracle)?;

        let mut lines = Vec::new();
        let mut left = Vec::new();
        let mut right = Vec::new();
        outline(root, mirror, 0, &mut left);
        outline(root, &full.tree, 0, &mut right);
        push_diff(&mut lines, "tree", &left, &right);
        push_diff(&mut lines, "notes", &live_rows.notes, &full_rows.notes);
        push_diff(&mut lines, "tags", &live_rows.tags, &full_rows.tags);
        // A link target that more than one note answers to is resolved by whichever row the
        // lookup meets last; the two ways of resolving can disagree there by design.
        let ambiguous = &live_rows.ambiguous_keys;
        let keep = |rows: &[(String, String)]| {
            rows.iter()
                .filter(|(target, _)| !ambiguous.contains(target))
                .map(|(_, line)| line.clone())
                .collect::<Vec<_>>()
        };
        push_diff(
            &mut lines,
            "links",
            &keep(&live_rows.links),
            &keep(&full_rows.links),
        );
        push_diff(&mut lines, "search", &live_rows.search, &full_rows.search);
        Ok(lines)
    }

    struct IndexRows {
        notes: Vec<String>,
        tags: Vec<String>,
        /// (lower-case target, row)
        links: Vec<(String, String)>,
        search: Vec<String>,
        ambiguous_keys: BTreeSet<String>,
        has_conflict_keys: bool,
    }

    fn index_rows(conn: &Connection) -> Result<IndexRows, String> {
        let run = |sql: &str| -> Result<Vec<Vec<String>>, String> {
            let mut statement = conn.prepare(sql).map_err(|error| error.to_string())?;
            let columns = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    (0..columns)
                        .map(|index| {
                            row.get::<_, rusqlite::types::Value>(index)
                                .map(|value| match value {
                                    rusqlite::types::Value::Null => "-".to_string(),
                                    rusqlite::types::Value::Integer(v) => v.to_string(),
                                    rusqlite::types::Value::Real(v) => v.to_string(),
                                    rusqlite::types::Value::Text(v) => v,
                                    rusqlite::types::Value::Blob(_) => "<blob>".to_string(),
                                })
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            Ok(rows)
        };
        // Note text is never read: only its length, so a difference is visible without being copied.
        let note_rows =
            run("SELECT id, path, title, mtime_ns, size, word_count, length(content) FROM notes")?;
        let mut keys = HashMap::<String, usize>::new();
        let mut has_conflict_keys = false;
        for row in &note_rows {
            has_conflict_keys |= row[0].starts_with(crate::index::CONFLICT_PREFIX);
            let (path, title) = (&row[1], &row[2]);
            let name = path.rsplit('/').next().unwrap_or(path);
            let mut own = BTreeSet::new();
            own.insert(title.to_lowercase());
            own.insert(path.trim_end_matches(".md").to_lowercase());
            own.insert(name.trim_end_matches(".md").to_lowercase());
            for key in own {
                *keys.entry(key).or_default() += 1;
            }
        }
        let ambiguous_keys = keys
            .into_iter()
            .filter(|(_, count)| *count > 1)
            .map(|(key, _)| key)
            .collect();
        let sorted = |mut lines: Vec<String>| {
            lines.sort();
            lines
        };
        Ok(IndexRows {
            notes: sorted(note_rows.iter().map(|row| row.join(" | ")).collect()),
            tags: sorted(
                run("SELECT note_id, tag FROM tags")?
                    .iter()
                    .map(|row| row.join(" | "))
                    .collect(),
            ),
            links: {
                let mut links = run("SELECT note_id, target, target_note_id FROM links")?
                    .into_iter()
                    .map(|row| (row[1].to_lowercase(), row.join(" | ")))
                    .collect::<Vec<_>>();
                links.sort();
                links
            },
            // The search table answers for exactly the notes that have a row in it, by title.
            search: sorted(
                run("SELECT n.id, f.title FROM notes n JOIN notes_fts f ON f.rowid = n.rowid")?
                    .iter()
                    .map(|row| row.join(" | "))
                    .collect(),
            ),
            ambiguous_keys,
            has_conflict_keys,
        })
    }

    fn outline(root: &Path, items: &[TreeItem], depth: usize, out: &mut Vec<String>) {
        let prefix = root.to_string_lossy();
        for item in items {
            out.push(format!(
                "{}{} [{}] {} id={} created={:?} modified={:?}",
                "  ".repeat(depth),
                item.path.strip_prefix(&*prefix).unwrap_or(&item.path),
                item.item_type,
                item.icon,
                item.id.strip_prefix(&*prefix).unwrap_or(&item.id),
                item.created,
                item.modified
            ));
            if let Some(children) = &item.children {
                outline(root, children, depth + 1, out);
            }
        }
    }

    fn push_diff(lines: &mut Vec<String>, what: &str, point: &[String], full: &[String]) {
        if point == full {
            return;
        }
        let point_set: BTreeSet<&String> = point.iter().collect();
        let full_set: BTreeSet<&String> = full.iter().collect();
        for line in point.iter().filter(|line| !full_set.contains(line)) {
            lines.push(format!("{what}: only after the point update: {line}"));
        }
        for line in full.iter().filter(|line| !point_set.contains(line)) {
            lines.push(format!("{what}: only in the full read: {line}"));
        }
        if lines.len() > MAX_LINES {
            lines.truncate(MAX_LINES);
            lines.push("... (more differences cut)".to_string());
        }
    }

    // ── the rules the renderer applies a patch by (`tree-patch.ts`) ────────────────────────

    /// Apply `patch` to `tree` as the renderer does. `Err` when the patch does not fit (the
    /// renderer would reload the tree then).
    pub fn apply_patch(
        tree: &mut Vec<TreeItem>,
        vault: &Path,
        patch: &TreePatch,
    ) -> Result<(), String> {
        for op in &patch.ops {
            match op {
                TreePatchOp::Remove { parent_path, paths } => {
                    let siblings = children_of(tree, parent_path.as_deref(), vault)?;
                    siblings.retain(|item| !paths.contains(&item.path));
                }
                TreePatchOp::Upsert {
                    parent_path,
                    item,
                    replace_children,
                } => {
                    let siblings = children_of(tree, parent_path.as_deref(), vault)?;
                    let mut next = item.clone();
                    match siblings
                        .iter()
                        .position(|sibling| sibling.path == item.path)
                    {
                        Some(at) => {
                            let existing = siblings.remove(at);
                            if !*replace_children {
                                next.children = existing.children;
                            }
                        }
                        None if !*replace_children => {
                            return Err(format!("no item to refresh at {}", item.path))
                        }
                        None => {}
                    }
                    let key = sort_key(vault, &next);
                    let at = siblings
                        .iter()
                        .position(|sibling| sort_key(vault, sibling) > key)
                        .unwrap_or(siblings.len());
                    siblings.insert(at, next);
                }
            }
        }
        Ok(())
    }

    fn children_of<'a>(
        tree: &'a mut Vec<TreeItem>,
        parent: Option<&str>,
        vault: &Path,
    ) -> Result<&'a mut Vec<TreeItem>, String> {
        let Some(parent) = parent else {
            return Ok(tree);
        };
        fn find<'a>(items: &'a mut Vec<TreeItem>, path: &str) -> Option<&'a mut TreeItem> {
            for item in items {
                if item.path == path {
                    return Some(item);
                }
                if let Some(children) = item.children.as_mut() {
                    if let Some(found) = find(children, path) {
                        return Some(found);
                    }
                }
            }
            None
        }
        let _ = vault;
        find(tree, parent)
            .map(|item| item.children.get_or_insert_with(Vec::new))
            .ok_or_else(|| format!("patch parent {parent} is not in the tree"))
    }

    /// Folders, bundles and databases first, then files, each by lower-case name: derived from
    /// the item alone (a file named like its folder stands for that folder).
    fn sort_key(vault: &Path, item: &TreeItem) -> (u8, String) {
        let path = Path::new(&item.path);
        let parent = path.parent().unwrap_or(vault);
        let stem = path
            .file_stem()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let parent_name = parent
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let folder_like = item.item_type == "folder" || item.item_type == "database";
        let is_directory = folder_like || (parent != vault && stem == parent_name);
        let name = if is_directory && !folder_like {
            parent_name
        } else {
            path.file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default()
        };
        (u8::from(!is_directory), name.to_lowercase())
    }

    /// One check with the current update number, for tests.
    #[cfg(test)]
    pub(crate) fn check_once_for_tests(
        root: &Path,
        mirror: &[TreeItem],
        action: &str,
        touched: usize,
        report: &Path,
    ) {
        check_once(root, mirror, action, touched, current_seq(), report);
    }
}

#[cfg(debug_assertions)]
pub use enabled::{enable, note_full_tree, note_patch};

#[cfg(not(debug_assertions))]
pub fn note_full_tree(_root: &Path, _generation: u64, _tree: &[TreeItem]) {}
#[cfg(not(debug_assertions))]
pub fn note_patch(
    _root: &Path,
    _generation: u64,
    _action: &str,
    _touched: usize,
    _patch: &TreePatch,
) {
}

#[cfg(test)]
mod tests;
