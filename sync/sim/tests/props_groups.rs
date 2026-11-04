//! Groups of note properties between two computers (docs/sync-plan.md, appendix З: З14–З17, З32,
//! З33) against the real engine. Real engine only: the mini-engines do not know the groups. Red
//! until the groups are synchronised (`rules.rs`) and merged (`props_groups`).
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::{Approvals, Direction, StateStore};
use serde_json::{json, Value};

const GROUP: &str = ".amby/properties/3f.json";
const LAYOUT: &str = ".amby/properties/layout.json";
const LAYOUT_BYTES: &str = "{\"version\":1,\"groups\":256,\"hash\":\"blake3-first-byte\"}\n";

fn prop(id: &str, name: &str, icon: &str) -> Value {
    json!({"id": id, "name": name, "icon": icon, "propertyType": "text", "settings": ""})
}

/// A group file with notes `(id, icon)`; each note has one property.
fn group(notes: &[(&str, &str)]) -> String {
    let map: serde_json::Map<String, Value> = notes
        .iter()
        .map(|(id, icon)| {
            (
                id.to_string(),
                json!({"hint": {"path": "N.md", "title": "N"},
                       "properties": [prop(&format!("P-{id}"), "Статус", icon)]}),
            )
        })
        .collect();
    let mut text = serde_json::to_string_pretty(&json!({"version": 1, "notes": map})).unwrap();
    text.push('\n');
    text
}

fn notes_in(text: &str) -> Value {
    serde_json::from_str::<Value>(text).unwrap()["notes"].clone()
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

// ----- З14: what travels -----

#[test]
fn groups_and_layout_travel_and_the_local_journal_of_property_edits_does_not() {
    // З14, З28: `.amby/properties/` is synchronised, `.amby/property-ops/` is not (Р4); the old
    // `.amby/properties.json` still is, for the old versions (З18)
    let w = two(Engine::boxed);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, LAYOUT, LAYOUT_BYTES);
    w.save(0, GROUP, &group(&[("A", "0")]));
    w.save(0, ".amby/properties/00.json", &group(&[("B", "0")]));
    w.save(0, ".amby/property-ops/01JABC.json", "{\"op\":\"rename\"}");
    w.save(0, ".amby/properties.json", "{\"version\":1,\"notes\":{}}\n");
    w.pass(0);
    w.pass(1);
    for path in [
        GROUP,
        ".amby/properties/00.json",
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

// ----- З16: merge by notes -----

#[test]
fn edits_of_different_notes_of_one_group_are_merged_without_a_conflict() {
    // З16, З17: the point of the groups: two computers edit two notes — no card
    let w = pair(Engine::boxed);
    w.save(0, GROUP, &group(&[("A", "L"), ("B", "0"), ("C", "0")]));
    w.save(1, GROUP, &group(&[("A", "0"), ("B", "0"), ("C", "R")]));
    w.pass(0);
    let report = w.pass(1);
    assert_eq!(report.merged_paths, vec![GROUP.to_string()]);
    assert!(report.conflicts.is_empty() && w.sets(1).is_empty() && w.old_copies(1).is_empty());
    let merged = notes_in(&w.read(1, GROUP).unwrap());
    let icon = |id: &str| {
        merged[id]["properties"][0]["icon"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(
        (icon("A"), icon("B"), icon("C")),
        ("L".into(), "0".into(), "R".into())
    );
    w.pass(0);
    assert_eq!(
        w.read(0, GROUP),
        w.read(1, GROUP),
        "both computers hold the merged bytes"
    );
    assert_eq!(
        w.server_files().get(GROUP).map(|b| text(b)),
        w.read(1, GROUP),
        "the merged file went up"
    );
    assert!(w.sets(0).is_empty());
    w.finish(false);
}

#[test]
fn the_history_keeps_the_local_group_that_a_merge_replaced() {
    // З16, Д53: a snapshot with the reason `sync-overwrite`
    let w = pair(Engine::boxed);
    w.save(0, GROUP, &group(&[("A", "L"), ("B", "0"), ("C", "0")]));
    w.save(1, GROUP, &group(&[("A", "0"), ("B", "0"), ("C", "R")]));
    w.pass(0);
    w.pass(1);
    assert!(
        w.dev(1).fs.history().iter().any(|h| h.path == GROUP),
        "the replaced local group is in the history"
    );
}

// ----- З17: a conflict of one note -----

#[test]
fn edits_of_one_note_on_both_computers_make_a_set_and_the_server_group_stays() {
    // З17, Г20: all or nothing — the clean edit of another note is not written either
    let w = pair(Engine::boxed);
    w.save(0, GROUP, &group(&[("A", "L"), ("B", "0"), ("C", "0")]));
    w.save(1, GROUP, &group(&[("A", "R"), ("B", "0"), ("C", "R")]));
    w.pass(0);
    let report = w.pass(1);
    assert!(report.merged_paths.is_empty());
    let sets = w.sets(1);
    assert_eq!(sets.len(), 1, "one conflict set for the group");
    assert_eq!(sets[0].path, GROUP);
    assert_eq!(sets[0].kind, "bothEdited");
    assert!(
        sets[0].base.is_some(),
        "the base is kept for the group (З15)"
    );
    let on_path = notes_in(&w.read(1, GROUP).unwrap());
    assert_eq!(
        on_path["A"]["properties"][0]["icon"], "L",
        "the server version holds the path"
    );
    assert_eq!(
        on_path["C"]["properties"][0]["icon"], "0",
        "no partial merge"
    );
    assert_eq!(
        notes_in(&text(&sets[0].other))["C"]["properties"][0]["icon"],
        "R"
    );
    w.pass(0);
    assert_eq!(
        w.sets(0).len(),
        1,
        "the set is seen on the other computer too"
    );
}

// ----- З15: the base -----

#[test]
fn a_group_gets_a_base_and_layout_json_does_not() {
    // З15, Ж3, З30: bases are kept for the groups, not for `layout.json`
    let w = pair(Engine::boxed);
    let item_of = |path: &str| {
        let w: &World = &w;
        w.item_at(path).0
    };
    let group_bytes = w.read(1, GROUP).unwrap().into_bytes();
    let layout_bytes = w.read(1, LAYOUT).unwrap().into_bytes();
    let mut state = w.dev(1).state.clone();
    assert_eq!(
        state
            .base_get(&item_of(GROUP), &blake3_hash(&group_bytes))
            .unwrap(),
        Some(group_bytes)
    );
    assert_eq!(
        state
            .base_get(&item_of(LAYOUT), &blake3_hash(&layout_bytes))
            .unwrap(),
        None
    );
}

#[test]
fn a_group_over_one_mebibyte_is_still_merged() {
    // З15, З30, Ж3: the limit of a group is 16 000 000 bytes, not the 1 MiB of a note
    let w = two(Engine::boxed);
    w.save(0, "Keep/k.md", "keep");
    let filler = "x".repeat(1_500_000);
    let big = |icon: &str, note: &str| {
        let mut value: Value = serde_json::from_str(&group(&[("A", "0"), ("B", "0")])).unwrap();
        value["pad"] = json!(filler);
        value["notes"][note]["properties"][0]["icon"] = json!(icon);
        serde_json::to_string_pretty(&value).unwrap()
    };
    w.save(0, GROUP, &big("0", "A"));
    w.pass(0);
    w.pass(1);
    let base_text = w.read(1, GROUP).unwrap();
    let mut a: Value = serde_json::from_str(&base_text).unwrap();
    let mut b: Value = a.clone();
    a["notes"]["A"]["properties"][0]["icon"] = json!("L");
    b["notes"]["B"]["properties"][0]["icon"] = json!("R");
    w.save(0, GROUP, &serde_json::to_string_pretty(&a).unwrap());
    w.save(1, GROUP, &serde_json::to_string_pretty(&b).unwrap());
    w.pass(0);
    let report = w.pass(1);
    assert_eq!(report.merged_paths, vec![GROUP.to_string()]);
    assert!(w.sets(1).is_empty());
}

// ----- З33: an unreadable side -----

#[test]
fn an_unreadable_incoming_group_is_not_written_and_the_local_one_stays_on_the_path() {
    // З33, Ж26, Ж28: a set, and the readable local file on the path
    let w = pair(Engine::boxed);
    w.save(0, GROUP, "{ this is not json");
    w.pass(0);
    let local = group(&[("A", "0"), ("B", "0"), ("C", "Z")]);
    w.save(1, GROUP, &local);
    let report = w.pass(1);
    assert!(report.merged_paths.is_empty());
    assert_eq!(w.read(1, GROUP).as_deref(), Some(local.as_str()));
    let sets = w.sets(1);
    assert_eq!(sets.len(), 1);
    assert_eq!(sets[0].other, b"{ this is not json".to_vec());
    // a repeated pass does not make another set
    w.pass(1);
    assert_eq!(w.sets(1).len(), 1);
}

#[test]
fn an_unreadable_incoming_group_replacing_an_untouched_local_one_is_also_kept_out() {
    // З33: «локальная проходит — не пишется на путь»
    let w = pair(Engine::boxed);
    let before = w.read(1, GROUP).unwrap();
    w.save(0, GROUP, "\u{0}\u{0}garbage");
    w.pass(0);
    w.pass(1);
    assert_eq!(w.read(1, GROUP).as_deref(), Some(before.as_str()));
    assert_eq!(w.sets(1).len(), 1);
}

// ----- З32: the mass loss is counted over the whole pass -----

/// Two computers with 300 notes and 30 groups, each holding one note with two properties: the
/// storage is large enough that Д54 (by files) lets a change of 25 files go, and the groups alone
/// carry 60 properties.
fn large(b: EngineBuilder) -> World {
    let w = two(b);
    w.save(0, "Keep/k.md", "keep");
    for i in 0..300 {
        w.save(0, &format!("Bulk/f-{i:03}.md"), &format!("note {i}"));
    }
    w.save(0, LAYOUT, LAYOUT_BYTES);
    for g in 0..30 {
        w.save(0, &two_prop_group(g, true), &two_prop_body(g, true));
    }
    w.pass(0);
    w.pass(1);
    assert_eq!(w.dev(1).fs.files().len(), 1 + 300 + 1 + 30);
    w
}

fn two_prop_group(g: usize, _full: bool) -> String {
    format!(".amby/properties/{g:02x}.json")
}

fn two_prop_body(g: usize, full: bool) -> String {
    let id = format!("N{g:02}");
    let props = if full {
        vec![
            prop(&format!("{id}a"), "a", "1"),
            prop(&format!("{id}b"), "b", "1"),
        ]
    } else {
        Vec::new()
    };
    let notes = if full {
        json!({id: {"hint": {"path": "N.md", "title": "N"}, "properties": props}})
    } else {
        json!({})
    };
    serde_json::to_string_pretty(&json!({"version": 1, "notes": notes})).unwrap() + "\n"
}

#[test]
fn properties_vanishing_over_many_groups_stop_the_outgoing_pass() {
    // З32, З.10-1 (а): 25 groups lose their notes (50 of 60 properties); 25 files of 332 is not a
    // mass change for Д54, so the stop is the one of the properties. Nothing is sent.
    let w = large(Engine::boxed);
    for g in 0..25 {
        w.save(0, &two_prop_group(g, false), &two_prop_body(g, false));
    }
    let head = w.server_head();
    let StopReason::MassChange { direction, files } = w.stop(0) else {
        panic!("a pass that wipes the properties of 25 notes must stop");
    };
    assert_eq!(direction, Direction::Outgoing);
    let mut paths: Vec<String> = files.into_iter().map(|f| f.path).collect();
    paths.sort();
    assert_eq!(
        paths,
        (0..25)
            .map(|g| two_prop_group(g, false))
            .collect::<Vec<_>>()
    );
    assert_eq!(w.server_head(), head, "no group was sent");
    // the owner says "go on"
    let report = w.pass_with(
        0,
        Approvals {
            mass_change: true,
            ..Default::default()
        },
    );
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(w.server_head() > head);
}

#[test]
fn properties_vanishing_over_many_groups_stop_the_incoming_pass_and_the_local_groups_stay() {
    // З32: «на путях остаются локальные группы»
    let w = large(Engine::boxed);
    for g in 0..25 {
        w.save(0, &two_prop_group(g, false), &two_prop_body(g, false));
    }
    w.pass_with(
        0,
        Approvals {
            mass_change: true,
            ..Default::default()
        },
    );
    let before = w.dev(1).fs.files();
    let StopReason::MassChange { direction, .. } = w.stop(1) else {
        panic!("the other computer must stop too");
    };
    assert_eq!(direction, Direction::Incoming);
    assert_eq!(
        w.dev(1).fs.files(),
        before,
        "no group of the pass was written"
    );
    w.pass_with(
        1,
        Approvals {
            mass_change: true,
            ..Default::default()
        },
    );
    for g in 0..25 {
        assert_eq!(
            w.read(1, &two_prop_group(g, false)).as_deref(),
            Some(two_prop_body(g, false).as_str())
        );
    }
}

#[test]
fn nineteen_vanishing_properties_do_not_stop_the_pass() {
    // З32: below twenty. 9 groups of 2 properties and one of 1
    let w = large(Engine::boxed);
    for g in 0..9 {
        w.save(0, &two_prop_group(g, false), &two_prop_body(g, false));
    }
    let mut one_less: Value = serde_json::from_str(&two_prop_body(9, true)).unwrap();
    one_less["notes"]["N09"]["properties"]
        .as_array_mut()
        .unwrap()
        .pop();
    w.save(
        0,
        &two_prop_group(9, true),
        &serde_json::to_string_pretty(&one_less).unwrap(),
    );
    let head = w.server_head();
    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert!(w.server_head() > head);
    w.pass(1);
    assert_eq!(
        w.read(1, &two_prop_group(0, false)).as_deref(),
        Some(two_prop_body(0, false).as_str())
    );
}

#[test]
fn a_merge_that_drops_properties_is_counted_with_the_one_sided_replacements() {
    // З32: merged and replaced groups are summed. 9 groups wiped on the other computer (18
    // properties) and 5 merged with an edit of another note (10 more): neither part reaches 20,
    // together they are 28 of about 65
    let w = large(Engine::boxed);
    for g in 0..9 {
        w.save(0, &two_prop_group(g, false), &two_prop_body(g, false));
    }
    for g in 9..14 {
        // dev 0 empties the note, dev 1 adds a new note to the same group: a clean merge that
        // still removes two properties
        w.save(0, &two_prop_group(g, false), &two_prop_body(g, false));
        let mut value: Value = serde_json::from_str(&two_prop_body(g, true)).unwrap();
        value["notes"]["Extra"] = json!({"properties": [prop("X", "x", "1")]});
        w.save(
            1,
            &two_prop_group(g, true),
            &serde_json::to_string_pretty(&value).unwrap(),
        );
    }
    w.pass_with(
        0,
        Approvals {
            mass_change: true,
            ..Default::default()
        },
    );
    assert!(
        matches!(w.stop(1), StopReason::MassChange { .. }),
        "18 + 10 properties together are a mass loss"
    );
}
