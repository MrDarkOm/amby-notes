//! Files of note properties between two computers (docs/sync-plan.md, appendix З: З14–З17, З32,
//! З33, З48, З52, З53) against the real engine. Real engine only: the mini-engines do not know the
//! groups. Red until the groups are synchronised (`rules.rs`) and merged (`props_groups`).
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::{Approvals, Direction, StateStore};
use serde_json::{json, Value};

const GROUP: &str = ".amby/properties/prop_3.jsonl";
const MARKS: &str = ".amby/properties/legacy_3.jsonl";
const LAYOUT: &str = ".amby/properties/layout.json";
const LAYOUT_BYTES: &str =
    "{\"groups\":16,\"hash\":\"blake3-first-hex\",\"template\":1,\"version\":1}\n";

/// The line of a note: `props` is name → icon (the only difference used here).
fn rec(id: &str, props: &[(&str, &str)]) -> Value {
    let map: serde_json::Map<String, Value> = props
        .iter()
        .map(|(n, icon)| (n.to_string(), json!({"icon": icon})))
        .collect();
    json!({"id": id, "hint": {"path": "N.md"}, "props": map})
}

/// A file with the lines sorted by `id`.
fn file(recs: &[Value]) -> String {
    let mut sorted: Vec<&Value> = recs.iter().collect();
    sorted.sort_by_key(|r| r["id"].as_str().unwrap().to_string());
    let mut text = String::from("{\"version\":1}\n");
    for r in sorted {
        text.push_str(&serde_json::to_string(r).unwrap());
        text.push('\n');
    }
    text
}

/// A file of notes `(id, icon)`; each note has one property «Заказчик».
fn group(notes: &[(&str, &str)]) -> String {
    file(
        &notes
            .iter()
            .map(|(id, icon)| rec(id, &[("Заказчик", icon)]))
            .collect::<Vec<_>>(),
    )
}

fn icons(text: &str) -> std::collections::BTreeMap<String, String> {
    text.lines()
        .skip(1)
        .map(|l| {
            let v: Value = serde_json::from_str(l).unwrap();
            (
                v["id"].as_str().unwrap().to_string(),
                v["props"]["Заказчик"]["icon"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
            )
        })
        .collect()
}

/// Two synchronised devices with the layout and `GROUP` = notes A, B, C with icon `0`.
fn pair(b: EngineBuilder) -> World {
    let w = two(b);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, LAYOUT, LAYOUT_BYTES);
    w.save(0, GROUP, &group(&[("A", "0"), ("B", "0"), ("C", "0")]));
    w.pass(0);
    w.pass(1);
    w
}

// ----- З14, З48, З53: what travels -----

#[test]
fn groups_marks_and_layout_travel_and_the_local_journal_of_property_edits_does_not() {
    // З14, З28: `.amby/properties/` is synchronised, `.amby/property-ops/` is not (Р4); the old
    // `.amby/properties.json` still is, for the old versions (З18)
    let w = two(Engine::boxed);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, LAYOUT, LAYOUT_BYTES);
    w.save(0, GROUP, &group(&[("A", "0")]));
    w.save(0, ".amby/properties/prop_0.jsonl", &group(&[("B", "0")]));
    w.save(
        0,
        MARKS,
        "{\"version\":1}\n{\"entry\":\"e\",\"id\":\"A\",\"record\":\"r\"}\n",
    );
    w.save(0, ".amby/property-ops/01JABC.json", "{\"op\":\"rename\"}");
    w.save(0, ".amby/properties.json", "{\"version\":1,\"notes\":{}}\n");
    w.pass(0);
    w.pass(1);
    for path in [
        GROUP,
        ".amby/properties/prop_0.jsonl",
        MARKS,
        LAYOUT,
        ".amby/properties.json",
    ] {
        assert!(
            w.read(1, path).is_some(),
            "{path} must reach the other computer"
        );
    }
    assert_eq!(w.read(1, LAYOUT).as_deref(), Some(LAYOUT_BYTES));
    assert!(w.read(1, ".amby/property-ops/01JABC.json").is_none());
    assert!(!w
        .server_files()
        .contains_key(".amby/property-ops/01JABC.json"));
}

// ----- З16, З52: merge by lines -----

#[test]
fn edits_of_different_notes_of_one_file_are_merged_without_a_conflict() {
    // З16, З17, З52: two computers edit two notes — no card
    let w = pair(Engine::boxed);
    w.save(0, GROUP, &group(&[("A", "L"), ("B", "0"), ("C", "0")]));
    w.save(1, GROUP, &group(&[("A", "0"), ("B", "0"), ("C", "R")]));
    w.pass(0);
    let report = w.pass(1);
    assert_eq!(report.merged_paths, vec![GROUP.to_string()]);
    assert!(report.conflicts.is_empty() && w.sets(1).is_empty() && w.old_copies(1).is_empty());
    let merged = icons(&w.read(1, GROUP).unwrap());
    assert_eq!(
        (
            merged["A"].as_str(),
            merged["B"].as_str(),
            merged["C"].as_str()
        ),
        ("L", "0", "R")
    );
    w.pass(0);
    assert_eq!(
        w.read(0, GROUP),
        w.read(1, GROUP),
        "both computers hold the merged bytes"
    );
    assert_eq!(
        w.server_files().get(GROUP).map(|b| text(b)),
        w.read(1, GROUP)
    );
    assert!(w.sets(0).is_empty());
    w.finish(false);
}

#[test]
fn the_history_keeps_the_local_file_that_a_merge_replaced() {
    // З16, Д53: a snapshot with the reason `sync-overwrite`
    let w = pair(Engine::boxed);
    w.save(0, GROUP, &group(&[("A", "L"), ("B", "0"), ("C", "0")]));
    w.save(1, GROUP, &group(&[("A", "0"), ("B", "0"), ("C", "R")]));
    w.pass(0);
    w.pass(1);
    assert!(w.dev(1).fs.history().iter().any(|h| h.path == GROUP));
}

#[test]
fn the_marks_of_old_versions_are_merged_like_the_groups() {
    // З53: `legacy_<x>.jsonl` — lines `{"id","entry","record"}`
    let mark =
        |id: &str, r: &str| format!("{{\"entry\":\"e\",\"id\":\"{id}\",\"record\":\"{r}\"}}\n");
    let file_of = |lines: &[String]| format!("{{\"version\":1}}\n{}", lines.concat());
    let w = two(Engine::boxed);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, MARKS, &file_of(&[mark("A", "r0"), mark("B", "r0")]));
    w.pass(0);
    w.pass(1);
    w.save(0, MARKS, &file_of(&[mark("A", "r1"), mark("B", "r0")]));
    w.save(1, MARKS, &file_of(&[mark("A", "r0"), mark("B", "r2")]));
    w.pass(0);
    let report = w.pass(1);
    assert_eq!(report.merged_paths, vec![MARKS.to_string()]);
    assert_eq!(
        w.read(1, MARKS).unwrap(),
        file_of(&[mark("A", "r1"), mark("B", "r2")])
    );
}

// ----- З17: a conflict of one note -----

#[test]
fn edits_of_one_note_on_both_computers_make_a_set_and_the_server_file_stays() {
    // З17, Г20: all or nothing — the clean edit of another note is not written either
    let w = pair(Engine::boxed);
    w.save(0, GROUP, &group(&[("A", "L"), ("B", "0"), ("C", "0")]));
    w.save(1, GROUP, &group(&[("A", "R"), ("B", "0"), ("C", "R")]));
    w.pass(0);
    let report = w.pass(1);
    assert!(report.merged_paths.is_empty());
    let sets = w.sets(1);
    assert_eq!(sets.len(), 1, "one conflict set for the file");
    assert_eq!(sets[0].path, GROUP);
    assert_eq!(sets[0].kind, "bothEdited");
    assert!(
        sets[0].base.is_some(),
        "the base is kept for the file (З15)"
    );
    let on_path = icons(&w.read(1, GROUP).unwrap());
    assert_eq!(on_path["A"], "L", "the server version holds the path");
    assert_eq!(on_path["C"], "0", "no partial merge");
    assert_eq!(icons(&text(&sets[0].other))["C"], "R");
    w.pass(0);
    assert_eq!(
        w.sets(0).len(),
        1,
        "the set is seen on the other computer too"
    );
}

// ----- З15: the base -----

#[test]
fn a_group_and_a_marks_file_get_a_base_and_layout_json_does_not() {
    // З15, Ж3, З52, З53
    let w = pair(Engine::boxed);
    w.save(0, MARKS, "{\"version\":1}\n");
    w.pass(0);
    w.pass(1);
    let mut state = w.dev(1).state.clone();
    for path in [GROUP, MARKS] {
        let bytes = w.read(1, path).unwrap().into_bytes();
        let item = w.item_at(path).0;
        assert_eq!(
            state.base_get(&item, &blake3_hash(&bytes)).unwrap(),
            Some(bytes),
            "{path}"
        );
    }
    let layout = w.read(1, LAYOUT).unwrap().into_bytes();
    assert_eq!(
        state
            .base_get(&w.item_at(LAYOUT).0, &blake3_hash(&layout))
            .unwrap(),
        None
    );
}

#[test]
fn a_group_over_one_mebibyte_is_still_merged() {
    // З15, З30, Ж3: the limit of a group is 16 000 000 bytes, not the 1 MiB of a note
    let w = two(Engine::boxed);
    w.save(0, "Keep/k.md", "keep");
    let padded = |recs: &str| {
        format!(
            "{{\"pad\":\"{}\",\"version\":1}}\n{recs}",
            "x".repeat(1_500_000)
        )
    };
    let base = padded(
        &group(&[("A", "0"), ("B", "0")])
            .lines()
            .skip(1)
            .map(|l| format!("{l}\n"))
            .collect::<String>(),
    );
    w.save(0, GROUP, &base);
    w.pass(0);
    w.pass(1);
    let with = |a: &str, b: &str| {
        padded(
            &group(&[("A", a), ("B", b)])
                .lines()
                .skip(1)
                .map(|l| format!("{l}\n"))
                .collect::<String>(),
        )
    };
    w.save(0, GROUP, &with("L", "0"));
    w.save(1, GROUP, &with("0", "R"));
    w.pass(0);
    let report = w.pass(1);
    assert_eq!(report.merged_paths, vec![GROUP.to_string()]);
    assert!(w.sets(1).is_empty());
}

// ----- З33: an unreadable side -----

#[test]
fn an_unreadable_incoming_group_is_not_written_and_the_local_one_stays_on_the_path() {
    // З33, З51, Ж26, Ж28: a damaged line sets the whole file apart
    let w = pair(Engine::boxed);
    let damaged = "{\"version\":1}\n{\"id\":\"A\",\"props\":{\"Я\"";
    w.save(0, GROUP, damaged);
    w.pass(0);
    let local = group(&[("A", "0"), ("B", "0"), ("C", "Z")]);
    w.save(1, GROUP, &local);
    let report = w.pass(1);
    assert!(report.merged_paths.is_empty());
    assert_eq!(w.read(1, GROUP).as_deref(), Some(local.as_str()));
    let sets = w.sets(1);
    assert_eq!(sets.len(), 1);
    assert_eq!(sets[0].other, damaged.as_bytes().to_vec());
    w.pass(1);
    assert_eq!(
        w.sets(1).len(),
        1,
        "a repeated pass does not make another set"
    );
}

#[test]
fn an_unreadable_incoming_group_replacing_an_untouched_local_one_is_also_kept_out() {
    // З33
    let w = pair(Engine::boxed);
    let before = w.read(1, GROUP).unwrap();
    w.save(0, GROUP, "\u{0}\u{0}garbage");
    w.pass(0);
    w.pass(1);
    assert_eq!(w.read(1, GROUP).as_deref(), Some(before.as_str()));
    assert_eq!(w.sets(1).len(), 1);
}

// ----- З32: the mass loss is counted over the whole pass -----

fn file_path(g: usize) -> String {
    format!(".amby/properties/prop_{g:x}.jsonl")
}

/// The notes of file `g`: four notes, two properties each.
fn full_file(g: usize) -> String {
    file(
        &(0..4)
            .map(|k| rec(&format!("N{g:x}{k}"), &[("a", "1"), ("b", "1")]))
            .collect::<Vec<_>>(),
    )
}

/// File `g` where the notes `k < lose_b` lose the property «b» and the notes `k < wipe` are gone.
fn thinned_file(g: usize, wipe: usize, lose_b: usize) -> String {
    file(
        &(wipe..4)
            .map(|k| {
                if k < lose_b {
                    rec(&format!("N{g:x}{k}"), &[("a", "1")])
                } else {
                    rec(&format!("N{g:x}{k}"), &[("a", "1"), ("b", "1")])
                }
            })
            .collect::<Vec<_>>(),
    )
}

/// Two computers with 300 notes and the 16 files of 4 notes with 2 properties each (128
/// properties): the storage is large enough that Д54 (by files) lets a change of 16 files go.
fn large(b: EngineBuilder) -> World {
    let w = two(b);
    w.save(0, "Keep/k.md", "keep");
    for i in 0..300 {
        w.save(0, &format!("Bulk/f-{i:03}.md"), &format!("note {i}"));
    }
    w.save(0, LAYOUT, LAYOUT_BYTES);
    for g in 0..16 {
        w.save(0, &file_path(g), &full_file(g));
    }
    w.pass(0);
    w.pass(1);
    assert_eq!(w.dev(1).fs.files().len(), 1 + 300 + 1 + 16);
    w
}

fn approve() -> Approvals {
    Approvals {
        mass_change: true,
        ..Default::default()
    }
}

#[test]
fn properties_vanishing_over_many_files_stop_the_outgoing_pass() {
    // З32, З.10-1 (а): 8 files lose all 4 notes (64 of 128 properties); 8 files of 318 is not a
    // mass change for Д54, so the stop is the one of the properties. Nothing is sent.
    let w = large(Engine::boxed);
    for g in 0..8 {
        w.save(0, &file_path(g), &thinned_file(g, 4, 0));
    }
    let head = w.server_head();
    let StopReason::MassChange { direction, files } = w.stop(0) else {
        panic!("a pass that wipes the properties of 32 notes must stop");
    };
    assert_eq!(direction, Direction::Outgoing);
    let mut paths: Vec<String> = files.into_iter().map(|f| f.path).collect();
    paths.sort();
    assert_eq!(paths, (0..8).map(file_path).collect::<Vec<_>>());
    assert_eq!(w.server_head(), head, "no file was sent");
    let report = w.pass_with(0, approve());
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(w.server_head() > head);
}

#[test]
fn properties_vanishing_over_many_files_stop_the_incoming_pass_and_the_local_files_stay() {
    // З32: «на путях остаются локальные группы»
    let w = large(Engine::boxed);
    for g in 0..8 {
        w.save(0, &file_path(g), &thinned_file(g, 4, 0));
    }
    w.pass_with(0, approve());
    let before = w.dev(1).fs.files();
    let StopReason::MassChange { direction, .. } = w.stop(1) else {
        panic!("the other computer must stop too");
    };
    assert_eq!(direction, Direction::Incoming);
    assert_eq!(
        w.dev(1).fs.files(),
        before,
        "no file of the pass was written"
    );
    w.pass_with(1, approve());
    for g in 0..8 {
        assert_eq!(
            w.read(1, &file_path(g)).as_deref(),
            Some(thinned_file(g, 4, 0).as_str())
        );
    }
}

#[test]
fn nineteen_vanishing_properties_do_not_stop_the_pass() {
    // З32: below twenty — 19 notes of 16 files lose the property «b» (each file has 4 notes)
    let w = large(Engine::boxed);
    let mut left = 19;
    for g in 0..16 {
        let n = left.min(4);
        left -= n;
        if n > 0 {
            w.save(0, &file_path(g), &thinned_file(g, 0, n));
        }
    }
    let head = w.server_head();
    assert_eq!(w.pass(0).outcome, CycleOutcome::Done);
    assert!(w.server_head() > head);
    w.pass(1);
    assert_eq!(
        w.read(1, &file_path(0)).as_deref(),
        Some(thinned_file(0, 0, 4).as_str())
    );
}

#[test]
fn twenty_one_vanishing_properties_in_many_files_stop_the_pass() {
    // З32: the other side of the threshold — 21 of 128 properties, none of the files alone near 20
    let w = large(Engine::boxed);
    let mut left = 21;
    for g in 0..16 {
        let n = left.min(4);
        left -= n;
        if n > 0 {
            w.save(0, &file_path(g), &thinned_file(g, 0, n));
        }
    }
    assert!(matches!(
        w.stop(0),
        StopReason::MassChange {
            direction: Direction::Outgoing,
            ..
        }
    ));
}

#[test]
fn a_merge_that_drops_properties_is_counted_with_the_one_sided_replacements() {
    // З32: merged and replaced files are summed. File 0 is wiped and files 5–7 lose one note on
    // the other computer (14 properties, replaced); files 2–4 are merged with an edit of another
    // note and still lose «b» of all four notes (12 properties). Neither part reaches 20, together
    // they are 26 of about 130
    let w = large(Engine::boxed);
    w.save(0, &file_path(0), &thinned_file(0, 4, 0));
    for g in 5..8 {
        w.save(0, &file_path(g), &thinned_file(g, 1, 0));
    }
    for g in 2..5 {
        w.save(0, &file_path(g), &thinned_file(g, 0, 4));
        // this computer adds a note to the same file: the merge is clean
        let mut recs: Vec<Value> = full_file(g)
            .lines()
            .skip(1)
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        recs.push(rec("Z", &[("x", "1")]));
        w.save(1, &file_path(g), &file(&recs));
    }
    w.pass_with(0, approve());
    assert!(
        matches!(w.stop(1), StopReason::MassChange { .. }),
        "14 + 12 properties together are a mass loss"
    );
}
