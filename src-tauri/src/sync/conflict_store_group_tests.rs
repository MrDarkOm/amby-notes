//! The choice by notes for a conflict of a group of note properties (docs/sync-plan.md, appendix
//! З: З17, З64а, З69). The files of the sets are built by hand, as in `conflict_store_tests.rs`.
//! Red until written: `read_group` and `Resolution::Notes` are `todo!()` today.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{BTreeMap, BTreeSet};

use amby_sync_core::crypto::primitives::blake3_hash;
use serde_json::{json, Value};

use super::conflict_store::{
    ConflictError, ConflictStore, FileConflictStore, GroupConflictNote, GroupPropertyChange,
    NotePick, PropertyLook, Resolution,
};
use super::test_support::TempVault;

const ID: &str = "0123456789ab";
const ITEM: &str = "d4e73ba99658c22f9c501b589feeddb5";
const GROUP: &str = ".amby/properties/prop_3.jsonl";
const MARKS: &str = ".amby/properties/legacy_3.jsonl";
const EMPTY: &str = "{\"version\":1}\n";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The line of a note: one property «Заказчик» with `icon`; the note lies at `path`.
fn line(id: &str, icon: &str, path: &str) -> Value {
    json!({"hint": {"path": path}, "id": id, "props": {"Заказчик": {"icon": icon}}})
}

/// A group file from `(id, icon)`; the path of note `X` is `Папка/X-заметка.md`.
fn group(notes: &[(&str, &str)]) -> String {
    let mut sorted: Vec<&(&str, &str)> = notes.iter().collect();
    sorted.sort();
    let mut text = String::from(EMPTY);
    for (id, icon) in sorted {
        let path = format!("Папка/{id}-заметка.md");
        text.push_str(&serde_json::to_string(&line(id, icon, &path)).unwrap());
        text.push('\n');
    }
    text
}

/// The icon of every note of a group file.
fn icons(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .skip(1)
        .map(|l| {
            let v: Value = serde_json::from_str(l).unwrap();
            (
                v["id"].as_str().unwrap().to_string(),
                v["props"]["Заказчик"]["icon"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn make_set(vault: &TempVault, kind: &str, path: &str, other: &[u8], base: Option<&[u8]>) {
    let dir = format!(".amby/conflicts/{ID}");
    vault.put(&format!("{dir}/other.jsonl"), other);
    let (base_name, base_hash) = match base {
        Some(bytes) => {
            vault.put(&format!("{dir}/base.jsonl"), bytes);
            (
                "\"base.jsonl\"".to_string(),
                format!("\"{}\"", hex(&blake3_hash(bytes))),
            )
        }
        None => ("null".into(), "null".into()),
    };
    let meta = format!(
        "{{\"v\":1,\"id\":\"{ID}\",\"kind\":\"{kind}\",\"item_id\":\"{ITEM}\",\"path\":{},\"other\":\"other.jsonl\",\"other_hash\":\"{}\",\"other_size\":{},\"base\":{base_name},\"base_hash\":{base_hash}}}",
        serde_json::to_string(path).unwrap(),
        hex(&blake3_hash(other)),
        other.len()
    );
    vault.put(&format!("{dir}/meta.json"), meta.as_bytes());
}

fn store(vault: &TempVault) -> FileConflictStore {
    FileConflictStore::new(vault.root.clone(), BTreeMap::new(), BTreeSet::new())
}

fn set_files(vault: &TempVault) -> Vec<String> {
    vault
        .files()
        .into_keys()
        .filter(|p| p.starts_with(".amby/conflicts/"))
        .collect()
}

/// Base A0 B0 C0; on the path A:L B:L C0; the other A:R B0 C:R — A conflicts, B and C merge.
fn vault_with_a_group_set() -> TempVault {
    let vault = TempVault::new("group-conflicts");
    vault.put(
        GROUP,
        group(&[("A", "L"), ("B", "L"), ("C", "0")]).as_bytes(),
    );
    make_set(
        &vault,
        "bothEdited",
        GROUP,
        group(&[("A", "R"), ("B", "0"), ("C", "R")]).as_bytes(),
        Some(group(&[("A", "0"), ("B", "0"), ("C", "0")]).as_bytes()),
    );
    vault
}

fn look(icon: &str) -> PropertyLook {
    PropertyLook {
        icon: Some(icon.into()),
        ..PropertyLook::default()
    }
}

/// A group file from whole lines, sorted by `id`.
fn group_of_lines(lines: &[Value]) -> String {
    let mut sorted: Vec<&Value> = lines.iter().collect();
    sorted.sort_by_key(|l| l["id"].as_str().unwrap().to_string());
    let mut text = String::from(EMPTY);
    for l in sorted {
        text.push_str(&serde_json::to_string(l).unwrap());
        text.push('\n');
    }
    text
}

fn picks(items: &[(&str, NotePick)]) -> BTreeMap<String, NotePick> {
    items.iter().map(|(id, p)| (id.to_string(), *p)).collect()
}

// ----- the list of notes -----

#[test]
fn the_conflict_of_a_group_lists_only_the_notes_changed_differently_on_both_sides() {
    // З17, З69: one line per conflicting note with its path and name; the rest merged by itself
    let vault = vault_with_a_group_set();
    let view = store(&vault).read_group(ID).unwrap();
    assert_eq!(
        view.notes,
        vec![GroupConflictNote {
            note_id: "A".into(),
            note_path: Some("Папка/A-заметка.md".into()),
            note_title: Some("A-заметка".into()),
            changes: vec![GroupPropertyChange {
                name: "Заказчик".into(),
                current: Some(look("L")),
                other: Some(look("R")),
            }],
            order_differs: false,
            current_removed: false,
            other_removed: false,
        }]
    );
    assert_eq!(view.auto_merged, 2, "B and C merged by themselves");
}

#[test]
fn the_path_of_a_note_removed_on_this_computer_comes_from_the_other_version() {
    // З69: the line on the path goes first; when it is not there, the second version's
    let vault = TempVault::new("group-conflicts");
    vault.put(GROUP, group(&[("B", "0")]).as_bytes());
    make_set(
        &vault,
        "bothEdited",
        GROUP,
        group(&[("A", "R"), ("B", "0")]).as_bytes(),
        Some(group(&[("A", "0"), ("B", "0")]).as_bytes()),
    );
    let view = store(&vault).read_group(ID).unwrap();
    assert_eq!(view.notes.len(), 1);
    assert_eq!(view.notes[0].note_id, "A");
    assert_eq!(
        view.notes[0].note_path.as_deref(),
        Some("Папка/A-заметка.md")
    );
}

#[test]
fn a_set_of_the_first_meeting_has_the_empty_base_and_is_chosen_by_notes_too() {
    // З64а, З69: base `{"version":1}`; lines added on one side only merge by themselves
    let vault = TempVault::new("group-conflicts");
    vault.put(GROUP, group(&[("A", "L"), ("B", "0")]).as_bytes());
    make_set(
        &vault,
        "bothCreated",
        GROUP,
        group(&[("A", "R"), ("C", "R")]).as_bytes(),
        Some(EMPTY.as_bytes()),
    );
    let view = store(&vault).read_group(ID).unwrap();
    assert_eq!(
        view.notes
            .iter()
            .map(|n| n.note_id.as_str())
            .collect::<Vec<_>>(),
        vec!["A"]
    );
    store(&vault)
        .resolve(
            ID,
            Resolution::Notes {
                picks: picks(&[("A", NotePick::Current)]),
            },
        )
        .unwrap();
    let got = icons(&vault.text(GROUP).unwrap());
    assert_eq!(got["A"], "L");
    assert_eq!(got["B"], "0");
    assert_eq!(got["C"], "R", "the line of the other computer is not lost");
}

#[test]
fn the_files_of_the_marks_of_the_old_format_are_chosen_by_notes_too() {
    // З69: `legacy_<x>.jsonl` is a group as well
    let vault = TempVault::new("group-conflicts");
    let mark =
        |id: &str, r: &str| format!("{{\"entry\":\"e\",\"id\":\"{id}\",\"record\":\"{r}\"}}\n");
    let file = |lines: &[String]| format!("{EMPTY}{}", lines.concat());
    vault.put(MARKS, file(&[mark("A", "l"), mark("B", "l")]).as_bytes());
    make_set(
        &vault,
        "bothEdited",
        MARKS,
        file(&[mark("A", "r"), mark("B", "0")]).as_bytes(),
        Some(file(&[mark("A", "0"), mark("B", "0")]).as_bytes()),
    );
    let view = store(&vault).read_group(ID).unwrap();
    assert_eq!(view.notes.len(), 1);
    assert_eq!(view.notes[0].note_id, "A");
    assert_eq!(view.notes[0].note_path, None, "marks have no hint");
    assert_eq!(view.notes[0].note_title, None);
}

// ----- not a group -----

#[test]
fn a_set_without_a_base_is_not_chosen_by_notes() {
    // З69: there is nothing to merge against; the person chooses a whole file
    let vault = TempVault::new("group-conflicts");
    let current = group(&[("A", "L")]);
    vault.put(GROUP, current.as_bytes());
    make_set(
        &vault,
        "bothCreated",
        GROUP,
        group(&[("A", "R")]).as_bytes(),
        None,
    );
    let before = vault.files();
    assert_eq!(
        store(&vault).read_group(ID).unwrap_err(),
        ConflictError::NotGroup
    );
    assert_eq!(
        store(&vault)
            .resolve(
                ID,
                Resolution::Notes {
                    picks: picks(&[("A", NotePick::Other)]),
                },
            )
            .unwrap_err(),
        ConflictError::NotGroup
    );
    assert_eq!(vault.files(), before, "nothing changed");
}

#[test]
fn a_note_is_not_a_group() {
    // З69: a conflict of a Markdown note is resolved as before
    let vault = TempVault::new("group-conflicts");
    vault.put("Notes/n.md", b"current\n");
    make_set(
        &vault,
        "bothEdited",
        "Notes/n.md",
        b"other\n",
        Some(b"base\n"),
    );
    assert_eq!(
        store(&vault).read_group(ID).unwrap_err(),
        ConflictError::NotGroup
    );
    assert_eq!(
        store(&vault)
            .resolve(
                ID,
                Resolution::Notes {
                    picks: BTreeMap::new()
                }
            )
            .unwrap_err(),
        ConflictError::NotGroup
    );
    assert_eq!(vault.text("Notes/n.md").as_deref(), Some("current\n"));
}

#[test]
fn a_damaged_version_is_not_chosen_by_notes_and_nothing_is_written() {
    // З33, З69: one unreadable line sets the whole file apart
    let vault = TempVault::new("group-conflicts");
    let current = group(&[("A", "L")]);
    vault.put(GROUP, current.as_bytes());
    make_set(
        &vault,
        "bothEdited",
        GROUP,
        b"{\"version\":1}\n{\"id\":\"A\",\"props\":",
        Some(group(&[("A", "0")]).as_bytes()),
    );
    let before = vault.files();
    assert_eq!(
        store(&vault).read_group(ID).unwrap_err(),
        ConflictError::NotGroup
    );
    assert_eq!(
        store(&vault)
            .resolve(
                ID,
                Resolution::Notes {
                    picks: picks(&[("A", NotePick::Current)]),
                },
            )
            .unwrap_err(),
        ConflictError::NotGroup
    );
    assert_eq!(vault.files(), before);
}

#[test]
fn an_unknown_conflict_is_not_found() {
    let vault = TempVault::new("group-conflicts");
    assert_eq!(
        store(&vault).read_group(ID).unwrap_err(),
        ConflictError::NotFound
    );
}

// ----- the resolution -----

#[test]
fn the_other_side_of_a_conflicting_note_keeps_the_merged_lines_of_both_computers() {
    // З17, З69: the pick decides only A; B from this computer and C from the other stay
    let vault = vault_with_a_group_set();
    let before = vault.text(GROUP).unwrap();
    store(&vault)
        .resolve(
            ID,
            Resolution::Notes {
                picks: picks(&[("A", NotePick::Other)]),
            },
        )
        .unwrap();
    let got = icons(&vault.text(GROUP).unwrap());
    assert_eq!(got["A"], "R");
    assert_eq!(got["B"], "L", "the edit of this computer is not lost");
    assert_eq!(got["C"], "R", "the edit of the other computer is not lost");
    assert!(
        vault
            .snapshots(GROUP)
            .iter()
            .any(|(reason, text)| reason == "sync-overwrite" && *text == before),
        "the replaced file is in the history: {:?}",
        vault.snapshots(GROUP)
    );
    assert!(set_files(&vault).is_empty(), "the set went to the trash");
    assert!(store(&vault).list().unwrap().is_empty());
}

#[test]
fn this_side_of_a_conflicting_note_keeps_the_merged_lines_too() {
    let vault = vault_with_a_group_set();
    store(&vault)
        .resolve(
            ID,
            Resolution::Notes {
                picks: picks(&[("A", NotePick::Current)]),
            },
        )
        .unwrap();
    let got = icons(&vault.text(GROUP).unwrap());
    assert_eq!(
        (got["A"].as_str(), got["B"].as_str(), got["C"].as_str()),
        ("L", "L", "R")
    );
}

#[test]
fn the_result_is_a_valid_group_in_the_canonical_form() {
    // З49, З52: lines sorted by id, the first line kept, a line feed at the end
    let vault = vault_with_a_group_set();
    store(&vault)
        .resolve(
            ID,
            Resolution::Notes {
                picks: picks(&[("A", NotePick::Other)]),
            },
        )
        .unwrap();
    let text = vault.text(GROUP).unwrap();
    assert!(text.starts_with(EMPTY));
    assert!(text.ends_with('\n'));
    assert!(amby_sync_core::engine::props_groups::check_group(
        amby_sync_core::engine::props_groups::GroupKind::Props,
        text.as_bytes()
    )
    .is_ok());
    assert_eq!(
        amby_sync_core::engine::props_groups::canonicalize_group(
            amby_sync_core::engine::props_groups::GroupKind::Props,
            text.as_bytes()
        )
        .unwrap(),
        text.as_bytes()
    );
}

#[test]
fn a_missing_pick_writes_nothing() {
    // З17: every conflicting note must have a pick
    let vault = vault_with_a_group_set();
    let before = vault.files();
    for given in [picks(&[]), picks(&[("B", NotePick::Other)])] {
        assert_eq!(
            store(&vault)
                .resolve(ID, Resolution::Notes { picks: given })
                .unwrap_err(),
            ConflictError::IncompletePicks
        );
        assert_eq!(vault.files(), before, "nothing changed");
    }
}

#[test]
fn a_pick_for_a_note_that_does_not_conflict_changes_nothing_of_it() {
    // З69: only the conflicting notes are decided by the picks; the clean merge wins for the rest
    let vault = vault_with_a_group_set();
    store(&vault)
        .resolve(
            ID,
            Resolution::Notes {
                picks: picks(&[
                    ("A", NotePick::Current),
                    ("B", NotePick::Other),
                    ("C", NotePick::Current),
                ]),
            },
        )
        .unwrap();
    let got = icons(&vault.text(GROUP).unwrap());
    assert_eq!(
        (got["A"].as_str(), got["B"].as_str(), got["C"].as_str()),
        ("L", "L", "R")
    );
}

// ----- what differs (З69: the person sees what they choose) -----

#[test]
fn only_the_properties_that_differ_are_shown_with_both_looks() {
    // З69: a property equal on both sides is not shown; one changed only there has `None` here
    let vault = TempVault::new("group-conflicts");
    let hint = json!({"path": "Идея.md"});
    let mine = json!({"hint": hint, "id": "A", "props": {
        "Статус": {"icon": "lucide:star", "propertyType": "select", "settings": "{\"options\":[\"a\"]}"},
        "Жанр": {"icon": "lucide:book"},
    }});
    let theirs = json!({"hint": hint, "id": "A", "props": {
        "Статус": {"icon": "emoji:📘"},
        "Жанр": {"icon": "lucide:book"},
        "Автор": {"icon": "lucide:user"},
    }});
    let base = json!({"hint": hint, "id": "A", "props": {"Жанр": {"icon": "lucide:book"}}});
    vault.put(GROUP, group_of_lines(&[mine]).as_bytes());
    make_set(
        &vault,
        "bothEdited",
        GROUP,
        group_of_lines(&[theirs]).as_bytes(),
        Some(group_of_lines(&[base]).as_bytes()),
    );
    let view = store(&vault).read_group(ID).unwrap();
    assert_eq!(view.notes.len(), 1);
    let note = &view.notes[0];
    assert_eq!(
        note.changes,
        vec![
            GroupPropertyChange {
                name: "Автор".into(),
                current: None,
                other: Some(look("lucide:user")),
            },
            GroupPropertyChange {
                name: "Статус".into(),
                current: Some(PropertyLook {
                    icon: Some("lucide:star".into()),
                    property_type: Some("select".into()),
                    settings: Some("{\"options\":[\"a\"]}".into()),
                }),
                other: Some(look("emoji:📘")),
            },
        ],
        "«Жанр» is the same on both computers"
    );
    assert!(!note.order_differs);
    assert!(!note.current_removed && !note.other_removed);
}

#[test]
fn a_changed_order_and_a_removed_line_are_told() {
    // З69: the order of the properties is a difference too; a line gone from one side is said
    let vault = TempVault::new("group-conflicts");
    let props = json!({"Статус": {"icon": "lucide:star"}, "Жанр": {"icon": "lucide:book"}});
    let line_of = |id: &str, order: &[&str]| json!({"hint": {"path": format!("{id}.md")}, "id": id, "props": props, "order": order});
    let base_b =
        json!({"hint": {"path": "B.md"}, "id": "B", "props": {"Жанр": {"icon": "lucide:x"}}});
    let changed_b =
        json!({"hint": {"path": "B.md"}, "id": "B", "props": {"Жанр": {"icon": "lucide:y"}}});
    vault.put(
        GROUP,
        group_of_lines(&[line_of("A", &["Статус", "Жанр"])]).as_bytes(),
    );
    make_set(
        &vault,
        "bothEdited",
        GROUP,
        group_of_lines(&[line_of("A", &["Жанр", "Статус"]), changed_b]).as_bytes(),
        Some(group_of_lines(&[line_of("A", &["Жанр"]), base_b]).as_bytes()),
    );
    let view = store(&vault).read_group(ID).unwrap();
    let ids: Vec<&str> = view.notes.iter().map(|n| n.note_id.as_str()).collect();
    assert_eq!(ids, vec!["A", "B"]);
    let a = &view.notes[0];
    assert!(a.order_differs);
    assert!(
        a.changes.is_empty(),
        "the looks are the same, only the order"
    );
    let b = &view.notes[1];
    assert!(b.current_removed, "this computer removed the line of B");
    assert!(!b.other_removed);
    assert_eq!(
        b.changes,
        vec![GroupPropertyChange {
            name: "Жанр".into(),
            current: None,
            other: Some(look("lucide:y")),
        }]
    );
}
