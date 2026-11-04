//! Merge of the groups of note properties (docs/sync-plan.md, appendix З: З5, З8, З16, З30, З31):
//! a table of cases. Every case is a base and two sides and is run both ways (local/remote
//! swapped): the merge is symmetric (Ж10 via З30). The unit is the record of a note, by the meaning
//! of the JSON. Red until `props_groups` is written: its bodies are `todo!()` today.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_core::engine::props_groups::{
    canonicalize_group, check_group, group_of, group_path_of, is_group_path, merge_group,
    GroupConflict, GroupMergeOutcome, NotMergeable, GROUP_COUNT, PROPS_MAX_DEPTH,
    PROPS_MERGE_MAX_BYTES,
};
use serde_json::{json, Value};

// ----- builders -----

fn prop_with(id: &str, name: &str, icon: &str) -> Value {
    json!({"id": id, "name": name, "icon": icon, "propertyType": "text", "settings": ""})
}

fn prop(id: &str, name: &str) -> Value {
    prop_with(id, name, "📌")
}

fn entry(props: Vec<Value>) -> Value {
    json!({"hint": {"path": "Заметка.md", "title": "Заметка"}, "properties": props})
}

fn entry_hint(props: Vec<Value>, path: &str) -> Value {
    json!({"hint": {"path": path, "title": "T"}, "properties": props})
}

/// A group file in an arbitrary (not canonical) layout: keys sorted, two-space indent.
fn file(notes: &[(&str, Value)]) -> Vec<u8> {
    let map: serde_json::Map<String, Value> = notes
        .iter()
        .map(|(id, e)| (id.to_string(), e.clone()))
        .collect();
    let mut bytes = serde_json::to_vec_pretty(&json!({"version": 1, "notes": map})).unwrap();
    bytes.push(b'\n');
    bytes
}

fn parsed(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
}

fn notes_of(bytes: &[u8]) -> Value {
    parsed(bytes)["notes"].clone()
}

#[track_caller]
fn run(base: &[u8], local: &[u8], remote: &[u8]) -> GroupMergeOutcome {
    merge_group(base, local, remote)
}

/// The clean result; the swapped call must give the same bytes.
#[track_caller]
fn clean(base: &[u8], local: &[u8], remote: &[u8]) -> Vec<u8> {
    let GroupMergeOutcome::Clean(bytes) = run(base, local, remote) else {
        panic!("expected a clean merge, got {:?}", run(base, local, remote));
    };
    match run(base, remote, local) {
        GroupMergeOutcome::Clean(swapped) => assert_eq!(swapped, bytes, "symmetry"),
        other => panic!("swapped sides gave {other:?}"),
    }
    bytes
}

/// The conflict; the swapped call must give the same one.
#[track_caller]
fn conflict(base: &[u8], local: &[u8], remote: &[u8]) -> GroupConflict {
    let GroupMergeOutcome::Conflict(found) = run(base, local, remote) else {
        panic!("expected a conflict, got {:?}", run(base, local, remote));
    };
    match run(base, remote, local) {
        GroupMergeOutcome::Conflict(swapped) => assert_eq!(swapped, found, "symmetry"),
        other => panic!("swapped sides gave {other:?}"),
    }
    found
}

fn two_notes() -> (Vec<u8>, Value, Value) {
    let a = entry(vec![prop("P1", "Статус")]);
    let b = entry(vec![prop("P2", "Автор")]);
    (file(&[("A", a.clone()), ("B", b.clone())]), a, b)
}

// ----- З5: the path of a group -----

fn first_byte_hex(id: &str) -> String {
    format!("{:02x}", blake3::hash(id.as_bytes()).as_bytes()[0])
}

#[test]
fn the_group_is_the_first_byte_of_blake3_of_the_id_in_two_lowercase_hex_digits() {
    // З5
    for id in [
        "01JABCDEF0123456789ABCDEFG",
        "01JABCDEF0123456789ABCDEFH",
        "я-заметка",
        "",
        "x",
    ] {
        assert_eq!(group_of(id), first_byte_hex(id), "{id:?}");
        assert_eq!(
            group_path_of(id),
            format!(".amby/properties/{}.json", first_byte_hex(id))
        );
    }
    // BLAKE3 of the empty string starts with af 13 49 b9 (the official vector).
    assert_eq!(group_of(""), "af");
}

#[test]
fn ids_with_the_same_time_prefix_spread_over_the_groups() {
    // З5: not the start of the ULID. 5000 ids that share the first 10 characters (the time) must
    // not collapse into a few groups, and 100 000 ids must fill all 256 evenly enough.
    let mut same_time = std::collections::HashSet::new();
    for n in 0..5000u32 {
        same_time.insert(group_of(&format!("01JABCDEFG{n:016}")));
    }
    assert!(same_time.len() > 240, "only {} groups", same_time.len());

    let mut counts = vec![0usize; GROUP_COUNT];
    for n in 0..100_000u32 {
        let g = group_of(&format!("01JABCDE{n:018}"));
        counts[usize::from_str_radix(&g, 16).unwrap()] += 1;
    }
    let (min, max) = (*counts.iter().min().unwrap(), *counts.iter().max().unwrap());
    assert!(
        min > 280 && max < 520,
        "uneven spread: min {min}, max {max} (mean 390)"
    );
}

#[test]
fn only_two_lowercase_hex_digits_in_the_properties_folder_are_a_group() {
    // З30, З6: `layout.json` and everything else is synchronised but not merged.
    for good in [
        ".amby/properties/00.json",
        ".amby/properties/af.json",
        ".amby/properties/9c.json",
    ] {
        assert!(is_group_path(good), "{good}");
    }
    for bad in [
        ".amby/properties/layout.json",
        ".amby/properties/AF.json",
        ".amby/properties/a.json",
        ".amby/properties/abc.json",
        ".amby/properties/ag.json",
        ".amby/properties/af.JSON",
        ".amby/properties/af.json.tmp",
        ".amby/properties/sub/af.json",
        ".amby/properties.json",
        ".amby/property-ops/af.json",
        "properties/af.json",
        "Notes/.amby/properties/af.json",
    ] {
        assert!(!is_group_path(bad), "{bad}");
    }
}

// ----- З16: the unit is the record of a note -----

#[test]
fn a_record_changed_on_one_side_is_taken() {
    // З16: different notes edited on the two sides are both kept
    let (base, a, b) = two_notes();
    let a2 = entry(vec![prop_with("P1", "Статус", "🔥")]);
    let b2 = entry(vec![prop("P2", "Автор"), prop("P3", "Срок")]);
    let local = file(&[("A", a2.clone()), ("B", b)]);
    let remote = file(&[("A", a), ("B", b2.clone())]);
    let merged = clean(&base, &local, &remote);
    assert_eq!(notes_of(&merged), json!({"A": a2, "B": b2}));
}

#[test]
fn a_record_changed_the_same_way_on_both_sides_is_taken_once() {
    // З16
    let (base, _, b) = two_notes();
    let a2 = entry(vec![prop_with("P1", "Статус", "🔥")]);
    let side = file(&[("A", a2.clone()), ("B", b.clone())]);
    let merged = clean(&base, &side, &side);
    assert_eq!(notes_of(&merged), json!({"A": a2, "B": b}));
}

#[test]
fn a_record_changed_in_different_ways_is_a_conflict_of_that_note_only() {
    // З16, З17: everything or nothing; the other records are counted as merged by themselves
    let a = entry(vec![prop("P1", "Статус")]);
    let b = entry(vec![prop("P2", "Автор")]);
    let c = entry(vec![prop("P3", "Срок")]);
    let base = file(&[("A", a.clone()), ("B", b.clone()), ("C", c.clone())]);
    let local = file(&[
        ("A", entry(vec![prop_with("P1", "Статус", "🔥")])),
        ("B", entry(vec![prop_with("P2", "Автор", "👤")])),
        ("C", c),
    ]);
    let remote = file(&[
        ("A", entry(vec![prop_with("P1", "Статус", "⭐")])),
        ("B", b),
        ("C", entry(vec![prop_with("P3", "Срок", "⏰")])),
    ]);
    let found = conflict(&base, &local, &remote);
    assert_eq!(found.notes, vec!["A".to_string()]);
    assert_eq!(found.auto_merged, 2, "B from local and C from remote");
}

#[test]
fn two_properties_of_one_note_edited_on_different_sides_are_still_a_conflict() {
    // З16: no merge inside a note (it may be added later without a change of format)
    let base = file(&[("A", entry(vec![prop("P1", "Статус"), prop("P2", "Автор")]))]);
    let local = file(&[(
        "A",
        entry(vec![prop_with("P1", "Статус", "🔥"), prop("P2", "Автор")]),
    )]);
    let remote = file(&[(
        "A",
        entry(vec![prop("P1", "Статус"), prop_with("P2", "Автор", "👤")]),
    )]);
    assert_eq!(
        conflict(&base, &local, &remote).notes,
        vec!["A".to_string()]
    );
}

#[test]
fn deleting_a_record_against_editing_it_is_a_conflict_of_that_note() {
    // З16
    let (base, a, b) = two_notes();
    let deleted = file(&[("B", b.clone())]);
    let edited = file(&[
        ("A", entry(vec![prop_with("P1", "Статус", "🔥")])),
        ("B", b),
    ]);
    assert_eq!(
        conflict(&base, &deleted, &edited).notes,
        vec!["A".to_string()]
    );
    let _ = a;
}

#[test]
fn deleting_a_record_the_other_side_did_not_touch_deletes_it() {
    // З16
    let (base, _, b) = two_notes();
    let deleted = file(&[("B", b.clone())]);
    let merged = clean(&base, &deleted, &base);
    assert_eq!(notes_of(&merged), json!({"B": b}));
}

#[test]
fn both_sides_deleting_the_same_record_deletes_it() {
    // З16
    let (base, _, b) = two_notes();
    let deleted = file(&[("B", b.clone())]);
    assert_eq!(notes_of(&clean(&base, &deleted, &deleted)), json!({"B": b}));
}

#[test]
fn different_new_records_are_both_kept() {
    // З16
    let (base, a, b) = two_notes();
    let c = entry(vec![prop("P3", "Срок")]);
    let d = entry(vec![prop("P4", "Цвет")]);
    let local = file(&[("A", a.clone()), ("B", b.clone()), ("C", c.clone())]);
    let remote = file(&[("A", a.clone()), ("B", b.clone()), ("D", d.clone())]);
    assert_eq!(
        notes_of(&clean(&base, &local, &remote)),
        json!({"A": a, "B": b, "C": c, "D": d})
    );
}

#[test]
fn a_record_added_by_both_is_one_when_equal_and_a_conflict_when_different() {
    // З16, З31: no such record in the base
    let (base, a, b) = two_notes();
    let c = entry(vec![prop("P3", "Срок")]);
    let same = file(&[("A", a.clone()), ("B", b.clone()), ("C", c.clone())]);
    assert_eq!(
        notes_of(&clean(&base, &same, &same)),
        json!({"A": a.clone(), "B": b.clone(), "C": c})
    );
    let c2 = entry(vec![prop("P9", "Другое")]);
    let other = file(&[("A", a), ("B", b), ("C", c2)]);
    assert_eq!(conflict(&base, &same, &other).notes, vec!["C".to_string()]);
}

#[test]
fn an_empty_base_and_a_missing_notes_object_entries_are_ordinary() {
    // З16: the first group of a vault: nothing in the base, one new record on each side
    let base = file(&[]);
    let a = entry(vec![prop("P1", "Статус")]);
    let b = entry(vec![prop("P2", "Автор")]);
    let merged = clean(
        &base,
        &file(&[("A", a.clone())]),
        &file(&[("B", b.clone())]),
    );
    assert_eq!(notes_of(&merged), json!({"A": a, "B": b}));
}

// ----- З31: hint and dismissedRenames take no part in the decision -----

#[test]
fn a_hint_changed_on_one_side_never_conflicts_with_the_properties_on_the_other() {
    // З31
    let props = vec![prop("P1", "Статус")];
    let base = file(&[("A", entry_hint(props.clone(), "Старый.md"))]);
    let local = file(&[("A", entry_hint(props, "Новый.md"))]);
    let remote = file(&[(
        "A",
        entry_hint(vec![prop_with("P1", "Статус", "🔥")], "Старый.md"),
    )]);
    let merged = notes_of(&clean(&base, &local, &remote));
    assert_eq!(
        merged["A"],
        entry_hint(vec![prop_with("P1", "Статус", "🔥")], "Новый.md")
    );
}

#[test]
fn hints_changed_in_different_ways_take_the_one_with_the_smaller_canonical_json() {
    // З31: deterministic and symmetric; the canonical JSON of the hint is `{"path":…,"title":…}`
    let props = vec![prop("P1", "Статус")];
    let base = file(&[("A", entry_hint(props.clone(), "Старый.md"))]);
    let local = file(&[("A", entry_hint(props.clone(), "Б.md"))]);
    let remote = file(&[("A", entry_hint(props.clone(), "А.md"))]);
    let merged = notes_of(&clean(&base, &local, &remote));
    assert_eq!(merged["A"], entry_hint(props, "А.md"));
}

#[test]
fn equal_new_records_with_different_hints_are_one_record() {
    // З31: added by both, equal without the hint
    let base = file(&[]);
    let props = vec![prop("P1", "Статус")];
    let local = file(&[("A", entry_hint(props.clone(), "Б.md"))]);
    let remote = file(&[("A", entry_hint(props.clone(), "А.md"))]);
    let merged = notes_of(&clean(&base, &local, &remote));
    assert_eq!(merged["A"], entry_hint(props, "А.md"));
}

#[test]
fn dismissed_renames_are_merged_as_a_set_and_never_conflict() {
    // З31, З44: a refusal on one computer and a new icon on the other give no conflict card
    let props = vec![prop("P1", "Статус")];
    let with = |pairs: Value, props: Vec<Value>| {
        let mut e = entry(props);
        e["dismissedRenames"] = pairs;
        e
    };
    let base = file(&[("A", with(json!([["Статус", "Состояние"]]), props.clone()))]);
    // local adds a pair, remote changes the icon
    let local = file(&[(
        "A",
        with(
            json!([["Статус", "Состояние"], ["Автор", "Создатель"]]),
            props.clone(),
        ),
    )]);
    let remote_props = vec![prop_with("P1", "Статус", "🔥")];
    let remote = file(&[(
        "A",
        with(json!([["Статус", "Состояние"]]), remote_props.clone()),
    )]);
    let merged = notes_of(&clean(&base, &local, &remote));
    assert_eq!(merged["A"]["properties"], json!(remote_props));
    let mut pairs: Vec<Value> = merged["A"]["dismissedRenames"].as_array().unwrap().clone();
    pairs.sort_by_key(|p| p.to_string());
    assert_eq!(
        pairs,
        vec![
            json!(["Автор", "Создатель"]),
            json!(["Статус", "Состояние"])
        ]
    );

    // both add different pairs: the union; one side removes a pair the other did not touch: gone
    let base2 = file(&[("A", with(json!([["a", "b"], ["c", "d"]]), props.clone()))]);
    let l2 = file(&[("A", with(json!([["c", "d"], ["e", "f"]]), props.clone()))]);
    let r2 = file(&[(
        "A",
        with(json!([["a", "b"], ["c", "d"], ["g", "h"]]), props),
    )]);
    let merged2 = notes_of(&clean(&base2, &l2, &r2));
    let mut pairs2: Vec<String> = merged2["A"]["dismissedRenames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.to_string())
        .collect();
    pairs2.sort();
    assert_eq!(pairs2, vec![r#"["c","d"]"#, r#"["e","f"]"#, r#"["g","h"]"#]);
}

#[test]
fn the_legacy_mark_is_compared_together_with_the_properties() {
    // З31, З36: unlike hint, `legacy` is part of the decision
    let props = vec![prop("P1", "Статус")];
    let mark = |record: &str| {
        let mut e = entry(props.clone());
        e["legacy"] = json!({"entry": "aa", "record": record});
        e
    };
    let base = file(&[("A", mark("r0"))]);
    let local = file(&[("A", mark("r1"))]);
    let remote = file(&[("A", entry(vec![prop_with("P1", "Статус", "🔥")]))]);
    assert_eq!(
        conflict(&base, &local, &remote).notes,
        vec!["A".to_string()]
    );
    // both sides add the same note with the same properties but a different mark: a conflict
    let empty = file(&[]);
    assert_eq!(
        conflict(
            &empty,
            &file(&[("A", mark("r1"))]),
            &file(&[("A", mark("r2"))])
        )
        .notes,
        vec!["A".to_string()]
    );
    // the same mark on one side only is taken
    let merged = notes_of(&clean(&base, &local, &base));
    assert_eq!(merged["A"]["legacy"]["record"], "r1");
}

// ----- З2, З16: unknown fields -----

#[test]
fn unknown_fields_of_the_file_the_record_and_the_property_are_kept() {
    // З2, З16: a newer Amby wrote them; the merge does not lose them
    let mut p = prop("P1", "Статус");
    p["color"] = json!("red");
    let mut e = entry(vec![p]);
    e["future"] = json!({"deep": [1, 2, {"x": null}]});
    let mut base_v =
        json!({"version": 1, "notes": {"A": e.clone(), "B": entry(vec![prop("P2", "Автор")])}});
    base_v["top"] = json!("kept");
    let to_bytes = |v: &Value| {
        let mut b = serde_json::to_vec_pretty(v).unwrap();
        b.push(b'\n');
        b
    };
    let base = to_bytes(&base_v);
    let mut local_v = base_v.clone();
    local_v["notes"]["B"] = entry(vec![prop("P2", "Автор"), prop("P3", "Срок")]);
    let merged = parsed(&clean(&base, &to_bytes(&local_v), &to_bytes(&base_v)));
    assert_eq!(merged["notes"]["A"], e);
    assert_eq!(merged["top"], "kept");
    assert_eq!(merged["notes"]["B"], local_v["notes"]["B"]);
}

#[test]
fn an_unknown_top_level_field_is_one_record_that_conflicts_when_changed_differently() {
    // З16: changed on one side — taken; on both differently — a conflict (of no note)
    let (b0, _, _) = two_notes();
    let mut base_v = parsed(&b0);
    base_v["top"] = json!(1);
    let to_bytes = |v: &Value| serde_json::to_vec_pretty(v).unwrap();
    let mut l = base_v.clone();
    l["top"] = json!(2);
    let mut r = base_v.clone();
    r["top"] = json!(3);
    let merged = parsed(&clean(
        &to_bytes(&base_v),
        &to_bytes(&l),
        &to_bytes(&base_v),
    ));
    assert_eq!(merged["top"], 2);
    let found = conflict(&to_bytes(&base_v), &to_bytes(&l), &to_bytes(&r));
    assert!(found.notes.is_empty());
}

// ----- З30: admission -----

fn valid() -> Vec<u8> {
    file(&[("A", entry(vec![prop("P1", "Статус")]))])
}

/// Bytes that must not pass the admission check, with the reason.
fn bad_versions() -> Vec<(&'static str, Vec<u8>)> {
    let valid_entry = r#"{"hint":{"path":"a.md","title":"a"},"properties":[{"id":"P1","name":"N","icon":"i","propertyType":"text","settings":""}]}"#;
    let wrap = |notes: &str| format!(r#"{{"version":1,"notes":{notes}}}"#).into_bytes();
    let with_props = |props: &str| wrap(&format!(r#"{{"A":{{"properties":{props}}}}}"#));
    let prop = |fields: &str| format!(r#"[{{{fields}}}]"#);
    let deep = |n: usize| {
        let nested = format!("{}{}", "[".repeat(n), "]".repeat(n));
        wrap(&format!(r#"{{"A":{{"properties":[],"future":{nested}}}}}"#))
    };
    vec![
        ("not utf-8", {
            let mut b = valid();
            b.insert(5, 0xFF);
            b
        }),
        ("a NUL byte", {
            let mut b = valid();
            b.insert(5, 0x00);
            b
        }),
        ("not json", b"{not json".to_vec()),
        ("empty file", Vec::new()),
        ("an array", b"[]".to_vec()),
        ("a number", b"1".to_vec()),
        (
            "duplicate top-level key",
            br#"{"version":1,"notes":{},"notes":{}}"#.to_vec(),
        ),
        (
            "duplicate note id",
            wrap(&format!(r#"{{"A":{valid_entry},"A":{valid_entry}}}"#)),
        ),
        (
            "duplicate field in a property",
            with_props(r#"[{"id":"P1","name":"N","name":"M"}]"#),
        ),
        ("version 2", br#"{"version":2,"notes":{}}"#.to_vec()),
        (
            "version a string",
            br#"{"version":"1","notes":{}}"#.to_vec(),
        ),
        ("version missing", br#"{"notes":{}}"#.to_vec()),
        ("notes an array", br#"{"version":1,"notes":[]}"#.to_vec()),
        ("notes missing", br#"{"version":1}"#.to_vec()),
        ("record not an object", wrap(r#"{"A":[]}"#)),
        (
            "properties not an array",
            wrap(r#"{"A":{"properties":{}}}"#),
        ),
        ("property not an object", with_props(r#"["x"]"#)),
        (
            "known field not a string",
            with_props(&prop(r#""id":"P1","name":5"#)),
        ),
        (
            "icon not a string",
            with_props(&prop(r#""id":"P1","name":"N","icon":null"#)),
        ),
        ("empty id", with_props(&prop(r#""id":"","name":"N""#))),
        (
            "repeated id in a record",
            with_props(r#"[{"id":"P1","name":"N"},{"id":"P1","name":"M"}]"#),
        ),
        (
            "repeated name in a record",
            with_props(r#"[{"id":"P1","name":"Статус"},{"id":"P2","name":"статус"}]"#),
        ),
        (
            "repeated name differing in ASCII case",
            with_props(r#"[{"id":"P1","name":"Status"},{"id":"P2","name":"STATUS"}]"#),
        ),
        (
            "an unknown value nested too deep",
            deep(PROPS_MAX_DEPTH + 40),
        ),
    ]
}

#[test]
fn every_reason_of_the_admission_check_refuses_the_version_in_any_of_the_three_places() {
    // З30: base, local, remote; no repair, no merge
    let good = valid();
    for (label, bad) in bad_versions() {
        assert!(check_group(&bad).is_err(), "{label}: check_group");
        for place in 0..3 {
            let mut versions = [good.clone(), good.clone(), good.clone()];
            versions[place] = bad.clone();
            let outcome = merge_group(&versions[0], &versions[1], &versions[2]);
            assert!(
                matches!(outcome, GroupMergeOutcome::NotMergeable(_)),
                "{label} in place {place}: {outcome:?}"
            );
        }
    }
}

#[test]
fn a_file_with_a_valid_shape_and_unknown_values_passes_the_check() {
    // З30, З2: unknown fields of any kind are allowed (up to the depth limit)
    assert!(check_group(&valid()).is_ok());
    let nested = format!("{}{}", "[".repeat(20), "]".repeat(20));
    let text = format!(
        r#"{{"version":1,"notes":{{"A":{{"properties":[],"future":{nested},"n":1.0}}}},"top":{{"x":[true,null,"é"]}}}}"#
    );
    assert!(check_group(text.as_bytes()).is_ok());
    // the same name in different notes, and the same name apart from the case of non-ASCII letters
    let ok = file(&[
        ("A", entry(vec![prop("P1", "Статус")])),
        ("B", entry(vec![prop("P1", "Статус")])),
        ("C", entry(vec![prop("P1", "Статус"), prop("P2", "статус")])),
    ]);
    assert!(check_group(&ok).is_ok(), "case folding is ASCII only (З2)");
}

#[test]
fn a_version_over_sixteen_million_bytes_is_not_merged_and_exactly_the_limit_is() {
    // З30, PROPS_MERGE_MAX_BYTES
    assert_eq!((PROPS_MERGE_MAX_BYTES, GROUP_COUNT), (16_000_000, 256));
    let pad = |total: usize| {
        let head = br#"{"version":1,"notes":{},"pad":""#;
        let tail = br#""}"#;
        let mut bytes = head.to_vec();
        bytes.resize(total - tail.len(), b'a');
        bytes.extend_from_slice(tail);
        assert_eq!(bytes.len(), total);
        bytes
    };
    let at_limit = pad(PROPS_MERGE_MAX_BYTES);
    let over = pad(PROPS_MERGE_MAX_BYTES + 1);
    assert!(check_group(&at_limit).is_ok());
    assert_eq!(check_group(&over), Err(NotMergeable::TooLarge));
    let small = valid();
    for place in 0..3 {
        let mut versions = [small.clone(), small.clone(), small.clone()];
        versions[place] = over.clone();
        assert_eq!(
            merge_group(&versions[0], &versions[1], &versions[2]),
            GroupMergeOutcome::NotMergeable(NotMergeable::TooLarge),
            "place {place}"
        );
    }
}

// ----- З30, Ж11: short paths return the bytes of a side -----

#[test]
fn equal_sides_return_the_local_bytes_untouched_even_when_not_canonical() {
    // З30 (Ж11): the merge does not rewrite what it does not have to
    let base = valid();
    let a = b"{ \"version\" : 1,\t\"notes\":{\"A\":{\"properties\":[{\"id\":\"P1\",\"name\":\"\xd0\xa1\xd1\x82\",\"icon\":\"i\",\"propertyType\":\"text\",\"settings\":\"\"}]}}}".to_vec();
    let a_same_meaning = serde_json::to_vec(&parsed(&a)).unwrap();
    assert_eq!(
        merge_group(&base, &a, &a_same_meaning),
        GroupMergeOutcome::Clean(a.clone()),
        "local and remote equal by meaning: the local bytes"
    );
}

#[test]
fn a_side_equal_to_the_base_gives_the_bytes_of_the_other_side() {
    // З30 (Ж11)
    let base = valid();
    let edited = b"{\"version\":1,\"notes\":{}}".to_vec();
    assert_eq!(
        merge_group(&base, &base, &edited),
        GroupMergeOutcome::Clean(edited.clone())
    );
    assert_eq!(
        merge_group(&base, &edited, &base),
        GroupMergeOutcome::Clean(edited.clone())
    );
    // a side reformatted but equal by meaning to the base: the other side's bytes are taken
    let reformatted = serde_json::to_vec(&parsed(&base)).unwrap();
    assert_eq!(
        merge_group(&base, &reformatted, &edited),
        GroupMergeOutcome::Clean(edited.clone())
    );
    assert_eq!(
        merge_group(&base, &edited, &reformatted),
        GroupMergeOutcome::Clean(edited)
    );
}

#[test]
fn the_admission_check_comes_before_the_short_paths() {
    // З30: a damaged base is refused even when local and remote are equal
    let good = valid();
    assert!(matches!(
        merge_group(b"garbage", &good, &good),
        GroupMergeOutcome::NotMergeable(_)
    ));
}

// ----- З8, З30: canonical form, BOM, line endings -----

const CANONICAL_ONE: &str = "{\n  \"version\": 1,\n  \"notes\": {\n    \"A\": {\n      \"hint\": {\n        \"path\": \"Заметка.md\",\n        \"title\": \"Заметка\"\n      },\n      \"properties\": [\n        {\n          \"id\": \"P1\",\n          \"name\": \"Статус\",\n          \"icon\": \"📌\",\n          \"propertyType\": \"select\",\n          \"settings\": \"Идея,Готово\"\n        }\n      ]\n    }\n  }\n}\n";

fn select_prop() -> Value {
    json!({"id": "P1", "name": "Статус", "icon": "📌", "propertyType": "select", "settings": "Идея,Готово"})
}

#[test]
fn a_real_merge_writes_the_canonical_form_byte_for_byte() {
    // З8, З30: two-space indent, notes ascending, fields in the order of the structure, one line
    // feed at the end
    let base = file(&[("A", entry(vec![select_prop()]))]);
    let local = file(&[
        ("A", entry(vec![select_prop()])),
        ("Z", entry(vec![prop("P9", "Z")])),
    ]);
    let remote = file(&[
        ("A", entry(vec![select_prop()])),
        ("B", entry(vec![prop("P8", "B")])),
    ]);
    let merged = clean(&base, &local, &remote);
    let text = String::from_utf8(merged).unwrap();
    assert!(text.starts_with("{\n  \"version\": 1,\n  \"notes\": {\n    \"A\": {\n      \"hint\": {\n        \"path\": \"Заметка.md\",\n        \"title\": \"Заметка\"\n      },\n      \"properties\": [\n        {\n          \"id\": \"P1\",\n          \"name\": \"Статус\",\n          \"icon\": \"📌\",\n          \"propertyType\": \"select\",\n          \"settings\": \"Идея,Готово\"\n        }\n      ]\n    },\n    \"B\": {"), "{text}");
    assert!(text.find("\"B\"").unwrap() < text.find("\"Z\"").unwrap());
    assert!(text.ends_with("}\n") && !text.ends_with("\n\n"));
}

#[test]
fn canonicalize_gives_the_documented_bytes_and_is_idempotent() {
    // З8: the example of З7 in its canonical form
    let input = file(&[("A", entry(vec![select_prop()]))]);
    let once = canonicalize_group(&input).unwrap();
    assert_eq!(String::from_utf8(once.clone()).unwrap(), CANONICAL_ONE);
    assert_eq!(canonicalize_group(&once).unwrap(), once, "idempotent");
    assert!(canonicalize_group(b"garbage").is_err());
}

#[test]
fn a_merge_result_does_not_change_when_canonicalised_again() {
    // З8, З30, Ж13: the app writes the same bytes after reading the merge
    let (base, a, b) = two_notes();
    let local = file(&[
        ("A", entry(vec![prop_with("P1", "Статус", "🔥")])),
        ("B", b),
    ]);
    let remote = file(&[
        ("A", a),
        ("B", entry(vec![prop("P2", "Автор"), prop("P3", "Срок")])),
    ]);
    let merged = clean(&base, &local, &remote);
    assert_eq!(canonicalize_group(&merged).unwrap(), merged);
}

#[test]
fn a_merge_twice_gives_the_same_bytes() {
    // З30 (Г18): deterministic, so a retry after a crash gives the same result
    let (base, a, b) = two_notes();
    let local = file(&[
        ("A", entry(vec![prop_with("P1", "Статус", "🔥")])),
        ("B", b.clone()),
    ]);
    let remote = file(&[
        ("A", a),
        ("B", entry(vec![prop("P2", "Автор"), prop("P3", "Срок")])),
    ]);
    assert_eq!(clean(&base, &local, &remote), clean(&base, &local, &remote));
    let _ = b;
}

fn bom(mut bytes: Vec<u8>) -> Vec<u8> {
    let mut with = vec![0xEF, 0xBB, 0xBF];
    with.append(&mut bytes);
    with
}

fn crlf(bytes: &[u8]) -> Vec<u8> {
    String::from_utf8(bytes.to_vec())
        .unwrap()
        .replace('\n', "\r\n")
        .into_bytes()
}

fn merge_inputs() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let (base, _, b) = two_notes();
    let local = file(&[
        ("A", entry(vec![prop_with("P1", "Статус", "🔥")])),
        ("B", b.clone()),
    ]);
    let remote = file(&[
        ("A", entry(vec![prop("P1", "Статус")])),
        ("B", entry(vec![prop("P2", "Автор"), prop("P3", "Срок")])),
    ]);
    (base, local, remote)
}

#[test]
fn the_bom_is_kept_when_both_sides_have_it_and_follows_the_side_that_changed_it() {
    // З30 (Ж14)
    let (base, local, remote) = merge_inputs();
    let has_bom = |b: &[u8]| b.starts_with(&[0xEF, 0xBB, 0xBF]);
    // all three have it
    assert!(has_bom(&clean(
        &bom(base.clone()),
        &bom(local.clone()),
        &bom(remote.clone())
    )));
    // none has it
    assert!(!has_bom(&clean(&base, &local, &remote)));
    // base without BOM, one side added it: it stays
    assert!(has_bom(&clean(&base, &bom(local.clone()), &remote)));
    // base with BOM, one side dropped it: gone
    assert!(!has_bom(&clean(
        &bom(base.clone()),
        &local,
        &bom(remote.clone())
    )));
    // both added it
    assert!(has_bom(&clean(&base, &bom(local), &bom(remote))));
}

#[test]
fn the_line_ending_follows_the_rules_of_the_file_form() {
    // З30 (Ж14): both CRLF — CRLF; one side changed it against the base — that one
    let (base, local, remote) = merge_inputs();
    let all_crlf = |b: &[u8]| {
        let t = String::from_utf8_lossy(b);
        t.matches('\n').count() > 0 && t.matches("\r\n").count() == t.matches('\n').count()
    };
    let none_crlf = |b: &[u8]| !String::from_utf8_lossy(b).contains('\r');
    assert!(all_crlf(&clean(
        &crlf(&base),
        &crlf(&local),
        &crlf(&remote)
    )));
    assert!(
        all_crlf(&clean(&base, &crlf(&local), &remote)),
        "local changed it"
    );
    assert!(
        none_crlf(&clean(&crlf(&base), &local, &crlf(&remote))),
        "local changed it back"
    );
    assert!(none_crlf(&clean(&base, &local, &remote)));
}
