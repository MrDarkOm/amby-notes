//! Properties of the merge of the groups of note properties (docs/sync-plan.md, appendix З: З16,
//! З30, как в Ж.8 и Г15), checked on many generated groups: `merge(x,x,x)=x`, a side that did not
//! change, equal sides, symmetry, no record is lost, the answer follows an exact model of the
//! records, the result is canonical. Red until `props_groups` is written (`todo!()` today).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_core::engine::props_groups::{canonicalize_group, merge_group, GroupMergeOutcome};
use proptest::prelude::*;
use serde_json::{json, Map, Value};

const IDS: [&str; 6] = ["A", "B", "C", "D", "E", "F"];

/// Records are drawn from a small pool: equal draws are equal records, different draws differ.
fn record(n: usize) -> Value {
    let props: Vec<Value> = (0..n % 3)
        .map(|i| {
            json!({"id": format!("P{n}-{i}"), "name": format!("Имя {n} {i}"), "icon": "📌",
                   "propertyType": "text", "settings": format!("s{n}")})
        })
        .collect();
    json!({"hint": {"path": "N.md", "title": "N"}, "properties": props})
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

fn bytes(shape: &Shape, pretty: bool) -> Vec<u8> {
    let mut notes = Map::new();
    for (id, s) in IDS.iter().zip(shape) {
        if let Some(n) = s {
            notes.insert(id.to_string(), record(*n));
        }
    }
    let value = json!({"version": 1, "notes": notes});
    let mut out = if pretty {
        serde_json::to_vec_pretty(&value).unwrap()
    } else {
        serde_json::to_vec(&value).unwrap()
    };
    out.push(b'\n');
    out
}

fn parsed(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
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
        prop_assert_eq!(merge_group(&x, &x, &x), GroupMergeOutcome::Clean(x));
    }

    #[test]
    fn a_side_that_did_not_change_gives_the_other_side_byte_for_byte((b, a, _r) in triple()) {
        // З30 (Ж11), Ж.8 (б)
        prop_assume!(parsed(&bytes(&a, true)) != parsed(&bytes(&b, true)));
        let (base, a_bytes) = (bytes(&b, true), bytes(&a, false));
        prop_assert_eq!(merge_group(&base, &a_bytes, &base), GroupMergeOutcome::Clean(a_bytes.clone()));
        prop_assert_eq!(merge_group(&base, &base, &a_bytes), GroupMergeOutcome::Clean(a_bytes));
    }

    #[test]
    fn equal_sides_give_that_side((b, a, _r) in triple()) {
        // Ж.8 (в)
        let (base, a_bytes) = (bytes(&b, true), bytes(&a, true));
        prop_assert_eq!(merge_group(&base, &a_bytes, &a_bytes), GroupMergeOutcome::Clean(a_bytes));
    }

    #[test]
    fn the_merge_is_symmetric((b, l, r) in triple()) {
        // Ж.8 (г)
        let (base, lb, rb) = (bytes(&b, true), bytes(&l, true), bytes(&r, true));
        prop_assert_eq!(merge_group(&base, &lb, &rb), merge_group(&base, &rb, &lb));
    }

    #[test]
    fn the_answer_follows_the_model_and_no_record_is_lost((b, l, r) in triple()) {
        // З16, Ж.8 (д): a clean result holds, for every record, what the only changing side
        // wrote; a conflict names exactly the records changed differently
        let (base, lb, rb) = (bytes(&b, true), bytes(&l, true), bytes(&r, true));
        match (model(&b, &l, &r), merge_group(&base, &lb, &rb)) {
            (Ok(expected), GroupMergeOutcome::Clean(out)) => {
                let want = parsed(&bytes(&expected, true));
                prop_assert_eq!(parsed(&out)["notes"].clone(), want["notes"].clone());
                prop_assert_eq!(&parsed(&out)["version"], &json!(1));
            }
            (Err(ids), GroupMergeOutcome::Conflict(found)) => {
                prop_assert_eq!(found.notes, ids);
            }
            (m, got) => prop_assert!(false, "model {:?} but the merge said {:?}", m, got),
        }
    }

    #[test]
    fn a_clean_result_is_canonical_and_idempotent((b, l, r) in triple()) {
        // З8, Ж.8 (е, ж): the app reads it and writes the same bytes
        let (base, lb, rb) = (bytes(&b, true), bytes(&l, false), bytes(&r, true));
        if let GroupMergeOutcome::Clean(out) = merge_group(&base, &lb, &rb) {
            if lb != base && rb != base && lb != rb && parsed(&lb) != parsed(&rb) {
                prop_assert_eq!(canonicalize_group(&out).unwrap(), out);
            }
        }
    }
}
