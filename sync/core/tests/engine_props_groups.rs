//! Merge of the files of note properties (docs/sync-plan.md, appendix З: З16, З30, З31, З45–З53):
//! a table of cases. A file is JSON Lines: `{"version":1}` and one line per note, sorted by `id`.
//! Every case is a base and two sides and is run both ways (local/remote swapped): the merge is
//! symmetric (Ж10 via З30). The unit is the line of a note, by the meaning of the JSON. Red until
//! `props_groups` is written: its bodies are `todo!()` today.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;

use amby_sync_core::engine::props_groups::{
    canonicalize_group, check_group, group_of, group_path_of, kind_of_path, legacy_path_of,
    merge_group, GroupConflict, GroupKind, GroupMergeOutcome, NotMergeable, GROUP_COUNT,
    PROPS_MAX_DEPTH, PROPS_MERGE_MAX_BYTES,
};
use serde_json::{json, Value};

const P: GroupKind = GroupKind::Props;
const L: GroupKind = GroupKind::Legacy;

// ----- builders -----

fn diff(icon: &str) -> Value {
    json!({"icon": icon})
}

/// The line of a note: `props` is name → differences from the template.
fn rec(id: &str, props: &[(&str, Value)]) -> Value {
    rec_hint(id, props, "Заметка.md")
}

fn rec_hint(id: &str, props: &[(&str, Value)], path: &str) -> Value {
    let map: serde_json::Map<String, Value> = props
        .iter()
        .map(|(n, d)| (n.to_string(), d.clone()))
        .collect();
    json!({"id": id, "hint": {"path": path}, "props": map})
}

fn line(value: &Value) -> String {
    serde_json::to_string(value).unwrap()
}

/// A file in canonical lines, sorted by `id`.
fn file(recs: &[Value]) -> Vec<u8> {
    let mut sorted: Vec<&Value> = recs.iter().collect();
    sorted.sort_by_key(|r| r["id"].as_str().unwrap().to_string());
    let mut text = String::from("{\"version\":1}\n");
    for r in sorted {
        text.push_str(&line(r));
        text.push('\n');
    }
    text.into_bytes()
}

/// The same file with spaces inside the lines: equal by meaning, not canonical.
fn file_spaced(recs: &[Value]) -> Vec<u8> {
    let text = String::from_utf8(file(recs)).unwrap();
    text.replace("\":", "\": ")
        .replace(",\"", ", \"")
        .into_bytes()
}

fn lines_of(bytes: &[u8]) -> Vec<String> {
    String::from_utf8(bytes.to_vec())
        .unwrap()
        .lines()
        .skip(1)
        .map(str::to_string)
        .collect()
}

fn by_id(bytes: &[u8]) -> BTreeMap<String, Value> {
    lines_of(bytes)
        .iter()
        .map(|l| {
            let v: Value = serde_json::from_str(l).unwrap();
            (v["id"].as_str().unwrap().to_string(), v)
        })
        .collect()
}

fn map_of(recs: &[Value]) -> BTreeMap<String, Value> {
    recs.iter()
        .map(|r| (r["id"].as_str().unwrap().to_string(), r.clone()))
        .collect()
}

#[track_caller]
fn run(kind: GroupKind, base: &[u8], local: &[u8], remote: &[u8]) -> GroupMergeOutcome {
    merge_group(kind, base, local, remote)
}

/// The clean result; the swapped call must give the same bytes.
#[track_caller]
fn clean(base: &[u8], local: &[u8], remote: &[u8]) -> Vec<u8> {
    clean_k(P, base, local, remote)
}

#[track_caller]
fn clean_k(kind: GroupKind, base: &[u8], local: &[u8], remote: &[u8]) -> Vec<u8> {
    let GroupMergeOutcome::Clean(bytes) = run(kind, base, local, remote) else {
        panic!(
            "expected a clean merge, got {:?}",
            run(kind, base, local, remote)
        );
    };
    match run(kind, base, remote, local) {
        GroupMergeOutcome::Clean(swapped) => assert_eq!(swapped, bytes, "symmetry"),
        other => panic!("swapped sides gave {other:?}"),
    }
    bytes
}

#[track_caller]
fn conflict(base: &[u8], local: &[u8], remote: &[u8]) -> GroupConflict {
    conflict_k(P, base, local, remote)
}

#[track_caller]
fn conflict_k(kind: GroupKind, base: &[u8], local: &[u8], remote: &[u8]) -> GroupConflict {
    let GroupMergeOutcome::Conflict(found) = run(kind, base, local, remote) else {
        panic!(
            "expected a conflict, got {:?}",
            run(kind, base, local, remote)
        );
    };
    match run(kind, base, remote, local) {
        GroupMergeOutcome::Conflict(swapped) => assert_eq!(swapped, found, "symmetry"),
        other => panic!("swapped sides gave {other:?}"),
    }
    found
}

fn a() -> Value {
    rec("A", &[("Заказчик", diff("0"))])
}
fn b() -> Value {
    rec("B", &[("Автор", diff("0"))])
}

// ----- З48: the file of a group -----

fn first_hex_digit(id: &str) -> String {
    format!("{:x}", blake3::hash(id.as_bytes()).as_bytes()[0] >> 4)
}

#[test]
fn the_group_is_the_first_hex_digit_of_blake3_of_the_id() {
    // З48: one lowercase digit, 16 files; the marks of З53 use the same digit
    for id in [
        "01JABCDEF0123456789ABCDEFG",
        "01JABCDEF0123456789ABCDEFH",
        "я-заметка",
        "",
        "x",
    ] {
        assert_eq!(group_of(id), first_hex_digit(id), "{id:?}");
        assert_eq!(
            group_path_of(id),
            format!(".amby/properties/prop_{}.jsonl", first_hex_digit(id))
        );
        assert_eq!(
            legacy_path_of(id),
            format!(".amby/properties/legacy_{}.jsonl", first_hex_digit(id))
        );
    }
    // BLAKE3 of the empty string starts with af 13 49 b9 (the official vector).
    assert_eq!(group_of(""), "a");
}

#[test]
fn ids_with_the_same_time_prefix_spread_over_the_sixteen_groups() {
    // З48: not the start of the ULID
    let mut same_time = std::collections::HashSet::new();
    for n in 0..2000u32 {
        same_time.insert(group_of(&format!("01JABCDEFG{n:016}")));
    }
    assert_eq!(same_time.len(), GROUP_COUNT);
    let mut counts = [0usize; GROUP_COUNT];
    for n in 0..100_000u32 {
        let g = group_of(&format!("01JABCDE{n:018}"));
        counts[usize::from_str_radix(&g, 16).unwrap()] += 1;
    }
    let (min, max) = (*counts.iter().min().unwrap(), *counts.iter().max().unwrap());
    assert!(
        min > 5800 && max < 6700,
        "uneven spread: min {min}, max {max} (mean 6250)"
    );
}

#[test]
fn only_the_sixteen_prop_files_and_the_sixteen_legacy_files_are_merged() {
    // З52, З53: `layout.json` and everything else is synchronised but not merged
    for x in "0123456789abcdef".chars() {
        assert_eq!(
            kind_of_path(&format!(".amby/properties/prop_{x}.jsonl")),
            Some(P)
        );
        assert_eq!(
            kind_of_path(&format!(".amby/properties/legacy_{x}.jsonl")),
            Some(L)
        );
    }
    for bad in [
        ".amby/properties/layout.json",
        ".amby/properties/prop_A.jsonl",
        ".amby/properties/prop_g.jsonl",
        ".amby/properties/prop_ab.jsonl",
        ".amby/properties/prop_.jsonl",
        ".amby/properties/prop_a.json",
        ".amby/properties/prop_a.jsonl.tmp",
        ".amby/properties/af.json",
        ".amby/properties/sub/prop_a.jsonl",
        ".amby/properties.json",
        ".amby/property-ops/prop_a.jsonl",
        "properties/prop_a.jsonl",
        "Notes/.amby/properties/prop_a.jsonl",
    ] {
        assert_eq!(kind_of_path(bad), None, "{bad}");
    }
}

// ----- З16, З52: the unit is the line of a note -----

#[test]
fn a_line_changed_on_one_side_is_taken() {
    // З16, З52: different notes edited on the two sides are both kept
    let base = file(&[a(), b()]);
    let a2 = rec("A", &[("Заказчик", diff("🔥"))]);
    let b2 = rec("B", &[("Автор", diff("0")), ("Срок", diff("1"))]);
    let merged = clean(&base, &file(&[a2.clone(), b()]), &file(&[a(), b2.clone()]));
    assert_eq!(by_id(&merged), map_of(&[a2, b2]));
}

#[test]
fn a_line_changed_the_same_way_on_both_sides_is_taken_once() {
    // З16
    let a2 = rec("A", &[("Заказчик", diff("🔥"))]);
    let side = file(&[a2.clone(), b()]);
    assert_eq!(
        by_id(&clean(&file(&[a(), b()]), &side, &side)),
        map_of(&[a2, b()])
    );
}

#[test]
fn a_line_changed_in_different_ways_is_a_conflict_of_that_note_only() {
    // З16, З17: everything or nothing; the other lines are counted as merged by themselves
    let c = rec("C", &[("Срок", diff("0"))]);
    let base = file(&[a(), b(), c.clone()]);
    let local = file(&[
        rec("A", &[("Заказчик", diff("L"))]),
        rec("B", &[("Автор", diff("L"))]),
        c,
    ]);
    let remote = file(&[
        rec("A", &[("Заказчик", diff("R"))]),
        b(),
        rec("C", &[("Срок", diff("R"))]),
    ]);
    let found = conflict(&base, &local, &remote);
    assert_eq!(found.notes, vec!["A".to_string()]);
    assert_eq!(found.auto_merged, 2, "B from local and C from remote");
}

#[test]
fn two_properties_of_one_note_edited_on_different_sides_are_still_a_conflict() {
    // З16: no merge inside a note
    let base = file(&[rec("A", &[("Один", diff("0")), ("Два", diff("0"))])]);
    let local = file(&[rec("A", &[("Один", diff("🔥")), ("Два", diff("0"))])]);
    let remote = file(&[rec("A", &[("Один", diff("0")), ("Два", diff("👤"))])]);
    assert_eq!(
        conflict(&base, &local, &remote).notes,
        vec!["A".to_string()]
    );
}

#[test]
fn deleting_a_line_against_editing_it_is_a_conflict_of_that_note() {
    // З16
    let base = file(&[a(), b()]);
    let deleted = file(&[b()]);
    let edited = file(&[rec("A", &[("Заказчик", diff("🔥"))]), b()]);
    assert_eq!(
        conflict(&base, &deleted, &edited).notes,
        vec!["A".to_string()]
    );
}

#[test]
fn deleting_a_line_the_other_side_did_not_touch_deletes_it_and_both_deleting_too() {
    // З16
    let base = file(&[a(), b()]);
    let deleted = file(&[b()]);
    assert_eq!(by_id(&clean(&base, &deleted, &base)), map_of(&[b()]));
    assert_eq!(by_id(&clean(&base, &deleted, &deleted)), map_of(&[b()]));
}

#[test]
fn different_new_lines_are_both_kept_and_stay_sorted_by_id() {
    // З16, З48
    let base = file(&[a(), b()]);
    let c = rec("C", &[("Срок", diff("0"))]);
    let d = rec("D", &[("Цвет", diff("0"))]);
    let merged = clean(
        &base,
        &file(&[a(), b(), c.clone()]),
        &file(&[a(), b(), d.clone()]),
    );
    assert_eq!(by_id(&merged), map_of(&[a(), b(), c, d]));
    let ids: Vec<String> = lines_of(&merged)
        .iter()
        .map(|l| {
            serde_json::from_str::<Value>(l).unwrap()["id"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(ids, vec!["A", "B", "C", "D"]);
}

#[test]
fn a_line_added_by_both_is_one_when_equal_and_a_conflict_when_different() {
    // З16, З31: no such line in the base
    let base = file(&[a(), b()]);
    let c = rec("C", &[("Срок", diff("0"))]);
    let same = file(&[a(), b(), c.clone()]);
    assert_eq!(by_id(&clean(&base, &same, &same)), map_of(&[a(), b(), c]));
    let other = file(&[a(), b(), rec("C", &[("Другое", diff("9"))])]);
    assert_eq!(conflict(&base, &same, &other).notes, vec!["C".to_string()]);
}

#[test]
fn an_empty_base_with_a_new_line_on_each_side_is_ordinary() {
    // З16: the first file of a vault
    let merged = clean(&file(&[]), &file(&[a()]), &file(&[b()]));
    assert_eq!(by_id(&merged), map_of(&[a(), b()]));
}

#[test]
fn a_line_taken_from_one_side_keeps_the_bytes_of_that_side_and_the_rest_of_the_base_stays() {
    // З52: «строка, взятая с одной стороны без изменений, переносится её байтами»
    let c = rec("C", &[("Срок", diff("0"))]);
    let base = file(&[a(), b(), c]);
    let a2 = rec("A", &[("Заказчик", diff("🔥"))]);
    let b2 = rec("B", &[("Автор", diff("⭐"))]);
    // local has the new A with spaces inside the line
    let local = file_spaced(&[a2.clone(), b(), rec("C", &[("Срок", diff("0"))])]);
    let remote = file(&[a(), b2.clone(), rec("C", &[("Срок", diff("0"))])]);
    let merged = clean(&base, &local, &remote);
    let spaced_a = lines_of(&local)[0].clone();
    let got = lines_of(&merged);
    assert_eq!(got[0], spaced_a, "A comes with the bytes of the local side");
    assert_eq!(
        got[1],
        line(&b2),
        "B comes with the bytes of the remote side"
    );
    assert_eq!(
        got[2],
        lines_of(&base)[2],
        "C is the base line, byte for byte"
    );
}

// ----- З31: hint and dismissedRenames take no part in the decision -----

#[test]
fn a_hint_changed_on_one_side_never_conflicts_with_the_props_on_the_other() {
    // З31
    let props = [("Заказчик", diff("0"))];
    let base = file(&[rec_hint("A", &props, "Старый.md")]);
    let local = file(&[rec_hint("A", &props, "Новый.md")]);
    let remote = file(&[rec_hint("A", &[("Заказчик", diff("🔥"))], "Старый.md")]);
    let merged = by_id(&clean(&base, &local, &remote));
    assert_eq!(
        merged["A"],
        rec_hint("A", &[("Заказчик", diff("🔥"))], "Новый.md")
    );
}

#[test]
fn hints_changed_in_different_ways_take_the_one_with_the_smaller_canonical_json() {
    // З31: deterministic and symmetric; the canonical JSON of the hint is `{"path":…}`
    let props = [("Заказчик", diff("0"))];
    let base = file(&[rec_hint("A", &props, "Старый.md")]);
    let local = file(&[rec_hint("A", &props, "Б.md")]);
    let remote = file(&[rec_hint("A", &props, "А.md")]);
    assert_eq!(
        by_id(&clean(&base, &local, &remote))["A"],
        rec_hint("A", &props, "А.md")
    );
}

#[test]
fn equal_new_lines_with_different_hints_are_one_line() {
    // З31: added by both, equal without the hint
    let props = [("Заказчик", diff("0"))];
    let merged = clean(
        &file(&[]),
        &file(&[rec_hint("A", &props, "Б.md")]),
        &file(&[rec_hint("A", &props, "А.md")]),
    );
    assert_eq!(by_id(&merged)["A"], rec_hint("A", &props, "А.md"));
}

#[test]
fn dismissed_renames_are_merged_as_a_set_and_never_conflict() {
    // З31, З44: a refusal on one computer and a new icon on the other give no conflict card
    let with = |pairs: Value, icon: &str| {
        let mut r = rec("A", &[("Заказчик", diff(icon))]);
        r["dismissedRenames"] = pairs;
        r
    };
    let base = file(&[with(json!([["Статус", "Состояние"]]), "0")]);
    let local = file(&[with(
        json!([["Статус", "Состояние"], ["Автор", "Создатель"]]),
        "0",
    )]);
    let remote = file(&[with(json!([["Статус", "Состояние"]]), "🔥")]);
    let merged = by_id(&clean(&base, &local, &remote));
    assert_eq!(merged["A"]["props"], json!({"Заказчик": {"icon": "🔥"}}));
    let mut pairs: Vec<String> = merged["A"]["dismissedRenames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.to_string())
        .collect();
    pairs.sort();
    assert_eq!(
        pairs,
        vec![r#"["Автор","Создатель"]"#, r#"["Статус","Состояние"]"#]
    );

    // both add different pairs; one side removes a pair the other did not touch
    let base2 = file(&[with(json!([["a", "b"], ["c", "d"]]), "0")]);
    let l2 = file(&[with(json!([["c", "d"], ["e", "f"]]), "0")]);
    let r2 = file(&[with(json!([["a", "b"], ["c", "d"], ["g", "h"]]), "0")]);
    let merged2 = by_id(&clean(&base2, &l2, &r2));
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
fn a_change_of_the_order_is_part_of_the_decision() {
    // З47, З52: `order` is compared like `props`
    let mut o1 = a();
    o1["order"] = json!(["Один", "Два"]);
    let mut o2 = a();
    o2["order"] = json!(["Два", "Один"]);
    let base = file(&[a()]);
    assert_eq!(
        conflict(&base, &file(&[o1.clone()]), &file(&[o2])).notes,
        vec!["A".to_string()]
    );
    assert_eq!(by_id(&clean(&base, &file(&[o1.clone()]), &base))["A"], o1);
}

// ----- З53: the marks of old versions are a file of their own -----

fn mark(id: &str, entry: &str, record: &str) -> Value {
    json!({"id": id, "entry": entry, "record": record})
}

#[test]
fn the_marks_are_merged_by_lines_like_the_records_and_do_not_touch_the_prop_files() {
    // З53, З52, З31: a mark changed on one side is taken, on both differently — a conflict of the
    // note; `legacy` is no longer part of the line of the note in `prop_<x>.jsonl`
    let base = file(&[mark("A", "e0", "r0"), mark("B", "e0", "r0")]);
    let local = file(&[mark("A", "e0", "r1"), mark("B", "e0", "r0")]);
    let remote = file(&[mark("A", "e0", "r0"), mark("B", "e1", "r1")]);
    let merged = by_id(&clean_k(L, &base, &local, &remote));
    assert_eq!(merged["A"], mark("A", "e0", "r1"));
    assert_eq!(merged["B"], mark("B", "e1", "r1"));
    let local2 = file(&[mark("A", "e0", "r1"), mark("B", "e0", "r0")]);
    let remote2 = file(&[mark("A", "e0", "r2"), mark("B", "e0", "r0")]);
    assert_eq!(
        conflict_k(L, &base, &local2, &remote2).notes,
        vec!["A".to_string()]
    );
    // added by both: equal — one, different — a conflict; deleted against changed — a conflict
    let empty = file(&[]);
    let same = file(&[mark("C", "e", "r")]);
    assert_eq!(by_id(&clean_k(L, &empty, &same, &same)).len(), 1);
    assert_eq!(
        conflict_k(L, &empty, &same, &file(&[mark("C", "e", "x")])).notes,
        vec!["C".to_string()]
    );
    assert_eq!(
        conflict_k(L, &base, &file(&[mark("B", "e0", "r0")]), &local).notes,
        vec!["A".to_string()]
    );
}

#[test]
fn a_prop_file_is_not_a_legacy_file_and_the_other_way_round() {
    // З53: the shapes differ
    let props = file(&[a()]);
    let marks = file(&[mark("A", "e", "r")]);
    assert!(check_group(L, &props).is_err());
    assert!(check_group(P, &marks).is_err());
}

// ----- З2, З51: unknown fields -----

#[test]
fn unknown_fields_of_the_header_the_line_and_the_differences_are_kept() {
    // З2, З47, З48: a newer Amby wrote them
    let mut keep = rec(
        "A",
        &[(
            "Заказчик",
            json!({"icon": "0", "color": {"deep": [1, {"x": null}]}}),
        )],
    );
    keep["future"] = json!("stay");
    let header = "{\"future\":{\"keep\":[1,2]},\"version\":1}\n";
    let build = |recs: &[Value]| {
        let text = String::from_utf8(file(recs)).unwrap();
        text.replacen("{\"version\":1}\n", header, 1).into_bytes()
    };
    let base = build(&[keep.clone(), b()]);
    let local = build(&[keep.clone(), rec("B", &[("Автор", diff("🔥"))])]);
    let merged = clean(&base, &local, &base);
    let text = String::from_utf8(merged.clone()).unwrap();
    assert!(text.starts_with(header), "{text}");
    assert_eq!(by_id(&merged)["A"], keep);
}

#[test]
fn an_unknown_header_field_is_one_record_that_conflicts_when_changed_differently() {
    // З16, З48: changed on one side — taken; on both differently — a conflict of no note
    let with = |top: i32, recs: &[Value]| {
        String::from_utf8(file(recs))
            .unwrap()
            .replacen(
                "{\"version\":1}\n",
                &format!("{{\"top\":{top},\"version\":1}}\n"),
                1,
            )
            .into_bytes()
    };
    let base = with(1, &[a()]);
    let merged = clean(&base, &with(2, &[a()]), &base);
    assert!(String::from_utf8(merged)
        .unwrap()
        .starts_with("{\"top\":2,\"version\":1}\n"));
    assert!(conflict(&base, &with(2, &[a()]), &with(3, &[a()]))
        .notes
        .is_empty());
}

// ----- З30, З51: admission of the whole file -----

fn valid() -> Vec<u8> {
    file(&[a()])
}

/// Bytes that must not pass the admission check.
fn bad_versions() -> Vec<(&'static str, Vec<u8>)> {
    let head = "{\"version\":1}\n";
    let with = |lines: &str| format!("{head}{lines}").into_bytes();
    let deep = |n: usize| {
        let nested = format!("{}{}", "[".repeat(n), "]".repeat(n));
        with(&format!("{{\"future\":{nested},\"id\":\"A\"}}\n"))
    };
    vec![
        ("not utf-8", {
            let mut v = valid();
            v.insert(20, 0xFF);
            v
        }),
        ("a NUL byte", {
            let mut v = valid();
            v.insert(20, 0x00);
            v
        }),
        ("empty file", Vec::new()),
        ("first line not json", b"not json\n{\"id\":\"A\"}\n".to_vec()),
        ("first line an array", b"[1]\n".to_vec()),
        ("version 2", b"{\"version\":2}\n".to_vec()),
        ("version missing", b"{\"top\":1}\n".to_vec()),
        ("version a string", b"{\"version\":\"1\"}\n".to_vec()),
        ("duplicate key in the first line", b"{\"version\":1,\"version\":1}\n".to_vec()),
        ("a line that is not json", with("{\"id\":\"A\"}\nthis is not json\n")),
        ("a line that is an array", with("[1,2]\n")),
        ("a blank line", with("{\"id\":\"A\"}\n\n{\"id\":\"B\"}\n")),
        ("a line cut in the middle", with("{\"id\":\"A\",\"props\":{\"Я\"")),
        ("a line without id", with("{\"props\":{}}\n")),
        ("an empty id", with("{\"id\":\"\"}\n")),
        ("an id that is not a string", with("{\"id\":5}\n")),
        ("duplicate key in a line", with("{\"id\":\"A\",\"id\":\"A\"}\n")),
        ("duplicate key in the differences", with("{\"id\":\"A\",\"props\":{\"X\":{\"icon\":\"a\",\"icon\":\"b\"}}}\n")),
        ("the same id twice", with("{\"id\":\"A\"}\n{\"id\":\"A\"}\n")),
        ("lines not sorted by id", with("{\"id\":\"B\"}\n{\"id\":\"A\"}\n")),
        ("props not an object", with("{\"id\":\"A\",\"props\":[]}\n")),
        ("differences not an object", with("{\"id\":\"A\",\"props\":{\"X\":5}}\n")),
        ("icon not a string", with("{\"id\":\"A\",\"props\":{\"X\":{\"icon\":5}}}\n")),
        ("propertyType not a string", with("{\"id\":\"A\",\"props\":{\"X\":{\"propertyType\":null}}}\n")),
        ("order not a list of strings", with("{\"id\":\"A\",\"order\":[1]}\n")),
        ("hint not an object", with("{\"id\":\"A\",\"hint\":\"x\"}\n")),
        ("the same name twice", with("{\"id\":\"A\",\"props\":{\"Имя\":{},\"Имя\":{}}}\n")),
        ("names equal apart from ASCII case", with("{\"id\":\"A\",\"props\":{\"Status\":{\"icon\":\"a\"},\"STATUS\":{\"icon\":\"b\"}}}\n")),
        ("names equal after NFC", with("{\"id\":\"A\",\"props\":{\"Е\\u0308ж\":{},\"Ёж\":{}}}\n")),
        ("an unknown value nested too deep", deep(PROPS_MAX_DEPTH + 40)),
    ]
}

#[test]
fn every_reason_of_the_admission_check_refuses_the_file_in_any_of_the_three_places() {
    // З30, З51, З52: base, local, remote; any damaged line sets the whole file apart; no repair
    let good = valid();
    for (label, bad) in bad_versions() {
        assert!(check_group(P, &bad).is_err(), "{label}: check_group");
        for place in 0..3 {
            let mut v = [good.clone(), good.clone(), good.clone()];
            v[place] = bad.clone();
            let outcome = merge_group(P, &v[0], &v[1], &v[2]);
            assert!(
                matches!(outcome, GroupMergeOutcome::NotMergeable(_)),
                "{label} in place {place}: {outcome:?}"
            );
        }
    }
}

#[test]
fn a_file_with_unknown_values_and_valid_lines_passes_the_check() {
    // З30, З2
    assert!(check_group(P, &valid()).is_ok());
    assert!(
        check_group(P, b"{\"version\":1}\n").is_ok(),
        "no notes at all"
    );
    let nested = format!("{}{}", "[".repeat(20), "]".repeat(20));
    let text = format!("{{\"top\":{{\"x\":[true,null,\"é\"]}},\"version\":1}}\n{{\"future\":{nested},\"id\":\"A\",\"n\":1.0}}\n");
    assert!(check_group(P, text.as_bytes()).is_ok());
    // the same name in different notes; names that differ in the case of non-ASCII letters
    let ok = file(&[
        rec("A", &[("Статус", diff("a"))]),
        rec("B", &[("Статус", diff("a"))]),
        rec("C", &[("Статус", diff("a")), ("статус", diff("b"))]),
    ]);
    assert!(check_group(P, &ok).is_ok(), "case folding is ASCII only");
}

#[test]
fn a_file_over_sixteen_million_bytes_is_not_merged_and_exactly_the_limit_is() {
    // З30, З52
    assert_eq!((PROPS_MERGE_MAX_BYTES, GROUP_COUNT), (16_000_000, 16));
    let pad = |total: usize| {
        let head = b"{\"pad\":\"";
        let tail = b"\",\"version\":1}\n";
        let mut bytes = head.to_vec();
        bytes.resize(total - tail.len(), b'a');
        bytes.extend_from_slice(tail);
        assert_eq!(bytes.len(), total);
        bytes
    };
    let at_limit = pad(PROPS_MERGE_MAX_BYTES);
    let over = pad(PROPS_MERGE_MAX_BYTES + 1);
    assert!(check_group(P, &at_limit).is_ok());
    assert_eq!(check_group(P, &over), Err(NotMergeable::TooLarge));
    let small = valid();
    for place in 0..3 {
        let mut v = [small.clone(), small.clone(), small.clone()];
        v[place] = over.clone();
        assert_eq!(
            merge_group(P, &v[0], &v[1], &v[2]),
            GroupMergeOutcome::NotMergeable(NotMergeable::TooLarge),
            "place {place}"
        );
    }
}

// ----- З30, Ж11: short paths return the bytes of a side -----

#[test]
fn equal_sides_return_the_local_bytes_untouched_even_when_not_canonical() {
    // З52 (Ж11)
    let local = file_spaced(&[a(), b()]);
    let remote = file(&[a(), b()]);
    assert_ne!(local, remote);
    assert_eq!(
        merge_group(P, &valid(), &local, &remote),
        GroupMergeOutcome::Clean(local.clone()),
        "equal by meaning: the local bytes"
    );
}

#[test]
fn a_side_equal_to_the_base_gives_the_bytes_of_the_other_side() {
    // З52 (Ж11)
    let base = valid();
    let edited = file_spaced(&[a(), b()]);
    assert_eq!(
        merge_group(P, &base, &base, &edited),
        GroupMergeOutcome::Clean(edited.clone())
    );
    assert_eq!(
        merge_group(P, &base, &edited, &base),
        GroupMergeOutcome::Clean(edited.clone())
    );
    let reformatted = file_spaced(&[a()]);
    assert_eq!(
        merge_group(P, &base, &reformatted, &edited),
        GroupMergeOutcome::Clean(edited.clone())
    );
    assert_eq!(
        merge_group(P, &base, &edited, &reformatted),
        GroupMergeOutcome::Clean(edited)
    );
}

#[test]
fn the_admission_check_comes_before_the_short_paths() {
    // З30: a damaged base is refused even when local and remote are equal
    let good = valid();
    assert!(matches!(
        merge_group(P, b"garbage\n", &good, &good),
        GroupMergeOutcome::NotMergeable(_)
    ));
}

// ----- З49: canonical form, BOM, line endings -----

#[test]
fn canonicalize_gives_compact_lines_with_ascending_keys_and_is_idempotent() {
    // З49: no spaces, keys ascending byte by byte (so `hint` before `id`), a line feed after each
    // line, lines sorted by id
    let input = file_spaced(&[rec("A", &[("Статус", diff("🔥"))]), rec("B", &[])]);
    let once = canonicalize_group(P, &input).unwrap();
    assert_eq!(
        String::from_utf8(once.clone()).unwrap(),
        "{\"version\":1}\n{\"hint\":{\"path\":\"Заметка.md\"},\"id\":\"A\",\"props\":{\"Статус\":{\"icon\":\"🔥\"}}}\n{\"hint\":{\"path\":\"Заметка.md\"},\"id\":\"B\",\"props\":{}}\n"
    );
    assert_eq!(canonicalize_group(P, &once).unwrap(), once);
    assert!(canonicalize_group(P, b"garbage\n").is_err());
}

#[test]
fn a_line_made_anew_by_a_merge_is_canonical() {
    // З49, З52: only the lines made of both sides (here: the hint of one and the props of the other)
    let props = [("Заказчик", diff("0"))];
    let base = file(&[rec_hint("A", &props, "Старый.md")]);
    let local = file_spaced(&[rec_hint("A", &props, "Новый.md")]);
    let remote = file(&[rec_hint("A", &[("Заказчик", diff("🔥"))], "Старый.md")]);
    let merged = clean(&base, &local, &remote);
    assert_eq!(canonicalize_group(P, &merged).unwrap(), merged);
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
    let base = file(&[a(), b()]);
    let local = file(&[rec("A", &[("Заказчик", diff("🔥"))]), b()]);
    let remote = file(&[a(), rec("B", &[("Автор", diff("0")), ("Срок", diff("1"))])]);
    (base, local, remote)
}

#[test]
fn the_bom_is_kept_when_both_sides_have_it_and_follows_the_side_that_changed_it() {
    // З52 (Ж14), З49
    let (base, local, remote) = merge_inputs();
    let has_bom = |b: &[u8]| b.starts_with(&[0xEF, 0xBB, 0xBF]);
    assert!(has_bom(&clean(
        &bom(base.clone()),
        &bom(local.clone()),
        &bom(remote.clone())
    )));
    assert!(!has_bom(&clean(&base, &local, &remote)));
    assert!(has_bom(&clean(&base, &bom(local.clone()), &remote)));
    assert!(!has_bom(&clean(
        &bom(base.clone()),
        &local,
        &bom(remote.clone())
    )));
    assert!(has_bom(&clean(&base, &bom(local), &bom(remote))));
}

#[test]
fn the_line_ending_follows_the_rules_of_the_file_form() {
    // З52 (Ж14), З49: a new line is written with the ending of the file
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
    assert!(all_crlf(&clean(&base, &crlf(&local), &remote)));
    assert!(none_crlf(&clean(&crlf(&base), &local, &crlf(&remote))));
    assert!(none_crlf(&clean(&base, &local, &remote)));
}

#[test]
fn a_merge_twice_gives_the_same_bytes() {
    // З30 (Г18)
    let (base, local, remote) = merge_inputs();
    assert_eq!(clean(&base, &local, &remote), clean(&base, &local, &remote));
}
