//! The last edit wins (docs/sync-plan.md, appendix З: З70). A note edited differently on two
//! computers is not a conflict when its lines carry `edited` (milliseconds of the last edit): the
//! later line is taken. Lines without time on both sides keep the conflict of З17. Every case is
//! run both ways: the merge stays symmetric. Red until З70 is written.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;

use amby_sync_core::engine::props_groups::{merge_group, GroupKind, GroupMergeOutcome};
use serde_json::{json, Value};

const P: GroupKind = GroupKind::Props;
const L: GroupKind = GroupKind::Legacy;

/// The line of note `id` with one property «Статус» of icon `icon`, edited at `edited` (ms).
fn rec(id: &str, icon: &str, edited: Option<u64>) -> Value {
    let mut line =
        json!({"hint": {"path": "Заметка.md"}, "id": id, "props": {"Статус": {"icon": icon}}});
    if let Some(at) = edited {
        line["edited"] = json!(at);
    }
    line
}

fn file(recs: &[Value]) -> Vec<u8> {
    let mut sorted: Vec<&Value> = recs.iter().collect();
    sorted.sort_by_key(|r| r["id"].as_str().unwrap().to_string());
    let mut text = String::from("{\"version\":1}\n");
    for r in sorted {
        text.push_str(&serde_json::to_string(r).unwrap());
        text.push('\n');
    }
    text.into_bytes()
}

fn by_id(bytes: &[u8]) -> BTreeMap<String, Value> {
    String::from_utf8(bytes.to_vec())
        .unwrap()
        .lines()
        .skip(1)
        .map(|l| {
            let v: Value = serde_json::from_str(l).unwrap();
            (v["id"].as_str().unwrap().to_string(), v)
        })
        .collect()
}

/// The clean result, the same both ways.
#[track_caller]
fn clean(kind: GroupKind, base: &[u8], local: &[u8], remote: &[u8]) -> BTreeMap<String, Value> {
    let GroupMergeOutcome::Clean(bytes) = merge_group(kind, base, local, remote) else {
        panic!(
            "expected a clean merge, got {:?}",
            merge_group(kind, base, local, remote)
        );
    };
    match merge_group(kind, base, remote, local) {
        GroupMergeOutcome::Clean(swapped) => assert_eq!(swapped, bytes, "symmetry"),
        other => panic!("swapped sides gave {other:?}"),
    }
    by_id(&bytes)
}

#[track_caller]
fn conflicting(kind: GroupKind, base: &[u8], local: &[u8], remote: &[u8]) -> Vec<String> {
    let GroupMergeOutcome::Conflict(found) = merge_group(kind, base, local, remote) else {
        panic!(
            "expected a conflict, got {:?}",
            merge_group(kind, base, local, remote)
        );
    };
    match merge_group(kind, base, remote, local) {
        GroupMergeOutcome::Conflict(swapped) => assert_eq!(swapped, found, "symmetry"),
        other => panic!("swapped sides gave {other:?}"),
    }
    found.notes
}

#[test]
fn the_later_edit_of_a_note_wins_without_a_conflict() {
    // З70: the Mac set the sheet at 1000, the PC the smile at 2000 — the smile stays
    let base = file(&[rec("A", "0", None)]);
    let mac = file(&[rec("A", "emoji:📝", Some(1_000))]);
    let pc = file(&[rec("A", "emoji:😲", Some(2_000))]);
    let merged = clean(P, &base, &mac, &pc);
    assert_eq!(merged["A"]["props"]["Статус"]["icon"], "emoji:😲");
    assert_eq!(merged["A"]["edited"], 2_000, "the winner keeps its time");
}

#[test]
fn the_later_edit_wins_on_either_side_and_other_notes_still_merge() {
    // З70, З15: the local side is later here; B changed on one side only merges as before
    let base = file(&[rec("A", "0", None), rec("B", "0", None)]);
    let local = file(&[rec("A", "L", Some(5_000)), rec("B", "0", None)]);
    let remote = file(&[rec("A", "R", Some(4_000)), rec("B", "R", Some(4_500))]);
    let merged = clean(P, &base, &local, &remote);
    assert_eq!(merged["A"]["props"]["Статус"]["icon"], "L");
    assert_eq!(merged["B"]["props"]["Статус"]["icon"], "R");
}

#[test]
fn a_line_with_a_time_beats_a_line_without_one() {
    // З70: an edit of an old version carries no time and loses to one that has it
    let base = file(&[rec("A", "0", None)]);
    let old_version = file(&[rec("A", "old", None)]);
    let new_version = file(&[rec("A", "new", Some(1))]);
    let merged = clean(P, &base, &old_version, &new_version);
    assert_eq!(merged["A"]["props"]["Статус"]["icon"], "new");
}

#[test]
fn equal_times_are_settled_by_the_text_the_same_way_on_both_computers() {
    // З70: a tie takes the line whose text is greater byte by byte; symmetric
    let base = file(&[rec("A", "0", None)]);
    let left = file(&[rec("A", "aaa", Some(7))]);
    let right = file(&[rec("A", "zzz", Some(7))]);
    let merged = clean(P, &base, &left, &right);
    assert_eq!(merged["A"]["props"]["Статус"]["icon"], "zzz");
}

#[test]
fn an_edit_with_a_time_beats_the_removal_of_the_line() {
    // З70: one side removed the line, the other edited it — the edit stays (no data lost)
    let base = file(&[rec("A", "0", None), rec("B", "0", None)]);
    let removed = file(&[rec("B", "0", None)]);
    let edited = file(&[rec("A", "R", Some(10)), rec("B", "0", None)]);
    let merged = clean(P, &base, &removed, &edited);
    assert_eq!(merged["A"]["props"]["Статус"]["icon"], "R");
}

#[test]
fn lines_that_differ_only_by_the_time_merge_without_a_conflict() {
    // З70: `edited` is not part of the meaning: the same change made on both sides is one change
    let base = file(&[rec("A", "0", None)]);
    let left = file(&[rec("A", "same", Some(1))]);
    let right = file(&[rec("A", "same", Some(2))]);
    let merged = clean(P, &base, &left, &right);
    assert_eq!(merged["A"]["props"]["Статус"]["icon"], "same");
}

#[test]
fn without_a_time_on_both_sides_the_note_is_still_a_conflict() {
    // З70: both edits were made by an old version — the choice of З17 stays
    let base = file(&[rec("A", "0", None)]);
    let left = file(&[rec("A", "L", None)]);
    let right = file(&[rec("A", "R", None)]);
    assert_eq!(conflicting(P, &base, &left, &right), vec!["A".to_string()]);
}

#[test]
fn the_marks_of_old_versions_are_not_settled_by_time() {
    // З70 applies to `prop_<x>.jsonl` only; `legacy_<x>.jsonl` keeps its sets
    let mark = |r: &str, at: u64| json!({"edited": at, "entry": "e", "id": "A", "record": r});
    let base = file(&[json!({"entry": "e", "id": "A", "record": "0"})]);
    let left = file(&[mark("l", 1)]);
    let right = file(&[mark("r", 2)]);
    assert_eq!(conflicting(L, &base, &left, &right), vec!["A".to_string()]);
}
