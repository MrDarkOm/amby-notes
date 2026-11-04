//! Resolution of a conflicting file (З17) and the protection against a mass loss over a whole
//! pass (З32, З52, З.10-1 владельца: вариант (а)); lines of JSON Lines (З47–З48). Red until `props_groups` is written (`todo!()` today).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;

use amby_sync_core::engine::props_groups::{
    canonicalize_group, pass_mass_loss, resolve_group as resolve, vanishing_properties, GroupKind,
    GroupWrite, MassLoss, ResolveError, Side,
};
use serde_json::{json, Value};

fn rec(id: &str, props: &[(&str, &str)]) -> Value {
    let map: serde_json::Map<String, Value> = props
        .iter()
        .map(|(n, icon)| (n.to_string(), json!({"icon": icon})))
        .collect();
    json!({"id": id, "hint": {"path": "N.md"}, "props": map})
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

/// A file of `notes` notes, each with `per` properties named `p<k>`.
fn big(first: usize, notes: usize, per: usize) -> Vec<u8> {
    let names: Vec<String> = (0..per).map(|k| format!("p{k}")).collect();
    let recs: Vec<Value> = (first..first + notes)
        .map(|n| {
            let props: Vec<(&str, &str)> = names.iter().map(|k| (k.as_str(), "📌")).collect();
            rec(&format!("N{n:04}"), &props)
        })
        .collect();
    file(&recs)
}

fn empty() -> Vec<u8> {
    file(&[])
}

fn resolve_group(
    base: &[u8],
    local: &[u8],
    other: &[u8],
    picks: &BTreeMap<String, Side>,
    now_local: &[u8],
    now_other: &[u8],
) -> Result<Vec<u8>, ResolveError> {
    resolve(
        GroupKind::Props,
        base,
        local,
        other,
        picks,
        now_local,
        now_other,
    )
}

// ----- З17: resolution -----

struct Conflicting {
    base: Vec<u8>,
    local: Vec<u8>,
    other: Vec<u8>,
}

/// A and B conflict, C is changed by `other` only, D by `local` only.
fn conflicting() -> Conflicting {
    let e = |id: &str, icon: &str| rec(id, &[("Имя", icon)]);
    Conflicting {
        base: file(&[e("A", "0"), e("B", "0"), e("C", "0"), e("D", "0")]),
        local: file(&[e("A", "L"), e("B", "L"), e("C", "0"), e("D", "L")]),
        other: file(&[e("A", "O"), e("B", "O"), e("C", "O"), e("D", "0")]),
    }
}

fn picks(a: Option<Side>, b: Option<Side>) -> BTreeMap<String, Side> {
    let mut map = BTreeMap::new();
    if let Some(s) = a {
        map.insert("A".to_string(), s);
    }
    if let Some(s) = b {
        map.insert("B".to_string(), s);
    }
    map
}

fn icons(bytes: &[u8]) -> BTreeMap<String, String> {
    String::from_utf8(bytes.to_vec())
        .unwrap()
        .lines()
        .skip(1)
        .map(|l| {
            let v: Value = serde_json::from_str(l).unwrap();
            (
                v["id"].as_str().unwrap().to_string(),
                v["props"]["Имя"]["icon"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

#[test]
fn each_conflicting_note_takes_its_own_pick_and_the_rest_comes_from_the_clean_merge() {
    // З17
    let c = conflicting();
    let out = resolve_group(
        &c.base,
        &c.local,
        &c.other,
        &picks(Some(Side::Local), Some(Side::Other)),
        &c.local,
        &c.other,
    )
    .unwrap();
    let got = icons(&out);
    assert_eq!(got["A"], "L");
    assert_eq!(got["B"], "O");
    assert_eq!(got["C"], "O", "changed by the other side only");
    assert_eq!(got["D"], "L", "changed by this side only");
}

#[test]
fn the_other_way_round_gives_the_other_picks() {
    // З17
    let c = conflicting();
    let out = resolve_group(
        &c.base,
        &c.local,
        &c.other,
        &picks(Some(Side::Other), Some(Side::Local)),
        &c.local,
        &c.other,
    )
    .unwrap();
    let got = icons(&out);
    assert_eq!((got["A"].as_str(), got["B"].as_str()), ("O", "L"));
}

#[test]
fn a_pick_for_a_deleted_record_removes_it_and_the_result_is_canonical() {
    // З17, З16: deletion against an edit; З8
    let e = |id: &str, icon: &str| rec(id, &[("Имя", icon)]);
    let base = file(&[e("A", "0"), e("B", "0")]);
    let local = file(&[e("B", "0")]);
    let other = file(&[e("A", "O"), e("B", "0")]);
    let mut p = BTreeMap::new();
    p.insert("A".to_string(), Side::Local);
    let out = resolve_group(&base, &local, &other, &p, &local, &other).unwrap();
    assert!(!String::from_utf8(out.clone())
        .unwrap()
        .contains("\"id\":\"A\""));
    assert_eq!(canonicalize_group(GroupKind::Props, &out).unwrap(), out);
}

#[test]
fn an_incomplete_pick_is_an_error_and_nothing_is_produced() {
    // З17
    let c = conflicting();
    assert_eq!(
        resolve_group(
            &c.base,
            &c.local,
            &c.other,
            &picks(Some(Side::Local), None),
            &c.local,
            &c.other
        ),
        Err(ResolveError::IncompletePicks)
    );
    assert_eq!(
        resolve_group(
            &c.base,
            &c.local,
            &c.other,
            &picks(None, None),
            &c.local,
            &c.other
        ),
        Err(ResolveError::IncompletePicks)
    );
}

#[test]
fn a_changed_file_or_second_version_makes_the_resolution_stale() {
    // З17 (К4): «пока вы сравнивали, пришла новая версия» — nothing is written
    let c = conflicting();
    let full = picks(Some(Side::Local), Some(Side::Local));
    let newer = file(&[rec("A", &[("Имя", "NEW")])]);
    assert_eq!(
        resolve_group(&c.base, &c.local, &c.other, &full, &newer, &c.other),
        Err(ResolveError::Stale)
    );
    assert_eq!(
        resolve_group(&c.base, &c.local, &c.other, &full, &c.local, &newer),
        Err(ResolveError::Stale)
    );
}

// ----- З32: what vanishes -----

#[test]
fn only_properties_that_are_gone_count_as_vanishing() {
    // З32, З52: changed differences and a changed order do not vanish; added ones neither
    let before = file(&[{
        let mut r = rec("A", &[("a", "1"), ("b", "1"), ("c", "1")]);
        r["order"] = json!(["a", "b", "c"]);
        r
    }]);
    let restyled = file(&[{
        let mut r = rec("A", &[("a", "9"), ("b", "1"), ("c", "1"), ("d", "1")]);
        r["order"] = json!(["c", "b", "a"]);
        r
    }]);
    assert_eq!(vanishing_properties(&before, &restyled), 0);
    let one_gone = file(&[rec("A", &[("a", "1"), ("c", "1")])]);
    assert_eq!(vanishing_properties(&before, &one_gone), 1);
    assert_eq!(vanishing_properties(&before, &empty()), 3, "a whole line");
    assert_eq!(vanishing_properties(&before, &[]), 3, "the file is gone");
    assert_eq!(
        vanishing_properties(&[], &before),
        0,
        "a new file loses nothing"
    );
    assert_eq!(vanishing_properties(b"garbage\n", &before), 0);
}

fn writes<'a>(items: &'a [(String, Vec<u8>, Vec<u8>)]) -> Vec<GroupWrite<'a>> {
    items
        .iter()
        .map(|(p, b, a)| GroupWrite {
            path: p,
            before: b,
            after: a,
        })
        .collect()
}

/// `n` files, each with one note of two properties, and the same files with `lose` of them
/// emptied: a pass that makes `lose * 2` properties vanish.
fn pass_of(groups: usize, lose: usize) -> Vec<(String, Vec<u8>, Vec<u8>)> {
    (0..groups)
        .map(|g| {
            let before = big(g, 1, 2);
            let after = if g < lose { empty() } else { before.clone() };
            (
                format!(".amby/properties/prop_{:x}.jsonl", g % 16),
                before,
                after,
            )
        })
        .collect()
}

#[test]
fn twenty_one_of_two_hundred_properties_stop_the_pass_and_nineteen_do_not() {
    // З32 (пороги Д54): the numbers of the plan, on groups
    let one = vec![(
        ".amby/properties/prop_a.jsonl".to_string(),
        big(0, 200, 1),
        big(0, 179, 1),
    )];
    assert_eq!(
        pass_mass_loss(&writes(&one), 200),
        Some(MassLoss {
            properties: 21,
            notes: 21
        })
    );
    let nineteen = vec![(
        ".amby/properties/prop_a.jsonl".to_string(),
        big(0, 200, 1),
        big(0, 181, 1),
    )];
    assert_eq!(
        pass_mass_loss(&writes(&nineteen), 200),
        None,
        "fewer than twenty"
    );
    let too_few_of_many = vec![(
        ".amby/properties/prop_a.jsonl".to_string(),
        big(0, 200, 1),
        big(0, 179, 1),
    )];
    assert_eq!(
        pass_mass_loss(&writes(&too_few_of_many), 1000),
        None,
        "21 of 1000 is not more than 10%"
    );
    let twenty = vec![(
        ".amby/properties/prop_a.jsonl".to_string(),
        big(0, 200, 1),
        big(0, 180, 1),
    )];
    assert_eq!(
        pass_mass_loss(&writes(&twenty), 199).map(|m| m.properties),
        Some(20),
        "20 of 199 is more than 10%"
    );
}

#[test]
fn losses_in_many_groups_with_one_or_two_notes_add_up() {
    // З32: 30 groups lose two properties each; no group alone comes near 20, the pass does
    let items = pass_of(30, 30);
    for one in &items {
        assert_eq!(
            pass_mass_loss(&writes(std::slice::from_ref(one)), 60),
            None,
            "one group alone"
        );
    }
    assert_eq!(
        pass_mass_loss(&writes(&items), 60),
        Some(MassLoss {
            properties: 60,
            notes: 30
        })
    );
    // 9 of 30 groups: 18 properties, below twenty
    assert_eq!(pass_mass_loss(&writes(&pass_of(30, 9)), 60), None);
    // 10 of 30 groups: 20 properties of 60
    assert_eq!(
        pass_mass_loss(&writes(&pass_of(30, 10)), 60).map(|m| m.properties),
        Some(20)
    );
}

#[test]
fn a_one_sided_replacement_of_every_group_is_a_loss() {
    // З32: «одно устройство стёрло всё, другое ничего не трогало» — not a merge but a replacement
    // of 256 files; each file is `after = no records`, or no file at all
    let items: Vec<(String, Vec<u8>, Vec<u8>)> = (0..256)
        .map(|g| {
            let after = if g % 2 == 0 { empty() } else { Vec::new() };
            (
                format!(".amby/properties/prop_{:x}.jsonl", g % 16),
                big(g, 1, 1),
                after,
            )
        })
        .collect();
    assert_eq!(
        pass_mass_loss(&writes(&items), 256),
        Some(MassLoss {
            properties: 256,
            notes: 256
        })
    );
}

#[test]
fn nothing_vanishing_never_stops_a_pass() {
    // З32: additions and edits of any size
    let items: Vec<(String, Vec<u8>, Vec<u8>)> = (0..100)
        .map(|g| {
            (
                format!(".amby/properties/prop_{:x}.jsonl", g % 16),
                big(g, 1, 1),
                big(g, 1, 3),
            )
        })
        .collect();
    assert_eq!(pass_mass_loss(&writes(&items), 100), None);
    assert_eq!(pass_mass_loss(&[], 0), None);
}
