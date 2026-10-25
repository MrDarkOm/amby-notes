//! Tests written for the mutants of `engine/merge.rs` that survived the trial run of the gates
//! (docs/Road/sync-gates-survivors-report.md): the borders of the line comparison, the places
//! (fences, tables, formulas, keys of the header), the widening of the edits, the join of the edits
//! of one side. Several mutants of these loops make them endless, so every call is bounded in time:
//! an endless loop is a red test here, not a timeout of the whole run.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_core::engine::merge::{merge_text, MergeOutcome, NotMergeable, Region};
use std::sync::mpsc;
use std::time::Duration;

/// `merge_text` that gives up after a while: a loop that does not end fails the test.
#[track_caller]
fn run(base: &str, local: &str, remote: &str) -> MergeOutcome {
    let (b, l, r) = (
        base.as_bytes().to_vec(),
        local.as_bytes().to_vec(),
        remote.as_bytes().to_vec(),
    );
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(merge_text(&b, &l, &r));
    });
    rx.recv_timeout(Duration::from_secs(6))
        .unwrap_or_else(|_| panic!("the merge did not end (an endless loop) for {base:?}"))
}

#[track_caller]
fn clean(base: &str, local: &str, remote: &str) -> String {
    let swapped = run(base, remote, local);
    match run(base, local, remote) {
        MergeOutcome::Clean(bytes) => {
            assert_eq!(
                swapped,
                MergeOutcome::Clean(bytes.clone()),
                "the merge is symmetric"
            );
            String::from_utf8(bytes).unwrap()
        }
        other => panic!("expected a clean merge of {base:?} {local:?} {remote:?}, got {other:?}"),
    }
}

#[track_caller]
fn conflict(base: &str, local: &str, remote: &str) -> Vec<Region> {
    let swapped = run(base, remote, local);
    match run(base, local, remote) {
        MergeOutcome::Conflict(regions) => {
            assert_eq!(
                swapped,
                MergeOutcome::Conflict(regions.clone()),
                "the conflict is symmetric"
            );
            regions
        }
        other => panic!("expected a conflict of {base:?} {local:?} {remote:?}, got {other:?}"),
    }
}

/// `n` numbered lines.
fn lines(prefix: &str, n: usize) -> String {
    (0..n).map(|i| format!("{prefix}{i}\n")).collect()
}

// ----- the comparison of lines (diff) -----

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn edits_far_apart_in_distinct_lines_are_all_kept() {
    // Г11, Г12: the edits of two sides in different places of a note of distinct lines are both in
    // the result, whatever their kind (a replaced line, a removed one, an inserted one). The
    // expected text is built line by line without the merge.
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for case in 0..400 {
        let n = 6 + rng.below(30) as usize;
        let mut base = String::new();
        let (mut local, mut remote, mut expected) = (String::new(), String::new(), String::new());
        let mut last_edit: i64 = -10;
        let mut edits = 0;
        for i in 0..n {
            let line = format!("L{i}\n");
            base.push_str(&line);
            let edit = if (i as i64) - last_edit >= 2 && rng.below(3) == 0 {
                last_edit = i as i64;
                edits += 1;
                Some((rng.below(3), rng.below(2) == 0))
            } else {
                None
            };
            let (mut l, mut r) = (line.clone(), line.clone());
            let mut x = line.clone();
            if let Some((kind, by_local)) = edit {
                let new = match kind {
                    0 => format!("L{i}-changed\n"),
                    1 => String::new(),
                    _ => format!("I{i}\n{line}"),
                };
                x = new.clone();
                if by_local {
                    l = new;
                } else {
                    r = new;
                }
            }
            local.push_str(&l);
            remote.push_str(&r);
            expected.push_str(&x);
        }
        if edits < 2 || local == base || remote == base {
            continue;
        }
        let got = clean(&base, &local, &remote);
        assert_eq!(got, expected, "case {case}: base {base:?}");
    }
}

#[test]
fn an_edit_in_the_middle_of_a_long_note_does_not_touch_the_edges() {
    // The comparison cuts the common beginning and end: an edit at the first line, one at the last
    // line, one in the middle: three hunks of two sides.
    let base = lines("L", 12);
    let local = base.replacen("L0\n", "first\n", 1).replace("L11\n", "last\n");
    let remote = base.replacen("L6\n", "middle\n", 1);
    let got = clean(&base, &local, &remote);
    assert_eq!(
        got,
        "first\nL1\nL2\nL3\nL4\nL5\nmiddle\nL7\nL8\nL9\nL10\nlast\n"
    );
}

#[test]
fn a_moved_block_of_lines_is_found_by_the_longest_common_subsequence() {
    // Lines of the middle are kept in place: the other side edits one of them.
    let base = "a\nb\nc\nd\ne\nf\ng\nh\n";
    let local = "a\nx\nc\nd\ne\nf\ny\nh\n";
    let remote = "a\nb\nc\nD\ne\nf\ng\nh\n";
    assert_eq!(clean(base, local, remote), "a\nx\nc\nD\ne\nf\ny\nh\n");
    // Repeated lines: the comparison still keeps the matches in order.
    let base = "x\ny\nx\ny\nx\ny\nz\n";
    let local = "x\ny\nx\ny\nx\ny\nz\nlocal\n";
    let remote = "top\nx\ny\nx\ny\nx\ny\nz\n";
    assert_eq!(
        clean(base, local, remote),
        "top\nx\ny\nx\ny\nx\ny\nz\nlocal\n"
    );
}

#[test]
fn the_comparison_of_exactly_the_limit_of_cells_is_still_made() {
    // Г12 п. 7: 25 million cells (5000 × 5000 lines with nothing in common) is the largest
    // comparison that is tried; one more line is "too complex".
    let base = lines("b", 5000);
    let local = lines("l", 5000);
    let remote = base.replacen("b2500\n", "r\n", 1);
    let got = run(&base, &local, &remote);
    assert!(
        !matches!(got, MergeOutcome::NotMergeable(_)),
        "exactly 25 000 000 cells must be compared, got {got:?}"
    );
    let local = lines("l", 5001);
    assert_eq!(
        run(&base, &local, &remote),
        MergeOutcome::NotMergeable(NotMergeable::TooComplex)
    );
}

// ----- fences -----

#[test]
fn a_fence_indented_by_three_spaces_opens_a_block_and_by_four_does_not() {
    // Г11: up to three spaces before the fence; four are a block of code by indent, not a fence.
    let open3 = "   ```\ncode-a\ncode-b\n   ```\ntail\n";
    // Two edits inside the block conflict ...
    conflict(
        open3,
        &open3.replace("code-a", "A"),
        &open3.replace("code-b", "B"),
    );
    // ... and an indent of four does not make a block: the same edits merge.
    let open4 = "    ```\ncode-a\ncode-b\n    ```\ntail\n";
    assert_eq!(
        clean(
            open4,
            &open4.replace("code-a", "A"),
            &open4.replace("code-b", "B")
        ),
        "    ```\nA\nB\n    ```\ntail\n"
    );
    let open5 = "     ```\ncode-a\ncode-b\n     ```\ntail\n";
    clean(
        open5,
        &open5.replace("code-a", "A"),
        &open5.replace("code-b", "B"),
    );
}

#[test]
fn a_closing_fence_may_be_indented_by_three_spaces_and_not_by_four() {
    let closed3 = "```\ncode\n   ```\ntail-a\ntail-b\n";
    // The block ends at the closing fence: the tail merges, the code does not conflict with it.
    assert_eq!(
        clean(
            closed3,
            &closed3.replace("code", "CODE"),
            &closed3.replace("tail-b", "B")
        ),
        "```\nCODE\n   ```\ntail-a\nB\n"
    );
    // Four spaces do not close it: the block goes on to the next fence.
    let closed4 = "```\ncode\n    ```\ntail-a\n```\ntail-b\n";
    conflict(
        closed4,
        &closed4.replace("code", "CODE"),
        &closed4.replace("tail-a", "A"),
    );
}

#[test]
fn only_blanks_may_follow_a_closing_fence() {
    for closing in ["```  ", "```\t", "```  \t "] {
        let base = format!("```\ncode\n{closing}\ntail\n");
        assert_eq!(
            clean(
                &base,
                &base.replace("code", "C"),
                &base.replace("tail", "T")
            ),
            format!("```\nC\n{closing}\nT\n"),
            "{closing:?} closes the block"
        );
    }
    // Any other text after the fence: the line does not close the block.
    let base = "```\ncode\n``` x\ntail\n```\nafter\n";
    conflict(
        base,
        &base.replace("tail", "T"),
        &base.replace("code", "C"),
    );
    // A longer fence closes a shorter one; a shorter one does not close a longer one.
    let base = "````\ncode\n```\ntail\n````\nafter\n";
    conflict(
        base,
        &base.replace("tail", "T"),
        &base.replace("code", "C"),
    );
    let base = "```\ncode\n````\ntail\n";
    clean(base, &base.replace("code", "C"), &base.replace("tail", "T"));
}

#[test]
fn a_fence_at_the_end_of_the_note_without_a_closing_one_runs_to_the_end() {
    let base = "top\n```\ncode-a\ncode-b\n";
    assert_eq!(
        conflict(
            base,
            &base.replace("code-a", "A"),
            &base.replace("code-b", "B")
        ),
        vec![Region { start: 1, end: 4 }]
    );
}

#[test]
fn the_closing_fence_belongs_to_the_block() {
    // An edit of the closing fence line and one inside the block are the same place.
    let base = "```\ncode\n```\nafter\n";
    conflict(
        base,
        &base.replace("code", "C"),
        &base.replacen("```\nafter", "~~~\nafter", 1),
    );
}

// ----- tables and formulas -----

#[test]
fn an_indented_table_is_one_place() {
    let base = "intro\n  | a | b |\n  | - | - |\n\t| 1 | 2 |\nend\n";
    conflict(
        base,
        &base.replace("| a | b |", "| A | B |"),
        &base.replace("| 1 | 2 |", "| 3 | 4 |"),
    );
}

#[test]
fn a_table_at_the_end_of_the_note_and_in_the_middle_is_one_place() {
    // A table that ends at the last line (no line after it) and tables that start late.
    let base = "x\ny\nz\nw\n| a |\n| b |\n| c |\n";
    assert_eq!(
        conflict(
            base,
            &base.replace("| a |", "| A |"),
            &base.replace("| c |", "| C |")
        ),
        vec![Region { start: 4, end: 7 }]
    );
    // A table of two rows that starts at the first line, and one that starts late.
    let base = "| a |\n| b |\ntext\n";
    conflict(
        base,
        &base.replace("| a |", "| A |"),
        &base.replace("| b |", "| B |"),
    );
    let base = "1\n2\n3\n4\n5\n6\n7\n| a |\n| b |\ntext\n";
    conflict(
        base,
        &base.replace("| a |", "| A |"),
        &base.replace("| b |", "| B |"),
    );
    // One row of a pipe is not a table: two edits near it merge.
    let base = "1\n| a |\n2\n";
    assert_eq!(
        clean(base, &base.replace('1', "one"), &base.replace('2', "two")),
        "one\n| a |\ntwo\n"
    );
}

#[test]
fn a_formula_without_its_end_is_not_a_place() {
    // `$$` that is never closed: the lines after it are ordinary lines.
    let base = "$$\nx\ny\nz\n";
    assert_eq!(
        clean(base, &base.replace('x', "X"), &base.replace('z', "Z")),
        "$$\nX\ny\nZ\n"
    );
    let base = "a\nb\nc\n$$\nx\ny\n";
    assert_eq!(
        clean(base, &base.replace('x', "X"), &base.replace('y', "Y")),
        "a\nb\nc\n$$\nX\nY\n"
    );
    // And a closed one is a place.
    let base = "a\n$$\nx\ny\n$$\nb\n";
    conflict(base, &base.replace('x', "X"), &base.replace('y', "Y"));
}

// ----- the header -----

#[test]
fn a_key_of_the_header_with_a_list_is_one_place_wherever_it_stands() {
    let base = "---\na: 1\nb: 2\nc: 3\ntags:\n  - x\n  - y\n---\nbody\n";
    conflict(
        base,
        &base.replace("  - x", "  - X"),
        &base.replace("  - y", "  - Y"),
    );
    // Keys without a list are single lines: they merge.
    assert_eq!(
        clean(base, &base.replace("a: 1", "a: 9"), &base.replace("c: 3", "c: 8")),
        "---\na: 9\nb: 2\nc: 8\ntags:\n  - x\n  - y\n---\nbody\n"
    );
    // The list at the very beginning.
    let base = "---\ntags:\n  - x\n  - y\nz: 1\n---\nbody\n";
    conflict(
        base,
        &base.replace("  - x", "  - X"),
        &base.replace("  - y", "  - Y"),
    );
}

#[test]
fn a_key_with_a_block_of_text_runs_to_the_next_key() {
    // Continuation lines: indented, blank, or starting with `- `.
    let base = "---\ndesc: |\n  one\n\n  two\nnext: 1\nlist:\n- p\n- q\n---\nbody\n";
    conflict(
        base,
        &base.replace("  one", "  ONE"),
        &base.replace("  two", "  TWO"),
    );
    conflict(base, &base.replace("- p", "- P"), &base.replace("- q", "- Q"));
    // `next: 1` is not a part of `desc`.
    assert_eq!(
        clean(base, &base.replace("  one", "  ONE"), &base.replace("next: 1", "next: 2")),
        "---\ndesc: |\n  ONE\n\n  two\nnext: 2\nlist:\n- p\n- q\n---\nbody\n"
    );
}

#[test]
fn the_last_line_of_the_header_is_not_a_line_of_the_body() {
    // A fence-looking line that ends the header is a line of the header, not the start of a block of
    // code in the note.
    let base = "---\nk: |\n  ```\n---\none\ntwo\nthree\n";
    assert_eq!(
        clean(base, &base.replace("one", "ONE"), &base.replace("three", "THREE")),
        "---\nk: |\n  ```\n---\nONE\ntwo\nTHREE\n"
    );
}

#[test]
fn a_blank_line_in_the_header_is_skipped() {
    // The keys of the header are counted for the check of a key added twice (Г13 б); a blank line
    // between them is not a key.
    let base = "---\na: 1\n\nb: 2\n---\nbody\n";
    let local = base.replace("body", "body\nmore");
    let remote = base.replace("b: 2", "b: 3");
    assert_eq!(
        clean(base, &local, &remote),
        "---\na: 1\n\nb: 3\n---\nbody\nmore\n"
    );
    // The same key added by both sides in different places is a conflict (Г13 б).
    let local = base.replace("a: 1\n", "a: 1\nk: 1\n");
    let remote = base.replace("b: 2\n", "b: 2\nk: 2\n");
    assert_eq!(run(base, &local, &remote), MergeOutcome::Conflict(vec![]));
}

// ----- the widening of the edits -----

const BLOCK: &str = "before\ntop\n```\ncode-a\ncode-b\ncode-c\n```\nbottom\nafter\n";

#[test]
fn an_edit_of_the_fence_line_itself_is_an_edit_of_the_block() {
    // The edit starts at the first line of the place and ends inside it.
    let opening = BLOCK.replacen("```\ncode-a", "~~~\ncode-a", 1);
    conflict(BLOCK, &opening, &BLOCK.replace("code-c", "C"));
    let closing = BLOCK.replacen("code-c\n```", "code-c\n~~~", 1);
    conflict(BLOCK, &closing, &BLOCK.replace("code-a", "A"));
}

#[test]
fn an_edit_that_is_exactly_the_block_is_the_block() {
    // The edit and the place have the same range: nothing to widen, and the loop must end.
    let local = BLOCK.replacen("```\ncode-a\ncode-b\ncode-c\n```\n", "new\n", 1);
    conflict(BLOCK, &local, &BLOCK.replace("code-b", "B"));
    assert_eq!(
        clean(BLOCK, &local, &BLOCK.replace("after", "AFTER")),
        "before\ntop\nnew\nbottom\nAFTER\n"
    );
}

#[test]
fn an_edit_touching_a_block_from_outside_does_not_belong_to_it() {
    // The line before the block and the line after it: touching is not overlapping.
    let before = BLOCK.replace("top", "TOP");
    let after = BLOCK.replace("bottom", "BOTTOM");
    let inside = BLOCK.replace("code-b", "B");
    assert_eq!(
        clean(BLOCK, &before, &inside),
        "before\nTOP\n```\ncode-a\nB\ncode-c\n```\nbottom\nafter\n"
    );
    assert_eq!(
        clean(BLOCK, &after, &inside),
        "before\ntop\n```\ncode-a\nB\ncode-c\n```\nBOTTOM\nafter\n"
    );
}

#[test]
fn an_insertion_before_or_after_a_block_does_not_belong_to_it() {
    let inside = BLOCK.replace("code-b", "B");
    let before = BLOCK.replacen("top\n```", "top\nnew\n```", 1);
    let after = BLOCK.replacen("```\nbottom", "```\nnew\nbottom", 1);
    assert_eq!(
        clean(BLOCK, &before, &inside),
        "before\ntop\nnew\n```\ncode-a\nB\ncode-c\n```\nbottom\nafter\n"
    );
    assert_eq!(
        clean(BLOCK, &after, &inside),
        "before\ntop\n```\ncode-a\nB\ncode-c\n```\nnew\nbottom\nafter\n"
    );
}

#[test]
fn an_insertion_inside_a_block_belongs_to_it() {
    let inside = BLOCK.replacen("code-b\n", "code-b\nnew\n", 1);
    conflict(BLOCK, &inside, &BLOCK.replace("code-c", "C"));
    let first = BLOCK.replacen("code-a\n", "new\ncode-a\n", 1);
    // Before the first line of the code, but after the opening fence: inside.
    conflict(BLOCK, &first, &BLOCK.replace("code-b", "B"));
}

#[test]
fn two_edits_of_one_side_in_one_block_are_both_kept() {
    // The two hunks are widened to the same block and joined: the result is made of both.
    let local = BLOCK
        .replace("code-a", "A\nA2\nA3")
        .replace("code-c", "C");
    let remote = BLOCK.replace("after", "AFTER");
    assert_eq!(
        clean(BLOCK, &local, &remote),
        "before\ntop\n```\nA\nA2\nA3\ncode-b\nC\n```\nbottom\nAFTER\n"
    );
    // The first edit is the longer one, the second is shorter.
    let local = BLOCK.replace("code-a", "A").replace("code-c", "C\nC2\nC3\nC4");
    assert_eq!(
        clean(BLOCK, &local, &remote),
        "before\ntop\n```\nA\ncode-b\nC\nC2\nC3\nC4\n```\nbottom\nAFTER\n"
    );
    // Three edits, one of them outside.
    let local = BLOCK
        .replace("code-a", "A")
        .replace("code-b", "B\nB2")
        .replace("before", "BEFORE");
    assert_eq!(
        clean(BLOCK, &local, &remote),
        "BEFORE\ntop\n```\nA\nB\nB2\ncode-c\n```\nbottom\nAFTER\n"
    );
}

#[test]
fn an_edit_that_runs_into_a_block_pulls_the_whole_block_in() {
    // A hunk that starts before the block and ends inside it, and the other way round.
    let local = BLOCK.replacen("top\n```\ncode-a", "T\nX\ncode-a", 1);
    conflict(BLOCK, &local, &BLOCK.replace("code-c", "C"));
    let local = BLOCK.replacen("code-c\n```\nbottom", "C\nbottom", 1);
    conflict(BLOCK, &local, &BLOCK.replace("code-a", "A"));
}

#[test]
fn several_places_are_widened_one_after_another() {
    // An edit that reaches the first block through a table that reaches the second.
    let base = "```\na\n```\n| x |\n| y |\n```\nb\n```\nend\n";
    let local = base.replacen("```\na\n```\n| x |\n| y |\n```\nb\n```", "one\ntwo\nthree", 1);
    conflict(base, &local, &base.replace("\nb\n", "\nB\n"));
    conflict(base, &local, &base.replace("\na\n", "\nA\n"));
}

// ----- conflicts -----

#[test]
fn regions_that_overlap_are_told_as_one() {
    // One edit of a side against two of the other: two pairs, one region.
    let base = "a\nb\nc\nd\ne\nf\n";
    let local = "a\nX\nX\nX\ne\nf\n";
    let remote = "a\nB\nc\nD\ne\nf\n";
    assert_eq!(
        conflict(base, local, remote),
        vec![Region { start: 1, end: 4 }]
    );
    // Two separate regions stay two.
    let local = "a\nX\nc\nd\ne\nY\n";
    let remote = "a\nB\nc\nd\ne\nF\n";
    assert_eq!(
        conflict(base, local, remote),
        vec![Region { start: 1, end: 2 }, Region { start: 5, end: 6 }]
    );
}

#[test]
fn an_edit_that_closes_the_file_conflicts_with_an_insertion_after_it() {
    // Г12 п. 5: the line without `\n` closes the file; nothing may follow it.
    let base = "a\nb\n";
    let local = "a\nb\nc";
    let remote = "a\nb\nd\n";
    conflict(base, local, remote);
    // Not at the end: no conflict.
    let base = "a\nb\nc\n";
    assert_eq!(
        clean(base, "A\nb\nc\n", "a\nb\nc\nd\n"),
        "A\nb\nc\nd\n"
    );
}

#[test]
fn indented_text_is_not_a_fence_when_the_indent_is_spaces_only() {
    // A tab before the fence is not an indent of spaces.
    let base = "\t```\nx\ny\n```\nz\n";
    assert_eq!(
        clean(base, &base.replace('x', "X"), &base.replace('y', "Y")),
        "\t```\nX\nY\n```\nz\n"
    );
}

// ----- the comparison with repeated lines -----

#[test]
fn edits_in_two_far_segments_of_a_note_with_repeated_lines_are_both_kept() {
    // Lines of only a few kinds repeat all over the note, with a numbered line before each segment;
    // each side rewrites one segment. Whatever the order of the matches inside a segment, the
    // result is the base with the two segments replaced.
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    let kinds = ["A\n", "B\n", "C\n"];
    let segment = |rng: &mut Rng, n: usize, kinds: &[&str]| -> String {
        (0..n)
            .map(|_| kinds[rng.below(kinds.len() as u64) as usize])
            .collect()
    };
    for case in 0..1500 {
        let mut segments: Vec<String> = Vec::new();
        for _ in 0..6 {
            let n = 2 + rng.below(6) as usize;
            segments.push(segment(&mut rng, n, &kinds[..2]));
        }
        let join = |segments: &[String]| -> String {
            segments
                .iter()
                .enumerate()
                .map(|(i, s)| format!("@{i}\n{s}"))
                .collect()
        };
        let base = join(&segments);
        let mut local_segments = segments.clone();
        let mut remote_segments = segments.clone();
        let n = 1 + rng.below(7) as usize;
        local_segments[1] = segment(&mut rng, n, &kinds);
        let n = 1 + rng.below(7) as usize;
        remote_segments[4] = segment(&mut rng, n, &kinds);
        let (local, remote) = (join(&local_segments), join(&remote_segments));
        if local == base || remote == base {
            continue;
        }
        let mut expected = segments.clone();
        expected[1] = local_segments[1].clone();
        expected[4] = remote_segments[4].clone();
        assert_eq!(
            clean(&base, &local, &remote),
            join(&expected),
            "case {case}: base {base:?}"
        );
    }
}

#[test]
fn a_long_middle_of_repeated_lines_is_matched_in_order_between_two_far_edits() {
    // One side edits the first and the last line, so the comparison has to match the whole middle,
    // which is made of a few kinds of lines; the other side edits a line in the middle. A match of
    // the middle that is not the longest one would make the first side's edits overlap it.
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    for case in 0..800 {
        let n = 12 + rng.below(30) as usize;
        let kinds = if case % 2 == 0 { 2 } else { 3 };
        let lines: Vec<String> = (0..n)
            .map(|_| format!("{}\n", ["A", "B", "C"][rng.below(kinds) as usize]))
            .collect();
        let base = lines.concat();
        let mid = 3 + rng.below((n - 6) as u64) as usize;
        let mut local = lines.clone();
        local[0] = "FIRST\n".into();
        local[n - 1] = "LAST\n".into();
        let mut remote = lines.clone();
        remote[mid] = "MIDDLE\n".into();
        let mut expected = local.clone();
        expected[mid] = "MIDDLE\n".into();
        let (local, remote) = (local.concat(), remote.concat());
        if remote == base || local == base {
            continue;
        }
        assert_eq!(
            clean(&base, &local, &remote),
            expected.concat(),
            "case {case}: base {base:?}"
        );
    }
}
