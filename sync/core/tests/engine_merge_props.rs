//! Properties of the merge of a note (docs/sync-plan.md, appendix Г, К1: Г12–Г15), checked on many
//! generated notes. Two kinds: laws that hold for **any** text (a merge with itself, a side that
//! did not change, symmetry, nothing but lines of the inputs, no marks), and an exact model for
//! notes whose lines are all different, where the alignment is unique and the expected bytes can
//! be built by hand. Red until `merge_text` is written: it is `todo!()` today.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_core::engine::merge::{merge_text, MergeOutcome};
use proptest::prelude::*;

// ----- laws for any text -----

/// Text with the characters that make lines hard: letters of a tiny alphabet (so lines repeat),
/// `\n`, `\r`, spaces and a few non-ASCII characters.
fn any_text() -> impl Strategy<Value = String> {
    proptest::collection::vec(
        prop_oneof![
            4 => Just('a'),
            4 => Just('b'),
            3 => Just('\n'),
            1 => Just('\r'),
            1 => Just(' '),
            1 => Just('я'),
            1 => Just('🙂'),
        ],
        0..60,
    )
    .prop_map(|chars| chars.into_iter().collect())
}

fn bytes(text: &str) -> &[u8] {
    text.as_bytes()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    #[test]
    fn merging_a_note_with_itself_changes_nothing(x in any_text()) {
        // Г15 а
        prop_assert_eq!(merge_text(bytes(&x), bytes(&x), bytes(&x)), MergeOutcome::Clean(x.clone().into_bytes()));
    }

    #[test]
    fn a_side_that_did_not_change_gives_the_other_side(base in any_text(), edited in any_text()) {
        // Г13, Г15 б
        prop_assert_eq!(merge_text(bytes(&base), bytes(&edited), bytes(&base)), MergeOutcome::Clean(edited.clone().into_bytes()));
        prop_assert_eq!(merge_text(bytes(&base), bytes(&base), bytes(&edited)), MergeOutcome::Clean(edited.clone().into_bytes()));
    }

    #[test]
    fn the_same_edit_on_both_sides_gives_that_edit(base in any_text(), edited in any_text()) {
        // Г15 в
        prop_assert_eq!(merge_text(bytes(&base), bytes(&edited), bytes(&edited)), MergeOutcome::Clean(edited.clone().into_bytes()));
    }

    #[test]
    fn swapping_the_sides_never_changes_the_answer(base in any_text(), local in any_text(), remote in any_text()) {
        // Г15 г: the same clean bytes, or the same conflict
        prop_assert_eq!(
            merge_text(bytes(&base), bytes(&local), bytes(&remote)),
            merge_text(bytes(&base), bytes(&remote), bytes(&local))
        );
    }

    #[test]
    fn a_clean_merge_has_only_lines_of_the_three_versions(base in any_text(), local in any_text(), remote in any_text()) {
        // Г15 е: nothing is invented
        if let MergeOutcome::Clean(out) = merge_text(bytes(&base), bytes(&local), bytes(&remote)) {
            let out = String::from_utf8(out).expect("text in, text out");
            let known: std::collections::BTreeSet<&str> = base
                .split_inclusive('\n')
                .chain(local.split_inclusive('\n'))
                .chain(remote.split_inclusive('\n'))
                .collect();
            for line in out.split_inclusive('\n') {
                prop_assert!(known.contains(line), "{line:?} is in none of the inputs");
            }
        }
    }

    #[test]
    fn the_answer_is_always_one_of_the_three_kinds_and_repeats(base in any_text(), local in any_text(), remote in any_text()) {
        // Г18: a pure function, no panic on any text
        let first = merge_text(bytes(&base), bytes(&local), bytes(&remote));
        let again = merge_text(bytes(&base), bytes(&local), bytes(&remote));
        prop_assert_eq!(first, again);
    }
}

// ----- an exact model for notes of different lines -----

#[derive(Debug, Clone)]
enum Op {
    Replace(Vec<String>),
    Delete,
}

/// What one side did to a base of `n` lines: per line an operation or nothing, and insertions at
/// gaps (gap `i` is before line `i`, gap `n` after the last line) where **neither** neighbour
/// line is touched by the same side, so every hunk is either a run of touched lines or a pure
/// insertion.
#[derive(Debug, Clone)]
struct Plan {
    ops: Vec<Option<Op>>,
    inserts: Vec<Option<Vec<String>>>,
}

fn terminator() -> impl Strategy<Value = &'static str> {
    prop_oneof![3 => Just("\n"), 1 => Just("\r\n")]
}

fn new_lines(tag: &'static str) -> impl Strategy<Value = Vec<String>> {
    proptest::collection::vec((terminator(), 0u32..1000), 1..3).prop_map(move |items| {
        items
            .into_iter()
            .map(|(eol, k)| format!("{tag}-new-{k}{eol}"))
            .collect()
    })
}

fn plan(n: usize, tag: &'static str) -> impl Strategy<Value = Plan> {
    let ops = proptest::collection::vec(
        prop_oneof![
            6 => Just(None),
            2 => new_lines(tag).prop_map(|l| Some(Op::Replace(l))),
            1 => Just(Some(Op::Delete)),
        ],
        n,
    );
    let inserts = proptest::collection::vec(
        prop_oneof![6 => Just(None), 1 => new_lines(tag).prop_map(Some)],
        n + 1,
    );
    (ops, inserts).prop_map(move |(mut ops, mut inserts)| {
        // An insertion next to a touched line of the same side would be part of that run.
        for i in 0..=n {
            let before = i > 0 && ops[i - 1].is_some();
            let after = i < n && ops[i].is_some();
            if before || after {
                inserts[i] = None;
            }
        }
        // Every line a side writes is different from every other line of the case: the slot is
        // in its text (the alignment is unique only then).
        for (i, op) in ops.iter_mut().enumerate() {
            if let Some(Op::Replace(lines)) = op {
                for (j, line) in lines.iter_mut().enumerate() {
                    let eol = if line.ends_with("\r\n") { "\r\n" } else { "\n" };
                    *line = format!("{tag}-op{i}-{j}{eol}");
                }
            }
        }
        for (g, ins) in inserts.iter_mut().enumerate() {
            if let Some(lines) = ins {
                for (j, line) in lines.iter_mut().enumerate() {
                    let eol = if line.ends_with("\r\n") { "\r\n" } else { "\n" };
                    *line = format!("{tag}-ins{g}-{j}{eol}");
                }
            }
        }
        Plan { ops, inserts }
    })
}

fn base_lines(n: usize, seed: &[(&'static str, u32)]) -> Vec<String> {
    (0..n)
        .map(|i| format!("base-{i}-{}{}", seed[i].1, seed[i].0))
        .collect()
}

fn apply(base: &[String], side: &Plan) -> String {
    let mut out = String::new();
    for i in 0..=base.len() {
        if let Some(lines) = &side.inserts[i] {
            lines.iter().for_each(|l| out.push_str(l));
        }
        if i < base.len() {
            match &side.ops[i] {
                None => out.push_str(&base[i]),
                Some(Op::Replace(lines)) => lines.iter().for_each(|l| out.push_str(l)),
                Some(Op::Delete) => {}
            }
        }
    }
    out
}

#[derive(Debug, Clone, Copy)]
struct Hunk {
    start: usize,
    end: usize,
    /// Does it write any text (a replacement or an insertion)?
    text: bool,
}

fn hunks(n: usize, side: &Plan) -> Vec<Hunk> {
    let mut out = Vec::new();
    let mut i = 0;
    while i <= n {
        if side.inserts[i].is_some() {
            out.push(Hunk {
                start: i,
                end: i,
                text: true,
            });
            i += 1;
            continue;
        }
        if i < n && side.ops[i].is_some() {
            let start = i;
            let mut text = false;
            while i < n && side.ops[i].is_some() {
                text |= matches!(side.ops[i], Some(Op::Replace(_)));
                i += 1;
            }
            out.push(Hunk {
                start,
                end: i,
                text,
            });
            continue;
        }
        i += 1;
    }
    out
}

/// Appendix Г, Г12 п. 5: do two hunks edit the same place?
fn intersect(a: &Hunk, b: &Hunk) -> bool {
    match (a.end > a.start, b.end > b.start) {
        (true, true) => a.start < b.end && b.start < a.end,
        (false, false) => a.start == b.start,
        (false, true) => b.start < a.start && a.start < b.end,
        (true, false) => a.start < b.start && b.start < a.end,
    }
}

/// The identical edits of Г12 п. 5 that can happen here: the same lines deleted by both.
fn identical(a: &Hunk, b: &Hunk) -> bool {
    a.start == b.start && a.end == b.end && !a.text && !b.text
}

fn model_conflicts(n: usize, local: &Plan, remote: &Plan) -> bool {
    let (l, r) = (hunks(n, local), hunks(n, remote));
    l.iter()
        .any(|a| r.iter().any(|b| intersect(a, b) && !identical(a, b)))
}

/// The bytes a clean merge must have: the base with both plans applied.
fn model_merge(base: &[String], local: &Plan, remote: &Plan) -> String {
    let mut out = String::new();
    for i in 0..=base.len() {
        for side in [local, remote] {
            if let Some(lines) = &side.inserts[i] {
                lines.iter().for_each(|l| out.push_str(l));
            }
        }
        if i < base.len() {
            let touched = [&local.ops[i], &remote.ops[i]];
            match (touched[0], touched[1]) {
                (None, None) => out.push_str(&base[i]),
                (Some(Op::Replace(lines)), None) | (None, Some(Op::Replace(lines))) => {
                    lines.iter().for_each(|l| out.push_str(l))
                }
                (Some(Op::Delete), None) | (None, Some(Op::Delete)) => {}
                (Some(Op::Delete), Some(Op::Delete)) => {}
                other => unreachable!("the model says conflict: {other:?}"),
            }
        }
    }
    out
}

fn case() -> impl Strategy<Value = (Vec<String>, Plan, Plan)> {
    (2usize..14).prop_flat_map(|n| {
        let seed = proptest::collection::vec((terminator(), 0u32..1000), n);
        (seed, plan(n, "L"), plan(n, "R"))
            .prop_map(move |(seed, local, remote)| (base_lines(n, &seed), local, remote))
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(600))]

    #[test]
    fn the_merge_of_notes_of_different_lines_follows_the_model((base, local, remote) in case()) {
        // Г4, Г11, Г12, Г14, Г15 д: conflict exactly when the same place was edited; otherwise the
        // base with both plans applied, byte for byte, in both directions
        let (b, l, r) = (base.concat(), apply(&base, &local), apply(&base, &remote));
        let n = base.len();
        let expected_conflict = model_conflicts(n, &local, &remote);
        let got = merge_text(b.as_bytes(), l.as_bytes(), r.as_bytes());
        let swapped = merge_text(b.as_bytes(), r.as_bytes(), l.as_bytes());
        prop_assert_eq!(&got, &swapped, "symmetry");
        if expected_conflict {
            prop_assert!(matches!(got, MergeOutcome::Conflict(_)), "expected a conflict, got {:?}\nbase {:?}\nlocal {:?}\nremote {:?}", got, b, l, r);
        } else {
            let expected = model_merge(&base, &local, &remote);
            prop_assert_eq!(got, MergeOutcome::Clean(expected.into_bytes()), "\nbase {:?}\nlocal {:?}\nremote {:?}", b, l, r);
        }
    }

    #[test]
    fn a_clean_merge_of_notes_of_different_lines_loses_no_edit_and_brings_back_no_deletion((base, local, remote) in case()) {
        // Г15 д: every line a side wrote is in the result once; no line a side removed is
        let (b, l, r) = (base.concat(), apply(&base, &local), apply(&base, &remote));
        if let MergeOutcome::Clean(out) = merge_text(b.as_bytes(), l.as_bytes(), r.as_bytes()) {
            let out = String::from_utf8(out).unwrap();
            let count = |line: &str| out.split_inclusive('\n').filter(|x| *x == line).count();
            for text in [&l, &r] {
                for line in text.split_inclusive('\n').filter(|x| !b.split_inclusive('\n').any(|y| y == *x)) {
                    prop_assert_eq!(count(line), 1, "the edit {:?} must be in the result once", line);
                }
            }
            for text in [&l, &r] {
                for line in b.split_inclusive('\n').filter(|x| !text.split_inclusive('\n').any(|y| y == *x)) {
                    prop_assert_eq!(count(line), 0, "the deleted line {:?} must not come back", line);
                }
            }
        }
    }

    #[test]
    fn no_conflict_mark_appears_out_of_nothing((base, local, remote) in case()) {
        // Г15 е, Г20
        let (b, l, r) = (base.concat(), apply(&base, &local), apply(&base, &remote));
        if let MergeOutcome::Clean(out) = merge_text(b.as_bytes(), l.as_bytes(), r.as_bytes()) {
            let out = String::from_utf8(out).unwrap();
            for mark in ["<<<<<<<", "=======", ">>>>>>>"] {
                prop_assert!(!out.contains(mark));
            }
        }
    }
}
