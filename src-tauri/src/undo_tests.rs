//! Exact undo of a rename or a move that rewrote links in other notes, and of a merge of two notes
//! (docs/notices.md, section 9). The undo puts back the bytes the operation replaced, from the
//! history snapshots it took, and never rewrites links back: a note that already linked to the new
//! name before the rename must come back unchanged.

use crate::commands::mutations::{move_item_inner, rename_item_inner};
use crate::commands::undo::{begin_merge_inner, finish_merge_inner, undo_mutation_inner};
use crate::database::runtime_state::DatabaseRuntimeState;
use crate::model::{MutationOutcome, UndoRecord};
use crate::storage_error::StorageErrorCode;
use crate::vault_context::VaultContext;
use crate::watcher::WatcherState;
use std::fs;
use std::path::PathBuf;
use ulid::Ulid;

struct Vault(PathBuf);

impl Vault {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("amby-undo-{name}-{}", Ulid::generate()));
        fs::create_dir_all(root.join(".amby")).unwrap();
        // History is switched off: the undo snapshots must be kept anyway.
        fs::write(
            root.join(".amby/workspace.json"),
            r#"{"enabledModules":["supernotes"]}"#,
        )
        .unwrap();
        Self(root.canonicalize().unwrap())
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.0.join(relative)
    }

    fn string(&self, relative: &str) -> String {
        self.path(relative).to_string_lossy().into_owned()
    }

    fn write(&self, relative: &str, bytes: &[u8]) {
        let path = self.path(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn read(&self, relative: &str) -> Vec<u8> {
        fs::read(self.path(relative)).unwrap()
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn note(id: &str, body: &str) -> Vec<u8> {
    format!("---\namby-id: {id}\n---\n{body}").into_bytes()
}

/// A note with a BOM and Windows line endings, which the undo must keep.
fn crlf_note(id: &str, body: &str) -> Vec<u8> {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend(
        format!("---\r\namby-id: {id}\r\n---\r\n{body}")
            .replace("\r\n", "\n")
            .replace('\n', "\r\n")
            .into_bytes(),
    );
    bytes
}

fn activate(vault: &Vault) -> VaultContext {
    let context = VaultContext::new();
    context
        .activate(vault.0.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    context
}

fn id() -> String {
    Ulid::generate().to_string()
}

fn rename(context: &VaultContext, vault: &Vault, from: &str, to: &str) -> MutationOutcome {
    rename_item_inner(
        context,
        &DatabaseRuntimeState::default(),
        &WatcherState::new(),
        &|_, _| {},
        vault.string(from),
        to.to_string(),
    )
    .unwrap()
}

fn move_to(context: &VaultContext, vault: &Vault, from: &str, to: &str) -> MutationOutcome {
    move_item_inner(
        context,
        &DatabaseRuntimeState::default(),
        &WatcherState::new(),
        &|_, _| {},
        vault.string(from),
        vault.string(to),
    )
    .unwrap()
}

fn undo(context: &VaultContext, record: UndoRecord) -> Result<(), StorageErrorCode> {
    undo_mutation_inner(
        context,
        &DatabaseRuntimeState::default(),
        &WatcherState::new(),
        &|_, _| {},
        record,
    )
    .map(|_| ())
    .map_err(|error| error.code)
}

fn record_of(outcome: &MutationOutcome) -> UndoRecord {
    outcome
        .mutation
        .undo
        .clone()
        .expect("a rename or a move that rewrote links is undoable")
}

fn rewritten_count(record: &UndoRecord) -> usize {
    match record {
        UndoRecord::Rename { rewritten, .. } | UndoRecord::Move { rewritten, .. } => {
            rewritten.len()
        }
        UndoRecord::Merge { .. } => 1,
    }
}

#[test]
fn undo_of_a_rename_is_byte_exact_and_keeps_a_link_to_the_new_name() {
    let vault = Vault::new("rename");
    let plan = note(&id(), "amby-title is not set; the plan\n");
    vault.write("Plan.md", &plan);
    // `[[Goal]]` already pointed at the new name before the rename. Rewriting links back would turn
    // it into `[[Plan]]`.
    let linker = crlf_note(
        &id(),
        "See [[Plan]] and [[Goal]].\nAlso [[Plan|the plan]].\n",
    );
    vault.write("Linker.md", &linker);
    let untouched = note(&id(), "Only [[Goal]] here.\n");
    vault.write("Other.md", &untouched);
    let context = activate(&vault);

    let outcome = rename(&context, &vault, "Plan.md", "Goal");
    assert!(vault.path("Goal.md").is_file());
    assert_ne!(vault.read("Linker.md"), linker, "the link was rewritten");
    let record = record_of(&outcome);
    assert_eq!(rewritten_count(&record), 1);

    undo(&context, record).unwrap();

    assert!(!vault.path("Goal.md").exists());
    assert_eq!(vault.read("Plan.md"), plan);
    assert_eq!(vault.read("Linker.md"), linker);
    assert_eq!(vault.read("Other.md"), untouched);
}

#[test]
fn undo_of_a_rename_restores_the_retitled_page() {
    let vault = Vault::new("retitle");
    let plan = format!("---\namby-id: {}\namby-title: Plan\n---\nbody\n", id()).into_bytes();
    vault.write("Plan.md", &plan);
    let linker = note(&id(), "[[Plan]]\n");
    vault.write("Linker.md", &linker);
    let context = activate(&vault);

    let outcome = rename(&context, &vault, "Plan.md", "Goal");
    assert_ne!(
        vault.read("Goal.md"),
        plan,
        "the explicit title followed the name"
    );
    undo(&context, record_of(&outcome)).unwrap();

    assert_eq!(vault.read("Plan.md"), plan);
    assert_eq!(vault.read("Linker.md"), linker);
}

#[test]
fn undo_is_refused_after_a_rewritten_note_was_edited() {
    let vault = Vault::new("edited");
    vault.write("Plan.md", &note(&id(), "plan\n"));
    vault.write("Linker.md", &note(&id(), "See [[Plan]].\n"));
    let context = activate(&vault);

    let outcome = rename(&context, &vault, "Plan.md", "Goal");
    let mut edited = vault.read("Linker.md");
    edited.extend_from_slice(b"A new line typed after the rename.\n");
    vault.write("Linker.md", &edited);

    assert_eq!(
        undo(&context, record_of(&outcome)).unwrap_err(),
        StorageErrorCode::UndoNoteChanged
    );
    assert!(vault.path("Goal.md").is_file(), "nothing was moved back");
    assert!(!vault.path("Plan.md").exists());
    assert_eq!(vault.read("Linker.md"), edited, "the edit is kept");
}

#[test]
fn undo_is_refused_when_the_item_is_no_longer_where_the_rename_left_it() {
    let vault = Vault::new("moved-away");
    vault.write("Plan.md", &note(&id(), "plan\n"));
    let linker = note(&id(), "See [[Plan]].\n");
    vault.write("Linker.md", &linker);
    let context = activate(&vault);

    let outcome = rename(&context, &vault, "Plan.md", "Goal");
    let rewritten = vault.read("Linker.md");
    fs::rename(vault.path("Goal.md"), vault.path("Elsewhere.md")).unwrap();

    assert_eq!(
        undo(&context, record_of(&outcome)).unwrap_err(),
        StorageErrorCode::UndoItemMoved
    );
    assert_eq!(vault.read("Linker.md"), rewritten, "no note was touched");
    assert!(!vault.path("Plan.md").exists());
}

#[test]
fn undo_of_a_folder_move_puts_the_folder_and_every_rewritten_note_back() {
    let vault = Vault::new("folder-move");
    vault.write("Dest/Keep.md", &note(&id(), "keep\n"));
    let inner = note(&id(), "Deep: [[Topic/Sub/Deep]]\n");
    vault.write("Topic/Inner.md", &inner);
    let deep = note(&id(), "deep\n");
    vault.write("Topic/Sub/Deep.md", &deep);
    let outside = crlf_note(&id(), "[[Topic/Inner]] and [[Topic/Sub/Deep|deep]]\n");
    vault.write("Outside.md", &outside);
    let context = activate(&vault);

    let outcome = move_to(&context, &vault, "Topic", "Dest");
    assert!(vault.path("Dest/Topic/Sub/Deep.md").is_file());
    assert_ne!(
        vault.read("Outside.md"),
        outside,
        "path links were rewritten"
    );
    let record = record_of(&outcome);
    assert!(rewritten_count(&record) >= 1);

    undo(&context, record).unwrap();

    assert!(!vault.path("Dest/Topic").exists());
    assert_eq!(vault.read("Topic/Inner.md"), inner);
    assert_eq!(vault.read("Topic/Sub/Deep.md"), deep);
    assert_eq!(vault.read("Outside.md"), outside);
}

/// What the renderer does for a merge: the target's text is saved through the editor's own path
/// (here: written straight to the file), and the source goes away.
fn merge(context: &VaultContext, vault: &Vault, source: &str, target: &str) -> MutationOutcome {
    let snapshot = begin_merge_inner(context, vault.string(target)).unwrap();
    let mut merged = vault.read(target);
    merged.extend_from_slice(b"\nmerged text\n");
    vault.write(target, &merged);
    finish_merge_inner(
        context,
        &DatabaseRuntimeState::default(),
        &WatcherState::new(),
        vault.string(source),
        vault.string(target),
        snapshot,
    )
    .unwrap()
}

#[test]
fn undo_of_a_merge_restores_the_target_and_brings_the_source_back() {
    let vault = Vault::new("merge");
    let source = crlf_note(&id(), "source text\n");
    vault.write("Source.md", &source);
    let target = note(&id(), "target text\n");
    vault.write("Target.md", &target);
    let context = activate(&vault);

    let outcome = merge(&context, &vault, "Source.md", "Target.md");
    assert!(!vault.path("Source.md").exists());
    let record = record_of(&outcome);

    undo(&context, record).unwrap();

    assert_eq!(vault.read("Target.md"), target);
    assert_eq!(vault.read("Source.md"), source);
}

#[test]
fn undo_of_a_merge_is_refused_after_the_target_was_edited() {
    let vault = Vault::new("merge-edited");
    vault.write("Source.md", &note(&id(), "source\n"));
    vault.write("Target.md", &note(&id(), "target\n"));
    let context = activate(&vault);

    let outcome = merge(&context, &vault, "Source.md", "Target.md");
    let mut edited = vault.read("Target.md");
    edited.extend_from_slice(b"typed later\n");
    vault.write("Target.md", &edited);

    assert_eq!(
        undo(&context, record_of(&outcome)).unwrap_err(),
        StorageErrorCode::UndoNoteChanged
    );
    assert_eq!(vault.read("Target.md"), edited);
    assert!(!vault.path("Source.md").exists());
}

#[test]
fn undo_of_a_merge_is_refused_when_the_source_name_is_taken_again() {
    let vault = Vault::new("merge-taken");
    vault.write("Source.md", &note(&id(), "source\n"));
    vault.write("Target.md", &note(&id(), "target\n"));
    let context = activate(&vault);

    let outcome = merge(&context, &vault, "Source.md", "Target.md");
    let merged = vault.read("Target.md");
    let newcomer = note(&id(), "a new note with the old name\n");
    vault.write("Source.md", &newcomer);

    assert_eq!(
        undo(&context, record_of(&outcome)).unwrap_err(),
        StorageErrorCode::UndoItemMoved
    );
    assert_eq!(vault.read("Source.md"), newcomer);
    assert_eq!(vault.read("Target.md"), merged);
}

#[test]
fn undo_of_a_group_rename_puts_the_folder_and_its_main_note_back() {
    let vault = Vault::new("group-rename");
    let main = note(&id(), "main\n");
    vault.write("Plan/Plan.md", &main);
    let child = note(&id(), "Back to [[Plan]].\n");
    vault.write("Plan/Child.md", &child);
    let linker = crlf_note(&id(), "[[Plan]] and [[Plan/Child]]\n");
    vault.write("Linker.md", &linker);
    let context = activate(&vault);

    let outcome = rename(&context, &vault, "Plan/Plan.md", "Goal");
    assert!(vault.path("Goal/Goal.md").is_file());
    undo(&context, record_of(&outcome)).unwrap();

    assert!(!vault.path("Goal").exists());
    assert_eq!(vault.read("Plan/Plan.md"), main);
    assert_eq!(vault.read("Plan/Child.md"), child);
    assert_eq!(vault.read("Linker.md"), linker);
}

#[test]
fn undo_of_a_move_into_a_note_takes_the_note_out_of_its_new_group() {
    let vault = Vault::new("move-into-note");
    let host = note(&id(), "host\n");
    vault.write("Host.md", &host);
    let moved = note(&id(), "moved\n");
    vault.write("Folder/Moved.md", &moved);
    let linker = note(&id(), "[[Folder/Moved]]\n");
    vault.write("Linker.md", &linker);
    let context = activate(&vault);

    let outcome = move_to(&context, &vault, "Folder/Moved.md", "Host.md");
    assert!(vault.path("Host/Moved.md").is_file());
    undo(&context, record_of(&outcome)).unwrap();

    assert!(!vault.path("Host").exists());
    assert_eq!(vault.read("Host.md"), host);
    assert_eq!(vault.read("Folder/Moved.md"), moved);
    assert_eq!(vault.read("Linker.md"), linker);
}
