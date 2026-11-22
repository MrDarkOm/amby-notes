//! "Point equals full": after one action, the index and the tree updated for that action alone
//! must be what a full `load_vault` of the same disk gives. Every scenario runs the real mutation
//! code (the `*_inner` functions behind the IPC commands, or the bundle plans plus
//! `sync_mutation_result`), applies the tree patch it returns to the tree loaded before, and
//! compares it, and the whole index, with a from-scratch load of the vault on a second database.

use crate::commands::database::database_note_context_inner;
use crate::commands::mutations::{
    archive_item_inner, create_layer_inner, create_note_inner, delete_item_inner, move_item_inner,
    rename_item_inner, sync_mutation_result,
};
use crate::database::runtime_state::DatabaseRuntimeState;
use crate::index;
use crate::model::{FsMutationResult, MutationOutcome};
use crate::recycle_bin::DeleteMode;
use crate::vault::tree::TreeItem;
use crate::vault::tree_patch::{TreePatch, TreePatchOp};
use crate::vault_context::VaultContext;
use crate::watcher::WatcherState;
use rusqlite::Connection;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use ulid::Ulid;

// ── fixture ────────────────────────────────────────────────────────────────────────────────

struct Vault(PathBuf);

impl Vault {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("amby-tree-patch-{}", Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.0.join(relative)
    }

    fn string(&self, relative: &str) -> String {
        self.path(relative).to_string_lossy().to_string()
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.path(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// A note with its own stable id.
    fn note(&self, relative: &str, body: &str) -> String {
        let id = Ulid::generate().to_string();
        self.write(relative, &format!("---\namby-id: {id}\n---\n{body}"));
        id
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn database_manifest(name: &str) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "format": "amby-database",
        "formatVersion": 1,
        "databaseId": Ulid::generate().to_string(),
        "name": name,
        "locked": false,
        "membership": {"kind": "filesystem-descendants", "recursive": true},
        "properties": [],
        "viewOrder": [],
        "defaultViewId": null,
        "templateOrder": [],
        "defaultTemplateId": null
    }))
    .unwrap()
}

/// Folders, bundles with layers, a database, a canvas and a sketch, a note with a broken header,
/// links in both directions and a sync conflict copy: everything the tree distinguishes.
fn fixture() -> Vault {
    let vault = Vault::new();
    vault.note("Projects/Alpha.md", "alpha token #one [[Beta]]");
    vault.note(
        "Projects/Beta.md",
        "beta token #two [[Alpha]] [Alpha](Projects/Alpha.md)",
    );
    // A link by path, so both a rename and a move rewrite this note.
    vault.note("Заметки/Гамма.md", "gamma [[Projects/Alpha]]");
    vault.note("Folder/Sub/Deep.md", "deep [[Beta]]");
    vault.note("Folder/Sub/Deeper/Deepest.md", "deepest");
    vault.note("Folder/Loose.md", "loose");
    vault.note("Bundle/Bundle.md", "bundle main [[Loose]]");
    vault.note("Bundle/Child.md", "bundle child");
    vault.write("Bundle/Bundle.canvas", "{}\n");
    vault.write("Bundle/Inner Folder/readme.txt", "not a note");
    vault.note(
        "Bundle/Inner Folder/Nested.md",
        "nested in a folder inside a bundle",
    );
    vault.write("Standalone.canvas", "{}\n");
    vault.write("Sketch.excalidraw", "{}\n");
    vault.write("Db/Db.json", &database_manifest("Db"));
    vault.note("Db/Row One.md", "row one");
    vault.note("Db/Row Two.md", "row two");
    vault.write(
        "Broken.md",
        "---\ntags: [broken\n---\nbroken searchable token",
    );
    let conflicted = vault.note("Projects/Conflicted.md", "conflicted original");
    vault.write(
        "Projects/Conflicted.0123456789ab-conflict.md",
        &format!("---\namby-id: {conflicted}\n---\nconflicted copy"),
    );
    vault.note("Root note.md", "root [[Alpha]] #one");
    vault
}

fn activate(root: &Path) -> VaultContext {
    let context = VaultContext::new();
    context
        .activate(root.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    context
}

fn loaded_tree(context: &VaultContext) -> Vec<TreeItem> {
    context
        .with_active(|active| active.refresh().map(|loaded| loaded.tree))
        .unwrap()
}

// ── comparison with a full load ────────────────────────────────────────────────────────────

/// Everything the index knows about the notes, without the columns that record when the row was
/// written (`created_at`, `updated_at`) or the SQLite row numbers.
#[derive(Debug, PartialEq, Eq)]
struct IndexDump {
    notes: Vec<String>,
    tags: Vec<String>,
    links: Vec<String>,
    search: BTreeMap<&'static str, Vec<String>>,
}

const SEARCH_TERMS: &[&str] = &[
    "token",
    "alpha",
    "beta",
    "gamma",
    "deep",
    "loose",
    "bundle",
    "row",
    "conflicted",
    "broken",
    "renamed",
    "created",
];

fn dump(conn: &Connection, root: &Path) -> IndexDump {
    let rows = |sql: &str| -> Vec<String> {
        let mut statement = conn.prepare(sql).unwrap();
        let columns = statement.column_count();
        let mut out = statement
            .query_map([], |row| {
                Ok((0..columns)
                    .map(|index| {
                        row.get::<_, rusqlite::types::Value>(index)
                            .map(|value| format!("{value:?}"))
                            .unwrap()
                    })
                    .collect::<Vec<_>>()
                    .join(" | "))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        out.sort();
        out
    };
    let mut search = BTreeMap::new();
    for term in SEARCH_TERMS {
        let mut found = index::search_notes(conn, root, term)
            .unwrap()
            .into_iter()
            .map(|hit| format!("{} {} {}", hit.note.id, hit.note.path, hit.match_type))
            .collect::<Vec<_>>();
        found.sort();
        search.insert(*term, found);
    }
    IndexDump {
        notes: rows(
            "SELECT id, path, title, mtime, mtime_ns, size, content, word_count FROM notes",
        ),
        tags: rows("SELECT note_id, tag FROM tags"),
        links: rows("SELECT note_id, raw, target, label, target_note_id FROM links"),
        search,
    }
}

/// The index and the tree of the same disk, built from nothing.
fn full_load(root: &Path) -> (IndexDump, Vec<TreeItem>) {
    let conn = Connection::open_in_memory().unwrap();
    index::init_schema(&conn).unwrap();
    let loaded = index::load_vault(&conn, root).unwrap();
    (dump(&conn, root), loaded.tree)
}

fn active_dump(context: &VaultContext, root: &Path) -> IndexDump {
    context
        .with_active(|active| Ok(dump(active, root)))
        .unwrap()
}

/// Reference implementation of the renderer's patch application (`applyTreePatch` in
/// `workspace-mutations.ts` does the same on the same rules), so a patch is checked as the tree it
/// produces. Sibling order is the one `build_tree` gives: folders, bundles and databases first, by
/// lower-case name; then files by lower-case name.
fn apply(tree: &mut Vec<TreeItem>, vault: &Path, patch: &TreePatch) {
    for op in &patch.ops {
        match op {
            TreePatchOp::Remove { parent_path, paths } => {
                let siblings = children_of(tree, parent_path.as_deref());
                siblings.retain(|item| !paths.contains(&item.path));
            }
            TreePatchOp::Upsert {
                parent_path,
                item,
                replace_children,
            } => {
                let siblings = children_of(tree, parent_path.as_deref());
                let mut next = item.clone();
                if let Some(at) = siblings
                    .iter()
                    .position(|sibling| sibling.path == item.path)
                {
                    let existing = siblings.remove(at);
                    if !replace_children {
                        next.children = existing.children;
                    }
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
}

fn children_of<'a>(tree: &'a mut Vec<TreeItem>, parent: Option<&str>) -> &'a mut Vec<TreeItem> {
    let Some(parent) = parent else {
        return tree;
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
    let item =
        find(tree, parent).unwrap_or_else(|| panic!("patch parent {parent} is not in the tree"));
    item.children.get_or_insert_with(Vec::new)
}

/// The place of an item among its siblings, derived from the item alone: an item whose file is
/// named like the folder that holds it stands for that folder (a bundle).
fn sort_key(vault: &Path, item: &TreeItem) -> (u8, String) {
    let path = Path::new(&item.path);
    let parent = path.parent().unwrap();
    let stem = path.file_stem().unwrap().to_string_lossy().to_string();
    let parent_name = parent.file_name().unwrap().to_string_lossy().to_string();
    let is_directory = item.item_type == "folder"
        || item.item_type == "database"
        || (parent != vault && stem == parent_name);
    let name = if item.item_type == "folder" || item.item_type == "database" {
        path.file_name().unwrap().to_string_lossy().to_string()
    } else if is_directory {
        parent_name
    } else {
        path.file_name().unwrap().to_string_lossy().to_string()
    };
    (u8::from(!is_directory), name.to_lowercase())
}

/// One line per item, so a mismatch reads as a diff.
fn outline(vault: &Path, items: &[TreeItem], depth: usize, out: &mut Vec<String>) {
    for item in items {
        out.push(format!(
            "{}{} [{}] {} id={} created={:?} modified={:?}",
            "  ".repeat(depth),
            item.path
                .strip_prefix(&*vault.to_string_lossy())
                .unwrap_or(&item.path),
            item.item_type,
            item.icon,
            item.id
                .strip_prefix(&*vault.to_string_lossy())
                .unwrap_or(&item.id),
            item.created,
            item.modified
        ));
        if let Some(children) = &item.children {
            outline(vault, children, depth + 1, out);
        }
    }
}

/// Panic with only the lines the two sides do not share.
fn assert_lines_equal(what: &str, patched: &[String], full: &[String]) {
    if patched == full {
        return;
    }
    let only = |from: &[String], other: &[String]| {
        from.iter()
            .filter(|line| !other.contains(line))
            .cloned()
            .collect::<Vec<_>>()
    };
    panic!(
        "{what} differ\n only in the point update:\n  {}\n only in the full load:\n  {}",
        only(patched, full).join("\n  "),
        only(full, patched).join("\n  "),
    );
}

fn assert_trees_equal(vault: &Path, patched: &[TreeItem], full: &[TreeItem]) {
    let (mut left, mut right) = (Vec::new(), Vec::new());
    outline(vault, patched, 0, &mut left);
    outline(vault, full, 0, &mut right);
    assert_lines_equal("tree outlines", &left, &right);
    assert_eq!(patched, full);
}

fn assert_index_equal(patched: &IndexDump, full: &IndexDump) {
    assert_lines_equal("notes", &patched.notes, &full.notes);
    assert_lines_equal("tags", &patched.tags, &full.tags);
    assert_lines_equal("links", &patched.links, &full.links);
    assert_eq!(patched.search, full.search, "search");
}

/// Run `mutate`, apply the tree patch it reports, and compare tree and index with a full load.
fn assert_point_equals_full(
    vault: &Vault,
    mutate: impl FnOnce(&VaultContext, &Vault) -> FsMutationResult,
) {
    let context = activate(&vault.0);
    let mut tree = loaded_tree(&context);
    let result = mutate(&context, vault);
    let patch = result
        .tree_patch
        .as_ref()
        .expect("the mutation must report a tree patch");
    apply(&mut tree, &vault.0, patch);

    let (full_index, full_tree) = full_load(&vault.0);
    assert_trees_equal(&vault.0, &tree, &full_tree);
    assert_index_equal(&active_dump(&context, &vault.0), &full_index);
}

fn outcome(outcome: MutationOutcome) -> FsMutationResult {
    assert_eq!(outcome.index_state, crate::model::IndexState::Healthy);
    outcome.mutation
}

fn rename(context: &VaultContext, vault: &Vault, from: &str, to: &str) -> FsMutationResult {
    outcome(
        rename_item_inner(
            context,
            &DatabaseRuntimeState::default(),
            &WatcherState::new(),
            &|_, _| {},
            vault.string(from),
            to.to_string(),
        )
        .unwrap(),
    )
}

fn move_to(context: &VaultContext, vault: &Vault, from: &str, to: &str) -> FsMutationResult {
    outcome(
        move_item_inner(
            context,
            &DatabaseRuntimeState::default(),
            &WatcherState::new(),
            &|_, _| {},
            vault.string(from),
            vault.string(to),
        )
        .unwrap(),
    )
}

fn trash(context: &VaultContext, vault: &Vault, path: &str) -> FsMutationResult {
    outcome(
        delete_item_inner(
            context,
            &WatcherState::new(),
            None,
            vault.string(path),
            DeleteMode::Archive,
        )
        .unwrap(),
    )
}

fn create(context: &VaultContext, vault: &Vault, parent: &str, name: &str) -> FsMutationResult {
    outcome(
        create_note_inner(
            context,
            &WatcherState::new(),
            vault.string(parent),
            name.into(),
        )
        .unwrap(),
    )
}

/// What a layer command does after its bundle plan: the same `sync_mutation_result`.
fn finish(context: &VaultContext, vault: &Vault, result: FsMutationResult) -> FsMutationResult {
    outcome(sync_mutation_result(context, &vault.0, result))
}

// ── create ─────────────────────────────────────────────────────────────────────────────────

#[test]
fn creating_a_note_in_a_folder() {
    assert_point_equals_full(&fixture(), |context, vault| {
        create(context, vault, "Folder", "Created note")
    });
}

#[test]
fn creating_a_note_at_the_vault_root() {
    assert_point_equals_full(&fixture(), |context, vault| {
        create(context, vault, "", "Created at root")
    });
}

#[test]
fn creating_a_child_under_a_plain_note_promotes_it_to_a_bundle() {
    assert_point_equals_full(&fixture(), |context, vault| {
        create(context, vault, "Projects/Alpha.md", "Created child")
    });
}

#[test]
fn disabled_supernotes_refuse_note_targets_and_preserve_existing_bundles() {
    let vault = fixture();
    vault.write(
        ".amby/workspace.json",
        r#"{"profile":{"id":"custom","catalogRevision":"2026-11-21"},"enabledModules":[]}"#,
    );
    assert_point_equals_full(&vault, |context, vault| {
        let watcher = WatcherState::new();
        for parent in ["Projects/Alpha.md", "Bundle/Bundle.md"] {
            let error =
                create_note_inner(context, &watcher, vault.string(parent), "Child".into()).err();
            assert_eq!(error.as_deref(), Some("moduleDisabled"));
            let error = move_item_inner(
                context,
                &DatabaseRuntimeState::default(),
                &watcher,
                &|_, _| panic!("a refused move must not emit a sync hint"),
                vault.string("Projects/Beta.md"),
                vault.string(parent),
            )
            .err();
            assert_eq!(error.as_deref(), Some("moduleDisabled"));
        }
        assert!(vault.path("Projects/Alpha.md").is_file());
        assert!(!vault.path("Projects/Alpha").exists());
        assert!(vault.path("Projects/Beta.md").is_file());
        assert!(vault.path("Bundle/Bundle.canvas").is_file());
        create(context, vault, "Folder", "Ordinary note")
    });
}

#[test]
fn disabled_supernotes_never_widen_file_mutations_to_bundle_folders() {
    let vault = fixture();
    vault.write(
        ".amby/workspace.json",
        r#"{"profile":{"id":"custom","catalogRevision":"2026-11-21"},"enabledModules":[]}"#,
    );
    vault.write("Bundle/Bundle.excalidraw", "{}\n");
    let context = activate(&vault.0);
    let watcher = WatcherState::new();
    let runtime = DatabaseRuntimeState::default();
    for file in [
        "Bundle/Bundle.md",
        "Bundle/Bundle.canvas",
        "Bundle/Bundle.excalidraw",
        "Db/Db.json",
    ] {
        let path = vault.string(file);
        let error = rename_item_inner(
            &context,
            &runtime,
            &watcher,
            &|_, _| panic!("sync hint"),
            path.clone(),
            "Changed".into(),
        )
        .err();
        assert_eq!(error.as_deref(), Some("moduleDisabled"), "rename {file}");
        let error = move_item_inner(
            &context,
            &runtime,
            &watcher,
            &|_, _| panic!("sync hint"),
            path.clone(),
            vault.string("Folder"),
        )
        .err();
        assert_eq!(error.as_deref(), Some("moduleDisabled"), "move {file}");
        assert!(vault.path(file).is_file());
    }
    assert!(vault.path("Bundle/Child.md").is_file());
    assert!(vault.path("Db").is_dir());
    // The folder remains an explicit, operable target.
    move_to(&context, &vault, "Bundle", "Folder");
    assert!(vault.path("Folder/Bundle/Bundle.md").is_file());
}

#[test]
fn disabled_supernotes_delete_exact_main_and_refresh_changed_bundle_shape() {
    for (remove_canvas, mode) in [(false, DeleteMode::Permanent), (true, DeleteMode::Archive)] {
        let vault = fixture();
        vault.write(
            ".amby/workspace.json",
            r#"{"profile":{"id":"custom","catalogRevision":"2026-11-21"},"enabledModules":[]}"#,
        );
        if remove_canvas {
            fs::remove_file(vault.path("Bundle/Bundle.canvas")).unwrap();
        }
        assert_point_equals_full(&vault, |context, vault| {
            let result = delete_with(context, vault, "Bundle/Bundle.md", mode);
            assert!(!vault.path("Bundle/Bundle.md").exists());
            assert!(vault.path("Bundle/Child.md").is_file());
            assert_eq!(vault.path("Bundle/Bundle.canvas").is_file(), !remove_canvas);
            result
        });
    }
}

#[test]
fn disabled_supernotes_keep_the_manifest_after_deleting_markdown() {
    for kind in ["attached", "standalone"] {
        let vault = fixture();
        vault.write(
        ".amby/workspace.json",
        r#"{"profile":{"id":"custom","catalogRevision":"2026-11-21"},"enabledModules":["databases"]}"#,
    );
        vault.note("Db/Db.md", "database text layer");
        let mut attached: serde_json::Value =
            serde_json::from_str(&database_manifest("Db")).unwrap();
        attached["containerKind"] = serde_json::json!(kind);
        let manifest = attached.to_string();
        vault.write("Db/Db.json", &manifest);
        assert_point_equals_full(&vault, |context, vault| {
            let result = delete_with(context, vault, "Db/Db.md", DeleteMode::Archive);
            assert!(!vault.path("Db/Db.md").exists());
            assert!(vault.path(".amby/archive/Db/Db.md").is_file());
            assert_eq!(
                fs::read_to_string(vault.path("Db/Db.json")).unwrap(),
                manifest
            );
            let db = loaded_tree(context)
                .into_iter()
                .find(|item| item.path == vault.string("Db"))
                .unwrap();
            let [member] = db.bundle_members.as_deref().unwrap() else {
                panic!("expected one physical database member");
            };
            assert_eq!(member.id, db.id);
            assert_eq!(member.path, vault.string("Db/Db.json"));
            assert_eq!(member.item_type, "database");
            assert!(db
                .children
                .unwrap()
                .iter()
                .any(|item| item.name == "Row One"));
            result
        });
    }
}

#[test]
fn disabled_supernotes_archive_exact_canvas_and_manifest() {
    for file in [
        "Bundle/Bundle.canvas",
        "Bundle/Bundle.excalidraw",
        "Db/Db.json",
    ] {
        let vault = fixture();
        vault.write("Bundle/Bundle.excalidraw", "{}\n");
        vault.write(
            ".amby/workspace.json",
            r#"{"profile":{"id":"custom","catalogRevision":"2026-11-21"},"enabledModules":["databases"]}"#,
        );
        assert_point_equals_full(&vault, |context, vault| {
            let result = archive(context, vault, file);
            assert!(!vault.path(file).exists());
            assert!(vault.path(&format!(".amby/archive/{file}")).is_file());
            assert!(vault.path("Bundle/Bundle.md").is_file());
            assert!(vault.path("Db/Row One.md").is_file());
            result
        });
    }
}

#[test]
fn attaching_text_to_a_database_keeps_its_files_and_refreshes_its_note_identity() {
    for with_sketch in [false, true] {
        let vault = fixture();
        vault.write(
            ".amby/workspace.json",
            r#"{"profile":{"id":"custom","catalogRevision":"2026-11-21"},"enabledModules":["supernotes","databases"]}"#,
        );
        let mut manifest: serde_json::Value =
            serde_json::from_str(&database_manifest("Db")).unwrap();
        manifest["containerKind"] = serde_json::json!(if with_sketch {
            "attached"
        } else {
            "standalone"
        });
        let manifest = manifest.to_string();
        vault.write("Db/Db.json", &manifest);
        let entry = if with_sketch {
            vault.write("Db/Db.excalidraw", "{}\n");
            vault.path("Db/Db.excalidraw")
        } else {
            vault.path("Db")
        };
        let context = activate(&vault.0);
        let runtime = DatabaseRuntimeState::default();
        runtime.set_enabled(context.generation().unwrap(), true);
        let (result, _) =
            create_layer_inner(&context, &WatcherState::new(), &runtime, &entry, "note").unwrap();
        let note_path = vault.string("Db/Db.md");
        assert_eq!(result.layer_path, note_path);
        assert!(result.path_changes.is_empty());
        assert_eq!(
            fs::read_to_string(vault.path("Db/Db.json")).unwrap(),
            manifest
        );
        assert!(vault.path("Db/Row One.md").is_file());
        let note_id = context
            .with_active(|active| {
                active
                    .connection
                    .query_row(
                        "SELECT attached_note_id FROM db_databases WHERE name = 'Db'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        let tree = loaded_tree(&context);
        if with_sketch {
            let main = tree.iter().find(|item| item.path == note_path).unwrap();
            assert_eq!(main.id, note_id);
            assert_eq!(
                fs::read_to_string(vault.path("Db/Db.excalidraw")).unwrap(),
                "{}\n"
            );
        } else {
            let db = tree
                .iter()
                .find(|item| item.path == vault.string("Db"))
                .unwrap();
            assert!(db.bundle_members.as_ref().unwrap().iter().any(|member| {
                member.item_type == "file" && member.path == note_path && member.id == note_id
            }));
        }
    }
}

#[test]
fn deleting_a_manifest_rebuilds_the_database_projection() {
    let vault = fixture();
    vault.write(
        ".amby/workspace.json",
        r#"{"profile":{"id":"custom","catalogRevision":"2026-11-21"},"enabledModules":["databases"]}"#,
    );
    let context = activate(&vault.0);
    let runtime = DatabaseRuntimeState::default();
    runtime.set_enabled(context.generation().unwrap(), true);
    let count = || {
        context
            .with_active(|active| {
                active
                    .connection
                    .query_row("SELECT COUNT(*) FROM db_databases", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .map_err(|error| error.to_string())
            })
            .unwrap()
    };
    assert_eq!(count(), 1);
    let result = delete_item_inner(
        &context,
        &WatcherState::new(),
        Some(&runtime),
        vault.string("Db/Db.json"),
        DeleteMode::Permanent,
    )
    .unwrap();
    assert!(result.warnings.is_empty());
    assert_eq!(count(), 0);
    assert!(vault.path("Db/Row One.md").is_file());
}

#[test]
fn disabled_supernote_folder_rename_preserves_the_group_and_folder_identity() {
    let vault = fixture();
    vault.write(
        ".amby/workspace.json",
        r#"{"profile":{"id":"custom","catalogRevision":"2026-11-21"},"enabledModules":[]}"#,
    );
    vault.write("Bundle/Bundle.excalidraw", "{}\n");
    vault.write("Bundle/Bundle.json", &database_manifest("Bundle"));
    assert_point_equals_full(&vault, |context, vault| {
        let operation =
            crate::commands::mutations::rename_operation_path(&vault.0, &vault.path("Bundle"))
                .unwrap();
        assert_eq!(operation, vault.path("Bundle/Bundle.md"));
        let preview = crate::bundle::preview_rename_item(&vault.0, &operation, "Renamed").unwrap();
        let result = rename(context, vault, "Bundle", "Renamed");
        assert_eq!(
            result.primary_path.as_deref(),
            Some(vault.string("Renamed").as_str())
        );
        let paths = |changes: &[crate::model::PathChange]| {
            changes
                .iter()
                .map(|change| (change.old_path.clone(), change.new_path.clone()))
                .collect::<Vec<_>>()
        };
        assert_eq!(paths(&result.path_changes), paths(&preview.path_changes));
        for ext in ["md", "canvas", "excalidraw", "json"] {
            assert!(vault.path(&format!("Renamed/Renamed.{ext}")).is_file());
        }
        assert!(vault.path("Renamed/Child.md").is_file());
        result
    });
}

#[test]
fn disabled_supernote_canvas_folder_rename_preserves_the_group() {
    let vault = fixture();
    vault.write(
        ".amby/workspace.json",
        r#"{"profile":{"id":"custom","catalogRevision":"2026-11-21"},"enabledModules":[]}"#,
    );
    vault.write("Solo/Solo.canvas", "{}\n");
    vault.write("Solo/Solo.excalidraw", "{}\n");
    assert_point_equals_full(&vault, |context, vault| {
        let result = rename(context, vault, "Solo", "Renamed");
        assert_eq!(
            result.primary_path.as_deref(),
            Some(vault.string("Renamed").as_str())
        );
        assert!(vault.path("Renamed/Renamed.canvas").is_file());
        assert!(vault.path("Renamed/Renamed.excalidraw").is_file());
        result
    });
}

#[cfg(unix)]
#[test]
fn disabled_supernote_folder_rename_rejects_a_symlinked_main_document() {
    use std::os::unix::fs::symlink;

    let vault = fixture();
    vault.write(
        ".amby/workspace.json",
        r#"{"profile":{"id":"custom","catalogRevision":"2026-11-21"},"enabledModules":[]}"#,
    );
    fs::create_dir(vault.path("Linked")).unwrap();
    symlink(
        vault.path("Projects/Alpha.md"),
        vault.path("Linked/Linked.md"),
    )
    .unwrap();
    let error = crate::commands::mutations::rename_operation_path(&vault.0, &vault.path("Linked"))
        .unwrap_err();
    assert!(error.contains("symbolic link"));
    let context = activate(&vault.0);
    let error = rename_item_inner(
        &context,
        &DatabaseRuntimeState::default(),
        &WatcherState::new(),
        &|_, _| panic!("a refused rename must not emit a sync hint"),
        vault.string("Linked"),
        "Renamed".into(),
    )
    .err()
    .unwrap();
    assert!(error.contains("symbolic link"));
    assert!(vault.path("Projects/Alpha.md").is_file());
    assert!(vault.path("Linked/Linked.md").is_symlink());
}

#[test]
fn creating_a_child_in_an_existing_bundle() {
    assert_point_equals_full(&fixture(), |context, vault| {
        create(context, vault, "Bundle/Bundle.md", "Created in bundle")
    });
}

#[test]
fn creating_a_note_inside_a_database() {
    assert_point_equals_full(&fixture(), |context, vault| {
        create(context, vault, "Db", "Created row")
    });
}

/// Today's note in a folder that does not exist yet: the folder must come with the note in the
/// same patch, or the window shows the note at the root until the folder arrives (a duplicate).
fn daily(context: &VaultContext, vault: &Vault, folder: &str) -> FsMutationResult {
    fs::create_dir_all(vault.path(".amby")).unwrap();
    fs::write(
        vault.path(".amby/workspace.json"),
        // Daily notes are opt-in: the module list switches them on.
        format!(
            r#"{{"profile":{{"id":"custom","catalogRevision":"2026-11-20"}},"enabledModules":["amby.daily"],"moduleSettings":{{"daily":{{"folder":"{folder}"}}}}}}"#
        ),
    )
    .unwrap();
    let moment = amby_core::note_templates::Moment::on("2026-11-20").unwrap();
    let (daily, _) =
        crate::commands::note_templates::open_daily_inner(context, &WatcherState::new(), &moment)
            .unwrap();
    outcome(daily.mutation.expect("today's note is created"))
}

#[test]
fn todays_note_in_a_new_folder() {
    assert_point_equals_full(&fixture(), |context, vault| daily(context, vault, "Daily"));
}

#[test]
fn todays_note_in_new_nested_folders() {
    assert_point_equals_full(&fixture(), |context, vault| {
        daily(context, vault, "Journal/2026")
    });
}

#[test]
fn a_new_template_in_a_new_templates_folder() {
    assert_point_equals_full(&fixture(), |context, _vault| {
        let (outcome_value, _) = crate::commands::note_templates::create_template_inner(
            context,
            &WatcherState::new(),
            "Meeting".to_owned(),
        )
        .unwrap();
        outcome(outcome_value)
    });
}

#[test]
fn todays_note_in_an_existing_folder() {
    assert_point_equals_full(&fixture(), |context, vault| daily(context, vault, "Folder"));
}

// ── rename ─────────────────────────────────────────────────────────────────────────────────

#[test]
fn renaming_a_note_rewrites_its_inbound_links_in_index_and_tree() {
    assert_point_equals_full(&fixture(), |context, vault| {
        rename(context, vault, "Projects/Alpha.md", "Renamed alpha")
    });
}

#[test]
fn renaming_a_note_so_that_it_sorts_elsewhere() {
    assert_point_equals_full(&fixture(), |context, vault| {
        rename(context, vault, "Projects/Alpha.md", "zzz last")
    });
}

#[test]
fn renaming_a_folder_with_nested_files() {
    assert_point_equals_full(&fixture(), |context, vault| {
        rename(context, vault, "Folder", "Renamed folder")
    });
}

#[test]
fn renaming_a_bundle_with_its_layers_and_children() {
    assert_point_equals_full(&fixture(), |context, vault| {
        rename(context, vault, "Bundle/Bundle.md", "Renamed bundle")
    });
}

#[test]
fn renaming_a_database_folder() {
    assert_point_equals_full(&fixture(), |context, vault| {
        rename(context, vault, "Db", "Renamed Db")
    });
}

#[test]
fn renaming_a_note_with_a_broken_header() {
    assert_point_equals_full(&fixture(), |context, vault| {
        rename(context, vault, "Broken.md", "Renamed broken")
    });
}

#[test]
fn renaming_a_standalone_canvas() {
    assert_point_equals_full(&fixture(), |context, vault| {
        rename(context, vault, "Standalone.canvas", "Renamed canvas")
    });
}

#[test]
fn renaming_the_original_of_a_conflict_copy() {
    assert_point_equals_full(&fixture(), |context, vault| {
        rename(context, vault, "Projects/Conflicted.md", "Renamed original")
    });
}

// ── move ───────────────────────────────────────────────────────────────────────────────────

#[test]
fn moving_a_note_into_another_folder() {
    assert_point_equals_full(&fixture(), |context, vault| {
        move_to(context, vault, "Projects/Beta.md", "Заметки")
    });
}

#[test]
fn moving_a_note_to_the_vault_root() {
    assert_point_equals_full(&fixture(), |context, vault| {
        move_to(context, vault, "Folder/Loose.md", "")
    });
}

#[test]
fn moving_a_folder_with_nested_files_into_another_folder() {
    assert_point_equals_full(&fixture(), |context, vault| {
        move_to(context, vault, "Folder/Sub", "Заметки")
    });
}

#[test]
fn moving_a_bundle_into_a_folder() {
    assert_point_equals_full(&fixture(), |context, vault| {
        move_to(context, vault, "Bundle/Bundle.md", "Projects")
    });
}

#[test]
fn moving_a_note_into_a_bundle() {
    assert_point_equals_full(&fixture(), |context, vault| {
        move_to(context, vault, "Projects/Beta.md", "Bundle/Bundle.md")
    });
}

#[test]
fn moving_a_note_into_a_database() {
    assert_point_equals_full(&fixture(), |context, vault| {
        move_to(context, vault, "Projects/Beta.md", "Db")
    });
}

/// The question "carry the properties over?" reads the note's place in the database right after the
/// move, with the module on: the projection must already list the note then (no race).
#[test]
fn a_note_moved_into_a_database_is_listed_by_the_projection_at_once() {
    let vault = fixture();
    let note_id = vault.note("Mover.md", "mover");
    let context = activate(&vault.0);
    let runtime = DatabaseRuntimeState::default();
    runtime.set_enabled(context.generation().unwrap(), true);
    move_item_inner(
        &context,
        &runtime,
        &WatcherState::new(),
        &|_, _| {},
        vault.string("Mover.md"),
        vault.string("Db"),
    )
    .unwrap();
    let found = database_note_context_inner(&context, &runtime, note_id.clone())
        .expect("the context is readable")
        .expect("the moved note is a member of the database");
    assert_eq!(found.row.note_id, note_id);
    assert_eq!(found.row.relative_path, "Db/Mover.md");
}

// ── delete ─────────────────────────────────────────────────────────────────────────────────

#[test]
fn deleting_a_note_to_the_trash() {
    assert_point_equals_full(&fixture(), |context, vault| {
        trash(context, vault, "Projects/Alpha.md")
    });
}

#[test]
fn deleting_a_folder_with_nested_files() {
    assert_point_equals_full(&fixture(), |context, vault| trash(context, vault, "Folder"));
}

#[test]
fn deleting_a_bundle() {
    assert_point_equals_full(&fixture(), |context, vault| {
        trash(context, vault, "Bundle/Bundle.md")
    });
}

#[test]
fn deleting_the_last_note_of_a_folder() {
    assert_point_equals_full(&fixture(), |context, vault| {
        trash(context, vault, "Folder/Sub/Deeper/Deepest.md")
    });
}

fn delete_with(
    context: &VaultContext,
    vault: &Vault,
    path: &str,
    mode: DeleteMode,
) -> FsMutationResult {
    outcome(
        delete_item_inner(
            context,
            &WatcherState::new(),
            None,
            vault.string(path),
            mode,
        )
        .unwrap(),
    )
}

fn archive(context: &VaultContext, vault: &Vault, path: &str) -> FsMutationResult {
    outcome(archive_item_inner(context, &WatcherState::new(), None, vault.string(path)).unwrap())
}

/// TREE-01: a folder with no note, canvas or sketch in it (empty, or only a workshop's `.json`
/// files) has nothing in `deleted_paths`; the folder itself must still leave the tree.
fn folder_without_notes_vault() -> Vault {
    let vault = fixture();
    fs::create_dir_all(vault.path("Empty")).unwrap();
    vault.write("Shop/data.json", "{}\n");
    vault.write("Shop/Deep/more.json", "{}\n");
    vault
}

fn assert_removes_folder(result: &FsMutationResult, vault: &Vault, name: &str) {
    let folder = vault.string(name);
    let patch = result.tree_patch.as_ref().expect("a patch or a reload");
    assert!(
        patch.ops.iter().any(|op| matches!(
            op,
            TreePatchOp::Remove { paths, .. } if paths.contains(&folder)
        )),
        "the patch must remove {name}: {patch:?}"
    );
}

fn assert_folder_gone_from_patched_tree(
    vault: &Vault,
    tree: &mut Vec<TreeItem>,
    result: &FsMutationResult,
) {
    apply(tree, &vault.0, result.tree_patch.as_ref().unwrap());
    let (_, full_tree) = full_load(&vault.0);
    assert_trees_equal(&vault.0, tree, &full_tree);
}

#[test]
fn deleting_a_folder_without_notes_removes_it_from_the_tree() {
    for name in ["Empty", "Shop"] {
        for mode in [DeleteMode::Archive, DeleteMode::Permanent] {
            let vault = folder_without_notes_vault();
            let context = activate(&vault.0);
            let mut tree = loaded_tree(&context);
            let result = delete_with(&context, &vault, name, mode);
            assert_removes_folder(&result, &vault, name);
            assert_folder_gone_from_patched_tree(&vault, &mut tree, &result);
        }
    }
}

#[test]
fn archiving_a_folder_without_notes_removes_it_from_the_tree() {
    for name in ["Empty", "Shop"] {
        let vault = folder_without_notes_vault();
        let context = activate(&vault.0);
        let mut tree = loaded_tree(&context);
        let result = archive(&context, &vault, name);
        assert_removes_folder(&result, &vault, name);
        assert_folder_gone_from_patched_tree(&vault, &mut tree, &result);
    }
}

fn indexed_workshops(context: &VaultContext) -> i64 {
    context
        .with_active(|active| {
            Ok(active
                .connection
                .query_row("SELECT COUNT(*) FROM project_workshops", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap())
        })
        .unwrap()
}

/// TREE-01: the catalog of workshops is kept in the index; deleting the folder of a workshop must
/// take it out, with or without notes in the folder.
#[test]
fn removing_a_workshop_folder_takes_it_out_of_the_catalog() {
    let workshop =
        "{\"formatVersion\":3,\"workshopId\":\"shop\",\"name\":\"Shop\",\"sections\":[]}\n";
    for how in ["archive", "permanent", "archive_item"] {
        let vault = folder_without_notes_vault();
        vault.write("Shop/amby-workshop.json", workshop);
        let context = activate(&vault.0);
        assert_eq!(
            indexed_workshops(&context),
            1,
            "{how}: the workshop is indexed"
        );
        match how {
            "archive" => drop(delete_with(&context, &vault, "Shop", DeleteMode::Archive)),
            "permanent" => drop(delete_with(&context, &vault, "Shop", DeleteMode::Permanent)),
            _ => drop(archive(&context, &vault, "Shop")),
        }
        assert_eq!(
            indexed_workshops(&context),
            0,
            "{how}: the catalog must not keep it"
        );
    }
}

#[test]
fn an_empty_patch_for_nothing_touched_is_a_reload_not_a_no_change() {
    let vault = fixture();
    let context = activate(&vault.0);
    let patch = context
        .with_active(|active| {
            crate::vault::tree_patch::patch_for_paths(&active.connection, &vault.0, &[])
        })
        .unwrap();
    assert!(
        patch.is_none(),
        "nothing known to have changed means reload"
    );
}

#[test]
fn deleting_a_conflict_copy() {
    assert_point_equals_full(&fixture(), |context, vault| {
        trash(
            context,
            vault,
            "Projects/Conflicted.0123456789ab-conflict.md",
        )
    });
}

// ── layers ─────────────────────────────────────────────────────────────────────────────────

#[test]
fn attaching_a_standalone_canvas_to_a_note() {
    let vault = fixture();
    vault.write("Projects/Alpha.canvas", "{}\n");
    assert_point_equals_full(&vault, |context, vault| {
        let result =
            crate::bundle::attach_canvas_impl(&vault.path("Projects/Alpha.canvas")).unwrap();
        finish(context, vault, result)
    });
}

#[test]
fn creating_a_canvas_layer_for_a_note() {
    assert_point_equals_full(&fixture(), |context, vault| {
        let layer =
            crate::bundle::create_layer_impl(&vault.path("Projects/Beta.md"), "canvas").unwrap();
        finish(
            context,
            vault,
            FsMutationResult {
                primary_id: None,
                primary_path: Some(layer.layer_path.clone()),
                path_changes: layer.path_changes,
                deleted_paths: Vec::new(),
                deleted_ids: Vec::new(),
                tree_patch: None,
                also_touched: Vec::new(),
                undo: None,
            },
        )
    });
}

#[test]
fn unlinking_a_layer_from_a_bundle() {
    assert_point_equals_full(&fixture(), |context, vault| {
        let result =
            crate::bundle::unlink_layer_impl(&vault.path("Bundle/Bundle.md"), "canvas").unwrap();
        finish(context, vault, result)
    });
}

#[test]
fn deleting_a_layer_of_a_bundle() {
    assert_point_equals_full(&fixture(), |context, vault| {
        let result =
            crate::bundle::delete_layer_impl(&vault.0, &vault.path("Bundle/Bundle.md"), "canvas")
                .unwrap();
        finish(context, vault, result)
    });
}

// ── external changes ───────────────────────────────────────────────────────────────────────

/// A watcher batch: change the disk behind the app's back, then refresh just those paths. The
/// reference is a full synchronisation of a copy of the index as it was before the change (a
/// note that already owns an id keeps it against a newer copy, which a database built from
/// nothing would not know).
fn assert_external_change_equals_full(vault: &Vault, change: impl FnOnce(&Vault) -> Vec<PathBuf>) {
    let context = activate(&vault.0);
    let mut tree = loaded_tree(&context);
    let before =
        std::env::temp_dir().join(format!("amby-tree-patch-oracle-{}.db", Ulid::generate()));
    context
        .with_active(|active| {
            active
                .execute("VACUUM INTO ?1", [before.to_string_lossy().to_string()])
                .map_err(|error| error.to_string())
        })
        .unwrap();
    let oracle = Connection::open(&before).unwrap();

    let changed = change(vault).into_iter().collect::<HashSet<_>>();
    let refresh = context
        .with_active(|active| active.refresh_paths(changed.clone()))
        .unwrap()
        .expect("a few changed paths must be refreshed by path");
    apply(&mut tree, &vault.0, &refresh.patch);

    let full = index::load_vault_with_changes(&oracle, &vault.0, &changed).unwrap();
    assert_trees_equal(&vault.0, &tree, &full.tree);
    assert_index_equal(&active_dump(&context, &vault.0), &dump(&oracle, &vault.0));
    let _ = fs::remove_file(&before);
}

#[test]
fn an_external_edit_of_one_note() {
    assert_external_change_equals_full(&fixture(), |vault| {
        let id = vault.note(
            "Projects/Alpha.md",
            "alpha edited renamed token [[Beta]] #three",
        );
        let _ = id; // a new id: the same path now holds another note
        vec![vault.path("Projects/Alpha.md")]
    });
}

#[test]
fn an_external_new_note_with_and_without_an_id() {
    assert_external_change_equals_full(&fixture(), |vault| {
        vault.note("Folder/External created.md", "created externally [[Alpha]]");
        vault.write("Folder/No id.md", "no id here, created token");
        vec![
            vault.path("Folder/External created.md"),
            vault.path("Folder/No id.md"),
        ]
    });
}

#[test]
fn an_external_delete() {
    assert_external_change_equals_full(&fixture(), |vault| {
        fs::remove_file(vault.path("Folder/Loose.md")).unwrap();
        vec![vault.path("Folder/Loose.md")]
    });
}

#[test]
fn an_external_rename_of_a_note_reports_both_paths() {
    assert_external_change_equals_full(&fixture(), |vault| {
        fs::rename(
            vault.path("Projects/Beta.md"),
            vault.path("Projects/Beta moved.md"),
        )
        .unwrap();
        vec![
            vault.path("Projects/Beta.md"),
            vault.path("Projects/Beta moved.md"),
        ]
    });
}

#[test]
fn an_external_rename_of_a_folder_reports_only_the_folder() {
    assert_external_change_equals_full(&fixture(), |vault| {
        fs::rename(vault.path("Folder"), vault.path("Folder renamed")).unwrap();
        vec![vault.path("Folder"), vault.path("Folder renamed")]
    });
}

#[test]
fn an_external_move_of_a_bundle() {
    assert_external_change_equals_full(&fixture(), |vault| {
        fs::rename(vault.path("Bundle"), vault.path("Projects/Bundle")).unwrap();
        vec![vault.path("Bundle"), vault.path("Projects/Bundle")]
    });
}

#[test]
fn an_external_edit_that_breaks_the_header() {
    assert_external_change_equals_full(&fixture(), |vault| {
        vault.write(
            "Projects/Alpha.md",
            "---\ntags: [oops\n---\nalpha broken now token",
        );
        vec![vault.path("Projects/Alpha.md")]
    });
}

#[test]
fn an_external_conflict_copy_appears() {
    assert_external_change_equals_full(&fixture(), |vault| {
        let original = fs::read_to_string(vault.path("Projects/Alpha.md")).unwrap();
        vault.write("Projects/Alpha.abcdef012345-conflict.md", &original);
        vec![vault.path("Projects/Alpha.abcdef012345-conflict.md")]
    });
}

#[test]
fn an_external_copy_with_a_duplicate_id() {
    assert_external_change_equals_full(&fixture(), |vault| {
        let original = fs::read_to_string(vault.path("Projects/Alpha.md")).unwrap();
        vault.write("Folder/Copy of Alpha.md", &original);
        vec![vault.path("Folder/Copy of Alpha.md")]
    });
}

#[test]
fn an_external_manifest_turns_a_folder_into_a_database() {
    assert_external_change_equals_full(&fixture(), |vault| {
        vault.write("Folder/Sub/Sub.json", &database_manifest("Sub"));
        vec![vault.path("Folder/Sub/Sub.json")]
    });
}

#[test]
fn deleting_a_note_whose_id_duplicates_wait_for_needs_the_full_scan() {
    let vault = fixture();
    let context = activate(&vault.0);
    fs::remove_file(vault.path("Projects/Conflicted.md")).unwrap();
    let refresh = context
        .with_active(|active| {
            active.refresh_paths(HashSet::from([vault.path("Projects/Conflicted.md")]))
        })
        .unwrap();
    assert!(
        refresh.is_none(),
        "the conflict copy would be promoted to the identity: only the full scan decides that"
    );
}

#[test]
fn the_vault_root_event_cannot_be_refreshed_by_path() {
    let vault = fixture();
    let context = activate(&vault.0);
    let refresh = context
        .with_active(|active| active.refresh_paths(HashSet::from([vault.0.clone()])))
        .unwrap();
    assert!(
        refresh.is_none(),
        "an OS rescan request needs the full path"
    );
}

#[test]
fn a_path_in_a_hidden_folder_changes_nothing_and_one_outside_the_vault_needs_the_full_scan() {
    let vault = fixture();
    let context = activate(&vault.0);
    let outside = context
        .with_active(|active| {
            active.refresh_paths(HashSet::from([PathBuf::from("/elsewhere/x.md")]))
        })
        .unwrap();
    assert!(outside.is_none());
    let mut tree = loaded_tree(&context);
    let refresh = context
        .with_active(|active| {
            active.refresh_paths(HashSet::from([
                vault.path(".amby/notes.db"),
                vault.path("assets/image.png"),
                vault.path(".git/config"),
            ]))
        })
        .unwrap()
        .expect("ignored paths are still a point refresh");
    apply(&mut tree, &vault.0, &refresh.patch);
    assert_eq!(tree, loaded_tree(&context));
}

// ── what a rename or a move must still do to the rest of the vault ─────────────────────────

#[test]
fn rename_reports_rewritten_sources_for_open_windows() {
    let vault = fixture();
    let context = activate(&vault.0);
    let result = rename_item_inner(
        &context,
        &DatabaseRuntimeState::default(),
        &WatcherState::new(),
        &|_, _| {},
        vault.string("Projects/Alpha.md"),
        "Renamed alpha".to_string(),
    )
    .unwrap();
    let (generation, paths) = result.rewritten_notes.expect("rewritten sources reported");
    assert_eq!(generation, context.generation().unwrap());
    assert!(paths.contains(&vault.path("Projects/Beta.md")));
    assert!(paths.contains(&vault.path("Root note.md")));
    assert!(!paths.contains(&vault.path("Folder/Loose.md")));
}

#[test]
fn a_rename_still_rewrites_literal_references_in_notes_and_canvases() {
    let vault = fixture();
    vault.write(
        "Standalone.canvas",
        "{\"nodes\":[{\"type\":\"file\",\"file\":\"Projects/Alpha.md\"}]}\n",
    );
    vault.write(
        "Folder/Other.md",
        "unrelated [text](Elsewhere.md) and \"Projects/Alpha.md.bak\"",
    );
    let context = activate(&vault.0);
    rename(&context, &vault, "Projects/Alpha.md", "Renamed alpha");
    let beta = fs::read_to_string(vault.path("Projects/Beta.md")).unwrap();
    assert!(beta.contains("](Projects/Renamed alpha.md)"), "{beta}");
    assert!(!beta.contains("[[Alpha]]"), "{beta}");
    assert!(fs::read_to_string(vault.path("Standalone.canvas"))
        .unwrap()
        .contains("\"file\":\"Projects/Renamed alpha.md\""));
    assert!(
        fs::read_to_string(vault.path("Folder/Other.md"))
            .unwrap()
            .ends_with("unrelated [text](Elsewhere.md) and \"Projects/Alpha.md.bak\""),
        "a file that only looks similar is left alone"
    );
}

#[test]
fn a_database_is_involved_only_when_a_path_is_in_one_or_is_one() {
    use crate::commands::mutations::touches_database_for_tests as touches;
    let vault = fixture();
    let paths = |relative: &[&str]| {
        relative
            .iter()
            .map(|path| vault.path(path))
            .collect::<Vec<_>>()
    };
    assert!(touches(&vault.0, &paths(&["Db/Row One.md"])));
    assert!(touches(&vault.0, &paths(&["Db"])));
    assert!(touches(
        &vault.0,
        &paths(&["Projects/Alpha.md", "Db/Gone.md"])
    ));
    assert!(!touches(
        &vault.0,
        &paths(&["Projects/Alpha.md", "Folder/Sub/Deep.md"])
    ));
    assert!(!touches(&vault.0, &paths(&["Root note.md"])));
}

// CORE-03: the rename command carries the note's versions to its new path.
#[test]
fn a_rename_carries_the_note_history_to_the_new_path() {
    let vault = fixture();
    let context = activate(&vault.0);
    let note = vault.path("Folder/Loose.md");
    crate::history::snapshot_before_write(&vault.0, &note, b"next", "edit").unwrap();
    assert_eq!(
        crate::history::list_snapshots(&vault.0, &note)
            .unwrap()
            .len(),
        1
    );
    rename_item_inner(
        &context,
        &DatabaseRuntimeState::default(),
        &WatcherState::new(),
        &|_, _| {},
        vault.string("Folder/Loose.md"),
        "Renamed loose".to_string(),
    )
    .unwrap();
    let renamed = vault.path("Folder/Renamed loose.md");
    assert_eq!(
        crate::history::list_snapshots(&vault.0, &renamed)
            .unwrap()
            .len(),
        1
    );
}

// CORE-10: the tail shared by rename and move is pinned for both, so the two cannot drift apart.
#[test]
fn a_move_reports_rewritten_sources_for_open_windows() {
    let vault = fixture();
    let context = activate(&vault.0);
    let result = move_item_inner(
        &context,
        &DatabaseRuntimeState::default(),
        &WatcherState::new(),
        &|_, _| {},
        vault.string("Projects/Alpha.md"),
        vault.string("Folder"),
    )
    .unwrap();
    let (generation, paths) = result.rewritten_notes.expect("rewritten sources reported");
    assert_eq!(generation, context.generation().unwrap());
    assert!(paths.contains(&vault.path("Projects/Beta.md")));
    assert!(paths.contains(&vault.path("Заметки/Гамма.md")));
    // `[[Alpha]]` is still a unique name after the move, so the link stays as written.
    assert!(!paths.contains(&vault.path("Root note.md")));
    assert!(!paths.contains(&vault.path("Folder/Loose.md")));
}

#[test]
fn a_move_carries_the_note_history_to_the_new_path() {
    let vault = fixture();
    let context = activate(&vault.0);
    let note = vault.path("Folder/Loose.md");
    crate::history::snapshot_before_write(&vault.0, &note, b"next", "edit").unwrap();
    move_item_inner(
        &context,
        &DatabaseRuntimeState::default(),
        &WatcherState::new(),
        &|_, _| {},
        vault.string("Folder/Loose.md"),
        vault.string("Projects"),
    )
    .unwrap();
    let moved = vault.path("Projects/Loose.md");
    assert_eq!(
        crate::history::list_snapshots(&vault.0, &moved)
            .unwrap()
            .len(),
        1
    );
}

/// A link rewrite that cannot be written puts the file back where it was and changes nothing.
#[cfg(unix)]
fn assert_failed_rewrite_is_rolled_back(
    run: impl FnOnce(&VaultContext, &Vault) -> Result<MutationOutcome, String>,
    word: &str,
) {
    use std::os::unix::fs::PermissionsExt;
    let vault = fixture();
    let context = activate(&vault.0);
    let locked = vault.path("Заметки");
    let gamma = fs::read_to_string(vault.path("Заметки/Гамма.md")).unwrap();
    let beta = fs::read_to_string(vault.path("Projects/Beta.md")).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
    if fs::write(locked.join("probe"), b"x").is_ok() {
        // Running as a user who ignores permissions: the failure cannot be provoked here.
        let _ = fs::remove_file(locked.join("probe"));
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        return;
    }
    let Err(error) = run(&context, &vault) else {
        panic!("the rewrite cannot be written");
    };
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        error.contains(&format!("{word} was rolled back")),
        "{error}"
    );
    assert!(vault.path("Projects/Alpha.md").exists());
    assert_eq!(
        fs::read_to_string(vault.path("Заметки/Гамма.md")).unwrap(),
        gamma
    );
    assert_eq!(
        fs::read_to_string(vault.path("Projects/Beta.md")).unwrap(),
        beta
    );
}

#[cfg(unix)]
#[test]
fn a_rename_whose_link_rewrite_fails_is_rolled_back() {
    assert_failed_rewrite_is_rolled_back(
        |context, vault| {
            rename_item_inner(
                context,
                &DatabaseRuntimeState::default(),
                &WatcherState::new(),
                &|_, _| {},
                vault.string("Projects/Alpha.md"),
                "Renamed alpha".to_string(),
            )
        },
        "rename",
    );
}

#[cfg(unix)]
#[test]
fn a_move_whose_link_rewrite_fails_is_rolled_back() {
    assert_failed_rewrite_is_rolled_back(
        |context, vault| {
            move_item_inner(
                context,
                &DatabaseRuntimeState::default(),
                &WatcherState::new(),
                &|_, _| {},
                vault.string("Projects/Alpha.md"),
                vault.string("Folder"),
            )
        },
        "move",
    );
}
