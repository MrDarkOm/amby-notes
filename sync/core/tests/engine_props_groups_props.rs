//! Properties of the merge of the files of note properties (docs/sync-plan.md, appendix З: З16,
//! З30, З49, З52, как в Ж.8 и Г15), checked on many generated groups: `merge(x,x,x)=x`, a side that did not
//! change, equal sides, symmetry, no record is lost, the answer follows an exact model of the
//! records, the result is canonical. Red until `props_groups` is written (`todo!()` today).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_core::engine::props_groups::{merge_group, GroupKind, GroupMergeOutcome};
use proptest::prelude::*;
use serde_json::{json, Map, Value};

const IDS: [&str; 6] = ["A", "B", "C", "D", "E", "F"];

/// Lines are drawn from a small pool: equal draws are equal lines, different draws differ.
fn record(id: &str, n: usize) -> Value {
    // 1–3 properties, never none: a line without props is not stored (З47); different n differ
    let props: Map<String, Value> = (0..1 + n % 3)
        .map(|i| {
            (
                format!("Имя {n} {i}"),
                json!({"icon": format!("i{n}"), "settings": format!("s{n}")}),
            )
        })
        .collect();
    json!({"id": id, "hint": {"path": "N.md"}, "props": props})
}

/// A group: for each of the six ids, no record or the record number `k` (0..5).
type Shape = Vec<Option<usize>>;

fn shape() -> impl Strategy<Value = Shape> {
    proptest::collection::vec(proptest::option::of(0usize..6), IDS.len())
}

/// A side: starts from the base and, per id, either stays or takes a new draw.
fn side(base: Shape) -> impl Strategy<Value = Shape> {
    proptest::collection::vec(
        prop_oneof![3 => Just(None::<Option<usize>>), 2 => proptest::option::of(0usize..6).prop_map(Some)],
        IDS.len(),
    )
    .prop_map(move |edits| {
        base.iter()
            .zip(edits)
            .map(|(b, e)| e.unwrap_or(*b))
            .collect()
    })
}

fn triple() -> impl Strategy<Value = (Shape, Shape, Shape)> {
    shape().prop_flat_map(|b| (Just(b.clone()), side(b.clone()), side(b)))
}

/// The file of a shape; `pretty` puts spaces into the lines (equal by meaning, not canonical).
fn bytes(shape: &Shape, pretty: bool) -> Vec<u8> {
    let mut text = String::from("{\"version\":1}\n");
    for (id, s) in IDS.iter().zip(shape) {
        if let Some(n) = s {
            text.push_str(&serde_json::to_string(&record(id, *n)).unwrap());
            text.push('\n');
        }
    }
    if pretty {
        text = text.replace("\":", "\": ");
    }
    text.into_bytes()
}

fn lines(bytes: &[u8]) -> Vec<Value> {
    String::from_utf8(bytes.to_vec())
        .unwrap()
        .lines()
        .skip(1)
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// The exact model of З16: per record, the side that changed it; both changed differently — a
/// conflict of that record.
fn model(b: &Shape, l: &Shape, r: &Shape) -> Result<Shape, Vec<String>> {
    let mut out = Vec::new();
    let mut conflicts = Vec::new();
    for i in 0..IDS.len() {
        let pick = if l[i] == b[i] {
            r[i]
        } else if r[i] == b[i] || l[i] == r[i] {
            l[i]
        } else {
            conflicts.push(IDS[i].to_string());
            None
        };
        out.push(pick);
    }
    if conflicts.is_empty() {
        Ok(out)
    } else {
        Err(conflicts)
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn merging_a_group_with_itself_gives_it_back(s in shape()) {
        // З16, Ж.8 (а)
        let x = bytes(&s, true);
        prop_assert_eq!(merge_group(GroupKind::Props, &x, &x, &x), GroupMergeOutcome::Clean(x));
    }

    #[test]
    fn a_side_that_did_not_change_gives_the_other_side_byte_for_byte((b, a, _r) in triple()) {
        // З30 (Ж11), Ж.8 (б)
        prop_assume!(lines(&bytes(&a, true)) != lines(&bytes(&b, true)));
        let (base, a_bytes) = (bytes(&b, true), bytes(&a, false));
        prop_assert_eq!(merge_group(GroupKind::Props, &base, &a_bytes, &base), GroupMergeOutcome::Clean(a_bytes.clone()));
        prop_assert_eq!(merge_group(GroupKind::Props, &base, &base, &a_bytes), GroupMergeOutcome::Clean(a_bytes));
    }

    #[test]
    fn equal_sides_give_that_side((b, a, _r) in triple()) {
        // Ж.8 (в)
        let (base, a_bytes) = (bytes(&b, true), bytes(&a, true));
        prop_assert_eq!(merge_group(GroupKind::Props, &base, &a_bytes, &a_bytes), GroupMergeOutcome::Clean(a_bytes));
    }

    #[test]
    fn the_merge_is_symmetric((b, l, r) in triple()) {
        // Ж.8 (г)
        let (base, lb, rb) = (bytes(&b, true), bytes(&l, true), bytes(&r, true));
        prop_assert_eq!(merge_group(GroupKind::Props, &base, &lb, &rb), merge_group(GroupKind::Props, &base, &rb, &lb));
    }

    #[test]
    fn the_answer_follows_the_model_and_no_record_is_lost((b, l, r) in triple()) {
        // З16, Ж.8 (д): a clean result holds, for every record, what the only changing side
        // wrote; a conflict names exactly the records changed differently
        let (base, lb, rb) = (bytes(&b, true), bytes(&l, true), bytes(&r, true));
        match (model(&b, &l, &r), merge_group(GroupKind::Props, &base, &lb, &rb)) {
            (Ok(expected), GroupMergeOutcome::Clean(out)) => {
                prop_assert_eq!(lines(&out), lines(&bytes(&expected, true)));
                // the first line is compared by meaning: a short path returns the bytes of a side (З52)
                let first = String::from_utf8(out).unwrap();
                let first: Value = serde_json::from_str(first.lines().next().unwrap()).unwrap();
                prop_assert_eq!(first, json!({"version": 1}));
            }
            (Err(ids), GroupMergeOutcome::Conflict(found)) => {
                prop_assert_eq!(found.notes, ids);
            }
            (m, got) => prop_assert!(false, "model {:?} but the merge said {:?}", m, got),
        }
    }

    #[test]
    fn untouched_lines_keep_their_bytes_and_the_lines_stay_sorted((b, l, r) in triple()) {
        // З52, З48: a line taken from a side comes with its bytes, the file is sorted by id
        let (base, lb, rb) = (bytes(&b, false), bytes(&l, true), bytes(&r, true));
        if let GroupMergeOutcome::Clean(out) = merge_group(GroupKind::Props, &base, &lb, &rb) {
            let text = String::from_utf8(out).unwrap();
            let ids: Vec<String> = text.lines().skip(1).map(|x| serde_json::from_str::<Value>(x).unwrap()["id"].as_str().unwrap().to_string()).collect();
            let mut sorted = ids.clone();
            sorted.sort();
            prop_assert_eq!(ids, sorted);
            let sources: Vec<String> = [&base, &lb, &rb].iter().flat_map(|f| String::from_utf8_lossy(f).lines().skip(1).map(str::to_string).collect::<Vec<_>>()).collect();
            for l in text.lines().skip(1) {
                prop_assert!(sources.iter().any(|s| s == l), "a line of nobody: {}", l);
            }
        }
    }

    #[test]
    fn every_line_of_a_clean_result_is_a_line_of_a_version_or_canonical((b, l, r) in triple()) {
        // З49, З52, Ж.8 (е, ж): a line carried over keeps the bytes of its side; a line made anew
        // is canonical (compact, keys ascending)
        let (base, lb, rb) = (bytes(&b, true), bytes(&l, false), bytes(&r, true));
        if let GroupMergeOutcome::Clean(out) = merge_group(GroupKind::Props, &base, &lb, &rb) {
            let sources: Vec<String> = [&base, &lb, &rb]
                .iter()
                .flat_map(|f| String::from_utf8_lossy(f).lines().skip(1).map(str::to_string).collect::<Vec<_>>())
                .collect();
            for l in String::from_utf8(out).unwrap().lines().skip(1) {
                let canonical = serde_json::to_string(&serde_json::from_str::<Value>(l).unwrap()).unwrap();
                prop_assert!(sources.iter().any(|s| s == l) || l == canonical, "{}", l);
            }
        }
    }

    #[test]
    fn the_bytes_do_not_depend_on_the_side_when_the_formatting_differs((b, l, r) in triple()) {
        // З52, Ж.8 (г): merge(b,l,r) == merge(b,r,l) byte for byte, with sides written differently
        let (base, lb, rb) = (bytes(&b, false), bytes(&l, true), bytes(&r, false));
        prop_assert_eq!(
            merge_group(GroupKind::Props, &base, &lb, &rb),
            merge_group(GroupKind::Props, &base, &rb, &lb)
        );
    }
}
