//! "Point equals full": after one action, the index and the tree updated for that action alone
//! must be what a full `load_vault` of the same disk gives. Every scenario runs the real mutation
//! code (the `*_inner` functions behind the IPC commands, or the bundle plans plus
//! `sync_mutation_result`), applies the tree patch it returns to the tree loaded before, and
//! compares it, and the whole index, with a from-scratch load of the vault on a second database.

use super::tree::TreeItem;
use super::tree_patch::{TreePatch, TreePatchOp};
use crate::commands::database::database_note_context_inner;
use crate::commands::mutations::{
    create_note_inner, delete_item_inner, move_item_inner, rename_item_inner, sync_mutation_result,
};
use crate::database::runtime_state::DatabaseRuntimeState;
use crate::index;
use crate::model::{FsMutationResult, MutationOutcome};
use crate::recycle_bin::DeleteMode;
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
    vault.note("Заметки/Гамма.md", "gamma [[Alpha]]");
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
