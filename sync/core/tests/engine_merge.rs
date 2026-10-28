//! Three-way merge of a note (docs/sync-plan.md, appendix Г, К1: Г4–Г15): a table of cases, then
//! the bytes. Every case is a base and two edits, and is run both ways (local/remote swapped): the
//! merge is symmetric (Г15 г). Red until `merge_text` is written: it is `todo!()` today.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_core::engine::merge::{
    is_mergeable_path, merge_text, MergeOutcome, NotMergeable, Region, MERGE_MAX_BYTES,
};

fn run(base: &str, local: &str, remote: &str) -> MergeOutcome {
    merge_text(base.as_bytes(), local.as_bytes(), remote.as_bytes())
}

/// The merged text; the swapped call must give the same bytes (Г15 г).
#[track_caller]
fn clean(base: &str, local: &str, remote: &str) -> String {
    let MergeOutcome::Clean(bytes) = run(base, local, remote) else {
        panic!("expected a clean merge of\nbase  {base:?}\nlocal {local:?}\nremote {remote:?}\ngot {:?}", run(base, local, remote));
    };
    match run(base, remote, local) {
        MergeOutcome::Clean(swapped) => {
            assert_eq!(swapped, bytes, "the merge is symmetric (Г15 г)")
        }
        other => panic!("swapped sides gave {other:?}, not the same clean merge (Г15 г)"),
    }
    String::from_utf8(bytes).expect("the merge of text is text")
}

/// The regions of a conflict; the swapped call must give the same regions (Г15 г).
#[track_caller]
fn conflict(base: &str, local: &str, remote: &str) -> Vec<Region> {
    let MergeOutcome::Conflict(regions) = run(base, local, remote) else {
        panic!(
            "expected a conflict of\nbase  {base:?}\nlocal {local:?}\nremote {remote:?}\ngot {:?}",
            run(base, local, remote)
        );
    };
    match run(base, remote, local) {
        MergeOutcome::Conflict(swapped) => {
            assert_eq!(swapped, regions, "the conflict is symmetric (Г15 г)")
        }
        other => panic!("swapped sides gave {other:?}, not the same conflict (Г15 г)"),
    }
    regions
}

fn region(start: usize, end: usize) -> Region {
    Region { start, end }
}

const FIVE: &str = "one\ntwo\nthree\nfour\nfive\n";

// ----- the basic rows -----

#[test]
fn nothing_changed_gives_the_same_bytes() {
    // Г15 а
    assert_eq!(clean(FIVE, FIVE, FIVE), FIVE);
    assert_eq!(clean("", "", ""), "");
    assert_eq!(
        clean(
            "no newline at all",
            "no newline at all",
            "no newline at all"
        ),
        "no newline at all"
    );
}

#[test]
fn a_side_that_did_not_change_gives_the_other_side_byte_for_byte() {
    // Г13, Г15 б
    let edited = "one\nTWO\nthree\nfour\nfive\nsix\n";
    assert_eq!(clean(FIVE, edited, FIVE), edited);
    assert_eq!(clean(FIVE, FIVE, edited), edited);
    assert_eq!(
        clean(FIVE, "", FIVE),
        "",
        "emptying the file is an edit like another"
    );
}

#[test]
fn the_same_edit_on_both_sides_is_taken_once() {
    // Г12 п. 5, Г15 в
    let edited = "one\nTWO\nthree\nfour\nfive\n";
    assert_eq!(clean(FIVE, edited, edited), edited);
    // The same insertion at the same place and the same deletion are the same edit too.
    assert_eq!(
        clean(
            FIVE,
            "one\nnew\ntwo\nthree\nfour\nfive\n",
            "one\nnew\ntwo\nthree\nfour\nfive\n"
        ),
        "one\nnew\ntwo\nthree\nfour\nfive\n"
    );
    assert_eq!(
        clean(FIVE, "one\ntwo\nfour\nfive\n", "one\ntwo\nfour\nfive\n"),
        "one\ntwo\nfour\nfive\n"
    );
}

#[test]
fn an_edit_both_sides_made_is_taken_once_when_the_files_differ_elsewhere() {
    // Г12 п. 5: identical edits inside larger, different edits (no shortcut of Г13 applies)
    assert_eq!(
        clean(
            FIVE,
            "ONE\ntwo\nthree\nfour\nFIVE\n",
            "ONE\ntwo\nTHREE\nfour\nfive\n"
        ),
        "ONE\ntwo\nTHREE\nfour\nFIVE\n"
    );
    // the same insertion, the same deletion
    assert_eq!(
        clean(
            FIVE,
            "one\nnew\ntwo\nthree\nfour\nFIVE\n",
            "one\nnew\ntwo\nTHREE\nfour\nfive\n"
        ),
        "one\nnew\ntwo\nTHREE\nfour\nFIVE\n"
    );
    assert_eq!(
        clean(FIVE, "ONE\ntwo\nfour\nfive\n", "one\ntwo\nfour\nFIVE\n"),
        "ONE\ntwo\nfour\nFIVE\n"
    );
}

#[test]
fn edits_in_different_places_are_both_in_the_result() {
    // Г4, Г12: the goal of the stage
    assert_eq!(
        clean(
            FIVE,
            "ONE\ntwo\nthree\nfour\nfive\n",
            "one\ntwo\nthree\nfour\nFIVE\n"
        ),
        "ONE\ntwo\nthree\nfour\nFIVE\n"
    );
}

#[test]
fn the_same_line_edited_differently_is_a_conflict_of_the_whole_file() {
    // Г12 п. 5, п. 6: the region is the line of the base
    let regions = conflict(
        FIVE,
        "one\ntwo\nLOCAL\nfour\nfive\n",
        "one\ntwo\nREMOTE\nfour\nfive\n",
    );
    assert_eq!(regions, vec![region(2, 3)]);
}

#[test]
fn a_conflict_anywhere_makes_the_whole_file_a_conflict_and_lists_only_that_place() {
    // Г12 п. 6: all or nothing; the line that could have been merged is not in the regions
    let regions = conflict(
        FIVE,
        "ONE\ntwo\nLOCAL\nfour\nfive\n",
        "one\ntwo\nREMOTE\nfour\nfive\n",
    );
    assert_eq!(regions, vec![region(2, 3)]);
}

#[test]
fn two_separate_conflicting_places_are_two_regions() {
    // Г12 п. 6
    let regions = conflict(
        FIVE,
        "L1\ntwo\nthree\nfour\nL5\n",
        "R1\ntwo\nthree\nfour\nR5\n",
    );
    assert_eq!(regions, vec![region(0, 1), region(4, 5)]);
}

#[test]
fn overlapping_edits_make_one_region_of_their_union() {
    // Г12 п. 5, п. 6: lines 1–2 against lines 2–3 (0-based 1..3 and 2..4)
    let regions = conflict(FIVE, "one\nA\nB\nfour\nfive\n", "one\ntwo\nC\nD\nfive\n");
    assert_eq!(regions, vec![region(1, 4)]);
}

// ----- neighbours, insertions -----

#[test]
fn edits_of_neighbouring_lines_are_merged() {
    // Г12 п. 5: touching ranges do not conflict
    assert_eq!(
        clean(
            FIVE,
            "one\nTWO\nthree\nfour\nfive\n",
            "one\ntwo\nTHREE\nfour\nfive\n"
        ),
        "one\nTWO\nTHREE\nfour\nfive\n"
    );
}

#[test]
fn insertions_at_different_gaps_are_merged() {
    // Г12 п. 5: there is a line of the base between them
    assert_eq!(
        clean(
            FIVE,
            "one\nA\ntwo\nthree\nfour\nfive\n",
            "one\ntwo\nthree\nfour\nB\nfive\n"
        ),
        "one\nA\ntwo\nthree\nfour\nB\nfive\n"
    );
    // Two neighbouring gaps are different gaps.
    assert_eq!(
        clean(
            FIVE,
            "one\nA\ntwo\nthree\nfour\nfive\n",
            "one\ntwo\nB\nthree\nfour\nfive\n"
        ),
        "one\nA\ntwo\nB\nthree\nfour\nfive\n"
    );
}

#[test]
fn different_insertions_at_the_same_gap_are_a_conflict() {
    // Г12 п. 5: the order of the two would be a guess
    let regions = conflict(
        FIVE,
        "one\ntwo\nA\nthree\nfour\nfive\n",
        "one\ntwo\nB\nthree\nfour\nfive\n",
    );
    assert_eq!(regions, vec![region(2, 2)]);
}

#[test]
fn appending_at_the_end_from_both_sides_is_a_conflict_unless_the_same() {
    // Г12 п. 5
    assert_eq!(
        conflict(FIVE, &format!("{FIVE}local\n"), &format!("{FIVE}remote\n")),
        vec![region(5, 5)]
    );
    assert_eq!(
        clean(FIVE, &format!("{FIVE}same\n"), &format!("{FIVE}same\n")),
        format!("{FIVE}same\n")
    );
}

#[test]
fn an_insertion_next_to_an_edit_is_merged_and_comes_in_its_place() {
    // Г12 п. 5: at the boundary of the other edit, the insertion comes before or after it by
    // position; "before" for an insertion at the start of the range
    assert_eq!(
        clean(
            FIVE,
            "one\ntwo\nNEW\nthree\nfour\nfive\n",
            "one\ntwo\nTHREE\nfour\nfive\n"
        ),
        "one\ntwo\nNEW\nTHREE\nfour\nfive\n"
    );
    assert_eq!(
        clean(
            FIVE,
            "one\ntwo\nthree\nNEW\nfour\nfive\n",
            "one\ntwo\nTHREE\nfour\nfive\n"
        ),
        "one\ntwo\nTHREE\nNEW\nfour\nfive\n"
    );
}

#[test]
fn an_insertion_inside_a_range_the_other_side_replaced_is_a_conflict() {
    // Г12 п. 5: strictly inside the range of the other edit
    let regions = conflict(
        FIVE,
        "one\ntwo\nNEW\nthree\nfour\nfive\n",
        "one\nX\nY\nfour\nfive\n",
    );
    assert_eq!(regions, vec![region(1, 3)]);
}

// ----- deletions -----

#[test]
fn deleting_a_paragraph_and_editing_the_next_one_are_merged() {
    // Г12 п. 5: the result does not depend on which of two equal blank lines the comparison drops
    let base = "A\n\nB\n\nC\n";
    assert_eq!(
        clean(base, "A\n\nC\n", "A\n\nB\n\nC edited\n"),
        "A\n\nC edited\n"
    );
}

#[test]
fn deleting_a_paragraph_and_editing_the_previous_one_are_merged() {
    let base = "A\n\nB\n\nC\n";
    assert_eq!(
        clean(base, "A\n\nC\n", "A edited\n\nB\n\nC\n"),
        "A edited\n\nC\n"
    );
}

#[test]
fn deleting_a_line_and_editing_the_same_line_is_a_conflict() {
    // Г12 п. 5
    assert_eq!(
        conflict(
            FIVE,
            "one\ntwo\nfour\nfive\n",
            "one\ntwo\nTHREE\nfour\nfive\n"
        ),
        vec![region(2, 3)]
    );
}

#[test]
fn both_sides_deleting_the_same_line_is_one_deletion() {
    // Г12 п. 5: the same edit
    assert_eq!(
        clean(FIVE, "one\ntwo\nfour\nfive\n", "one\ntwo\nfour\nfive\n"),
        "one\ntwo\nfour\nfive\n"
    );
}

#[test]
fn deleting_in_one_place_and_inserting_in_another_are_merged() {
    assert_eq!(
        clean(
            FIVE,
            "two\nthree\nfour\nfive\n",
            "one\ntwo\nthree\nfour\nfive\nsix\n"
        ),
        "two\nthree\nfour\nfive\nsix\n"
    );
}

#[test]
fn moving_a_paragraph_is_a_deletion_and_an_insertion_and_merges_with_a_far_edit() {
    // Г12: a "move" is two edits of one side
    let base = "p1\n\np2\n\np3\n\np4\n";
    let moved = "p2\n\np3\n\np4\n\np1\n";
    let edited = "p1\n\np2\n\np3\n\np4 edited\n";
    // p4 is at the end; the moved paragraph is inserted after it, at the same gap as the end of the
    // edit: this pair is inside one place, so use an edit far from both ends instead
    let edited_middle = "p1\n\np2\n\np3 edited\n\np4\n";
    let _ = (moved, edited);
    let merged = clean(base, "p2\n\np3\n\np4\n\np1\n", edited_middle);
    assert_eq!(merged, "p2\n\np3 edited\n\np4\n\np1\n");
}

#[test]
fn emptying_the_file_against_an_edit_is_a_conflict() {
    // Г12 п. 5
    assert_eq!(
        conflict(FIVE, "", "one\ntwo\nTHREE\nfour\nfive\n"),
        vec![region(0, 5)]
    );
}

// ----- empty and repeated lines -----

#[test]
fn an_empty_base_takes_the_side_that_wrote_something() {
    assert_eq!(clean("", "written\n", ""), "written\n");
    assert_eq!(clean("", "", "written\n"), "written\n");
}

#[test]
fn two_different_texts_written_into_an_empty_base_are_a_conflict() {
    // Г12 п. 5: two insertions at the same gap
    assert_eq!(conflict("", "local\n", "remote\n"), vec![region(0, 0)]);
}

#[test]
fn blank_lines_are_kept_exactly() {
    // Г14: several blank lines in a row, a blank line at the start and at the end
    let base = "\n\nA\n\n\n\nB\n\n";
    assert_eq!(
        clean(
            base,
            "\n\nA edited\n\n\n\nB\n\n",
            "\n\nA\n\n\n\nB edited\n\n"
        ),
        "\n\nA edited\n\n\n\nB edited\n\n"
    );
}

#[test]
fn repeated_lines_are_matched_without_loss() {
    // Г12: a base of equal lines; one side appends, the other prepends
    assert_eq!(
        clean("x\nx\nx\n", "x\nx\nx\ny\n", "z\nx\nx\nx\n"),
        "z\nx\nx\nx\ny\n"
    );
}

// ----- the last line without a newline -----

#[test]
fn the_last_line_without_a_newline_is_kept_as_it_is() {
    // Г12 п. 1, Г14: "a\nb" has two lines, the second without a terminator
    assert_eq!(clean("a\nb", "A\nb", "a\nB"), "A\nB");
    assert_eq!(clean("a\nb", "A\nb", "a\nb"), "A\nb");
}

#[test]
fn adding_a_newline_to_the_last_line_is_an_edit_of_that_line() {
    // Г12 п. 1: "b" and "b\n" are different lines
    assert_eq!(conflict("a\nb", "a\nb\nc", "a\nB"), vec![region(1, 2)]);
    assert_eq!(clean("a\nb", "a\nb\nc", "A\nb"), "A\nb\nc");
}

#[test]
fn a_last_line_without_a_newline_is_never_glued_to_text_the_other_side_appends() {
    // Г12 п. 5: a replacement that ends without `\n` closes the file; text added after it by the
    // other side would glue two lines into one ("a2" + "b\n"), so it is a conflict
    assert_eq!(conflict("a\n", "a2", "a\nb\n"), vec![region(0, 1)]);
    assert_eq!(conflict("a\nz\n", "a\nz2", "a\nz\nb\n"), vec![region(1, 2)]);
    // the other direction is fine: the added lines come after a replacement that ends properly
    assert_eq!(clean("a\n", "a2\n", "a\nb\n"), "a2\nb\n");
    // and a replacement without a newline far from what the other side did is fine too
    assert_eq!(clean("x\ny\nz\n", "x\ny\nz2", "x2\ny\nz\n"), "x2\ny\nz2");
}

// ----- line endings and BOM -----

#[test]
fn a_file_with_crlf_keeps_crlf_on_every_untouched_line() {
    // Г14: the carriage return is part of the line
    let base = "one\r\ntwo\r\nthree\r\nfour\r\n";
    assert_eq!(
        clean(
            base,
            "ONE\r\ntwo\r\nthree\r\nfour\r\n",
            "one\r\ntwo\r\nthree\r\nFOUR\r\n"
        ),
        "ONE\r\ntwo\r\nthree\r\nFOUR\r\n"
    );
}

#[test]
fn a_mixed_file_stays_mixed_and_a_replaced_line_keeps_what_its_author_wrote() {
    // Г14
    let base = "a\r\nb\nc\r\nd\n";
    // local rewrites line 1 with an LF; remote rewrites line 4 with CRLF
    assert_eq!(
        clean(base, "A\nb\nc\r\nd\n", "a\r\nb\nc\r\nD\r\n"),
        "A\nb\nc\r\nD\r\n"
    );
}

#[test]
fn changing_only_the_line_endings_of_the_whole_file_conflicts_with_an_edit() {
    // Г14: a line ending is part of the line, so converting every line edits every line
    let base = "one\ntwo\nthree\n";
    assert_eq!(
        conflict(base, "one\r\ntwo\r\nthree\r\n", "one\nTWO\nthree\n"),
        vec![region(0, 3)]
    );
}

#[test]
fn a_lone_carriage_return_does_not_end_a_line() {
    // Г12 п. 1: only `\n` ends a line
    let base = "a\rb\nc\n";
    assert_eq!(clean(base, "a\rB\nc\n", "a\rb\nC\n"), "a\rB\nC\n");
    assert_eq!(conflict(base, "a\rX\nc\n", "a\rY\nc\n"), vec![region(0, 1)]);
}

#[test]
fn a_bom_present_everywhere_is_kept() {
    // Г14
    let base = "\u{feff}one\ntwo\nthree\nfour\n";
    assert_eq!(
        clean(
            base,
            "\u{feff}one\nTWO\nthree\nfour\n",
            "\u{feff}one\ntwo\nthree\nFOUR\n"
        ),
        "\u{feff}one\nTWO\nthree\nFOUR\n"
    );
}

#[test]
fn a_bom_removed_by_one_side_stays_removed_and_the_edit_of_the_other_is_kept() {
    // Г14: the side that differs from the base wins the BOM
    let base = "\u{feff}one\ntwo\nthree\nfour\n";
    assert_eq!(
        clean(
            base,
            "one\ntwo\nthree\nfour\n",
            "\u{feff}one\ntwo\nthree\nFOUR\n"
        ),
        "one\ntwo\nthree\nFOUR\n"
    );
}

#[test]
fn a_bom_added_by_one_side_is_kept() {
    // Г14
    assert_eq!(
        clean(
            FIVE,
            "\u{feff}one\ntwo\nthree\nfour\nfive\n",
            "one\ntwo\nthree\nfour\nFIVE\n"
        ),
        "\u{feff}one\ntwo\nthree\nfour\nFIVE\n"
    );
}

#[test]
fn an_edit_of_the_first_line_is_an_edit_of_its_text_not_of_the_bom() {
    // Г12 п. 2: the BOM is set aside before the lines are compared
    let base = "\u{feff}title\nbody\n";
    assert_eq!(
        clean(base, "\u{feff}TITLE\nbody\n", "\u{feff}title\nBODY\n"),
        "\u{feff}TITLE\nBODY\n"
    );
    assert_eq!(
        conflict(base, "\u{feff}A\nbody\n", "\u{feff}B\nbody\n"),
        vec![region(0, 1)]
    );
}

// ----- Unicode and untouched bytes -----

#[test]
fn text_in_other_scripts_and_emoji_is_merged_by_lines() {
    // Г14
    let base = "Привет, мир\n你好，世界\nمرحبا\n🙂 emoji\n";
    assert_eq!(
        clean(
            base,
            "Привет, мир!\n你好，世界\nمرحبا\n🙂 emoji\n",
            "Привет, мир\n你好，世界\nمرحبا\n🙂 emoji 🙃\n"
        ),
        "Привет, мир!\n你好，世界\nمرحبا\n🙂 emoji 🙃\n"
    );
}

#[test]
fn unicode_forms_and_line_separators_are_not_normalised() {
    // Г14: an untouched line in NFD stays NFD; U+2028 is not a line end
    let nfd = "e\u{301}cole\n"; // "école" written with a combining accent
    let nfc = "\u{e9}cole\n";
    let base = format!("{nfd}middle\u{2028}still the same line\nend\n");
    let local = format!("{nfd}middle\u{2028}still the same line\nEND\n");
    let remote = format!("{nfc}middle\u{2028}still the same line\nend\n");
    let merged = clean(&base, &local, &remote);
    assert_eq!(
        merged,
        format!("{nfc}middle\u{2028}still the same line\nEND\n")
    );
    // Only the line the remote side touched changed its form.
    assert!(merged.contains(nfc) && !merged.contains(nfd));
}

#[test]
fn bytes_no_edit_touched_are_kept_byte_for_byte() {
    // Г14: trailing spaces, tabs, no-break space, zero-width space, a lone CR, mixed endings
    let base = "keep  \t\n\u{a0}nbsp\r\nzero\u{200b}width\nA\nlone\rcr\nB\nend  \n";
    let local = base.replacen("\nA\n", "\nA edited\n", 1);
    let remote = base.replacen("\nB\n", "\nB edited\n", 1);
    let merged = clean(base, &local, &remote);
    assert_eq!(
        merged,
        "keep  \t\n\u{a0}nbsp\r\nzero\u{200b}width\nA edited\nlone\rcr\nB edited\nend  \n"
    );
    assert_eq!(merged.as_bytes()[..6], *"keep  ".as_bytes());
}

// ----- YAML header, by keys -----

const NOTE: &str = "---\namby-id: 01HZX\nstatus: draft\ntags:\n  - a\n  - b\ntitle: T\n---\n\nFirst paragraph.\n\nSecond paragraph.\n";

#[test]
fn different_keys_of_the_header_are_merged() {
    // Г11 (5)
    let local = NOTE.replace("status: draft", "status: published");
    let remote = NOTE.replace("title: T", "title: Another title");
    let merged = clean(NOTE, &local, &remote);
    assert_eq!(
        merged,
        NOTE.replace("status: draft", "status: published")
            .replace("title: T", "title: Another title")
    );
}

#[test]
fn a_key_of_the_header_and_the_body_are_merged() {
    // Г11 (5)
    let local = NOTE.replace("status: draft", "status: published");
    let remote = NOTE.replace("Second paragraph.", "Second paragraph, edited.");
    assert_eq!(
        clean(NOTE, &local, &remote),
        NOTE.replace("status: draft", "status: published")
            .replace("Second paragraph.", "Second paragraph, edited.")
    );
}

#[test]
fn the_same_key_changed_differently_is_a_conflict() {
    // Г11 (5): lines 3 of the note, 0-based 2
    let local = NOTE.replace("status: draft", "status: published");
    let remote = NOTE.replace("status: draft", "status: archived");
    assert_eq!(conflict(NOTE, &local, &remote), vec![region(2, 3)]);
}

#[test]
fn a_list_under_one_key_is_one_place() {
    // Г11 (5): an item inserted inside the list and another item edited are the same place
    let local = NOTE.replace("  - a\n  - b\n", "  - a\n  - x\n  - b\n");
    let remote = NOTE.replace("  - b\n", "  - B\n");
    assert_eq!(conflict(NOTE, &local, &remote), vec![region(3, 6)]);
}

#[test]
fn two_items_of_a_list_in_the_body_are_different_places() {
    // Г11: only the header is read by keys; a list in the text is merged by lines
    let base = "# T\n\nlist:\n  - a\n  - b\n";
    assert_eq!(
        clean(
            base,
            "# T\n\nlist:\n  - A\n  - b\n",
            "# T\n\nlist:\n  - a\n  - B\n"
        ),
        "# T\n\nlist:\n  - A\n  - B\n"
    );
}

#[test]
fn a_dash_line_in_the_middle_is_not_a_header() {
    // Г11 (5): `---` that does not start the file is an ordinary line
    let base = "text\n\n---\nlist:\n  - a\n  - b\n---\n\nend\n";
    assert_eq!(
        clean(
            base,
            "text\n\n---\nlist:\n  - A\n  - b\n---\n\nend\n",
            "text\n\n---\nlist:\n  - a\n  - B\n---\n\nend\n"
        ),
        "text\n\n---\nlist:\n  - A\n  - B\n---\n\nend\n"
    );
}

#[test]
fn a_header_that_is_never_closed_is_not_a_header() {
    // Г11 (5): without the closing line there is no header, so the lines are plain lines
    let base = "---\nlist:\n  - a\n  - b\ntext\n";
    assert_eq!(
        clean(
            base,
            "---\nlist:\n  - A\n  - b\ntext\n",
            "---\nlist:\n  - a\n  - B\ntext\n"
        ),
        "---\nlist:\n  - A\n  - B\ntext\n"
    );
}

#[test]
fn a_header_with_crlf_is_read_by_keys_too() {
    // Г11 (5), Г14
    let base = NOTE.replace('\n', "\r\n");
    let local = base.replace("  - a\r\n  - b\r\n", "  - a\r\n  - x\r\n  - b\r\n");
    let remote = base.replace("  - b\r\n", "  - B\r\n");
    assert_eq!(conflict(&base, &local, &remote), vec![region(3, 6)]);
}

#[test]
fn changing_the_identity_is_a_conflict_when_a_merge_is_needed() {
    // Г13 (а): the identity is never changed silently
    let local = NOTE.replace("amby-id: 01HZX", "amby-id: 01OTHER");
    let remote = NOTE.replace("Second paragraph.", "Second paragraph, edited.");
    let MergeOutcome::Conflict(_) = run(NOTE, &local, &remote) else {
        panic!("a changed amby-id with another edit must be a conflict");
    };
    let MergeOutcome::Conflict(_) = run(NOTE, &remote, &local) else {
        panic!("and symmetrically");
    };
}

#[test]
fn changing_the_identity_on_one_side_only_is_taken_as_it_is() {
    // Г13, Г15 б: nothing to merge, so there is nothing to check
    let local = NOTE.replace("amby-id: 01HZX", "amby-id: 01OTHER");
    assert_eq!(clean(NOTE, &local, NOTE), local);
}

#[test]
fn the_same_new_key_added_in_two_places_is_a_conflict() {
    // Г13 (б): a header must not hold one key twice
    let local = NOTE.replace("status: draft\n", "category: a\nstatus: draft\n");
    let remote = NOTE.replace("title: T\n", "title: T\ncategory: b\n");
    let MergeOutcome::Conflict(_) = run(NOTE, &local, &remote) else {
        panic!("two `category:` keys must not be merged into one header");
    };
    let MergeOutcome::Conflict(_) = run(NOTE, &remote, &local) else {
        panic!("and symmetrically");
    };
}

#[test]
fn two_different_new_keys_in_two_places_are_merged() {
    // Г11 (5)
    let local = NOTE.replace("status: draft\n", "category: a\nstatus: draft\n");
    let remote = NOTE.replace("title: T\n", "title: T\nauthor: me\n");
    assert_eq!(
        clean(NOTE, &local, &remote),
        NOTE.replace("status: draft\n", "category: a\nstatus: draft\n")
            .replace("title: T\n", "title: T\nauthor: me\n")
    );
}

// ----- blocks that are one place -----

const CODE: &str = "Intro\n\n```rust\nfn main() {\n    one();\n    two();\n}\n```\n\nOutro\n";

#[test]
fn two_edits_inside_one_code_block_are_a_conflict() {
    // Г11 (2): far apart lines of one block
    let local = CODE.replace("one();", "one_edited();");
    let remote = CODE.replace("two();", "two_edited();");
    assert_eq!(conflict(CODE, &local, &remote), vec![region(2, 8)]);
}

#[test]
fn an_edit_in_a_code_block_and_an_edit_outside_it_are_merged() {
    // Г11 (2)
    let local = CODE.replace("one();", "one_edited();");
    let remote = CODE.replace("Outro", "Outro edited");
    assert_eq!(
        clean(CODE, &local, &remote),
        CODE.replace("one();", "one_edited();")
            .replace("Outro", "Outro edited")
    );
}

#[test]
fn an_insertion_inside_a_code_block_and_an_edit_of_the_block_are_a_conflict() {
    // Г11 (2): strictly inside the block
    let local = CODE.replace("    one();\n", "    zero();\n    one();\n");
    let remote = CODE.replace("fn main() {", "fn main() -> i32 {");
    assert_eq!(conflict(CODE, &local, &remote), vec![region(2, 8)]);
}

#[test]
fn an_insertion_at_the_edge_of_a_code_block_is_not_inside_it() {
    // Г11: between the closing fence and the blank line after it
    let local = CODE.replace("```\n\nOutro", "```\nafter the block\n\nOutro");
    let remote = CODE.replace("two();", "two_edited();");
    assert_eq!(
        clean(CODE, &local, &remote),
        CODE.replace("```\n\nOutro", "```\nafter the block\n\nOutro")
            .replace("two();", "two_edited();")
    );
}

#[test]
fn a_tilde_fence_is_a_code_block_too() {
    // Г11 (2)
    let base = "a\n\n~~~\nx\ny\n~~~\n\nb\n";
    let local = base.replace("x\n", "x1\n");
    let remote = base.replace("y\n", "y1\n");
    assert_eq!(conflict(base, &local, &remote), vec![region(2, 6)]);
}

#[test]
fn a_longer_fence_is_closed_only_by_a_fence_as_long() {
    // Г11 (2): four backticks open the block; three inside do not close it
    let base = "a\n\n````\n```\ninside\n```\nstill inside\n````\n\nb\n";
    let local = base.replace("inside\n```\nstill", "inside edited\n```\nstill");
    let remote = base.replace("still inside", "still inside edited");
    assert_eq!(conflict(base, &local, &remote), vec![region(2, 8)]);
}

#[test]
fn a_fence_that_is_never_closed_runs_to_the_end_of_the_file() {
    // Г11 (2)
    let base = "a\n\n```\nx\ny\nz\n";
    let local = base.replace("x\n", "x1\n");
    let remote = base.replace("z\n", "z1\n");
    assert_eq!(conflict(base, &local, &remote), vec![region(2, 6)]);
}

#[test]
fn two_edits_in_one_table_are_a_conflict_and_an_edit_beside_it_is_merged() {
    // Г11 (3)
    let base = "Before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAfter\n";
    let local = base.replace("| 1 | 2 |", "| 1 | two |");
    let remote = base.replace("| 3 | 4 |", "| 3 | four |");
    assert_eq!(conflict(base, &local, &remote), vec![region(2, 6)]);
    let beside = base.replace("After", "After edited");
    assert_eq!(
        clean(base, &local, &beside),
        base.replace("| 1 | 2 |", "| 1 | two |")
            .replace("After", "After edited")
    );
}

#[test]
fn two_edits_in_one_formula_block_are_a_conflict() {
    // Г11 (4)
    let base = "Text\n\n$$\nx = 1\ny = 2\n$$\n\nEnd\n";
    let local = base.replace("x = 1", "x = 10");
    let remote = base.replace("y = 2", "y = 20");
    assert_eq!(conflict(base, &local, &remote), vec![region(2, 6)]);
}

// ----- which files, which sizes -----

#[test]
fn only_markdown_notes_outside_the_service_folder_are_candidates() {
    // Г5
    for path in [
        "a.md",
        "Notes/a.md",
        "dir/Sub/Заметка.md",
        "A.MD",
        "x.Md",
        "a.b.md",
        "a.canvas.md",
    ] {
        assert!(is_mergeable_path(path), "{path}");
    }
    for path in [
        "a.txt",
        "a.md.bak",
        "a.canvas",
        "a.excalidraw",
        "a.json",
        "photo.png",
        "md",
        "dir.md/file.txt",
        ".amby/properties.json",
        ".amby/blocks/n1.md",
        ".amby/conflicts/0123456789ab/other.md",
    ] {
        assert!(!is_mergeable_path(path), "{path}");
    }
}

#[test]
fn a_version_that_is_not_utf8_is_not_merged() {
    // Г5
    let bad = b"one\n\xff\xfe two\nthree\n".as_slice();
    for (base, local, remote) in [
        (bad, b"one\ntwo\n".as_slice(), b"one\ntwo\n".as_slice()),
        (b"one\ntwo\n", bad, b"one\ntwo\nthree\n"),
        (b"one\ntwo\n", b"one\ntwo\nthree\n", bad),
    ] {
        assert_eq!(
            merge_text(base, local, remote),
            MergeOutcome::NotMergeable(NotMergeable::NotUtf8)
        );
    }
}

#[test]
fn a_version_with_a_nul_byte_is_not_merged() {
    // Г5
    assert_eq!(
        merge_text(b"one\ntwo\n", b"one\0\ntwo\n", b"one\ntwo\nthree\n"),
        MergeOutcome::NotMergeable(NotMergeable::HasNul)
    );
}

#[test]
fn a_version_over_one_mebibyte_is_not_merged_but_one_of_exactly_that_size_is() {
    // Г5: `MERGE_MAX_BYTES` is 1 MiB
    assert_eq!(MERGE_MAX_BYTES, 1024 * 1024);
    let line = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\n"; // 64 bytes
    let exact = line.repeat(MERGE_MAX_BYTES / line.len());
    assert_eq!(exact.len(), MERGE_MAX_BYTES);
    let local = exact.replacen("0123", "ABCD", 1);
    let remote = format!(
        "{}Z{}",
        &exact[..exact.len() - 64],
        &exact[exact.len() - 63..]
    );
    assert_eq!(remote.len(), MERGE_MAX_BYTES);
    let MergeOutcome::Clean(bytes) =
        merge_text(exact.as_bytes(), local.as_bytes(), remote.as_bytes())
    else {
        panic!("a file of exactly 1 MiB is merged");
    };
    assert_eq!(bytes.len(), MERGE_MAX_BYTES);
    assert!(bytes.starts_with(b"ABCD") && bytes[bytes.len() - 64] == b'Z');

    let big = format!("{exact}x\n");
    for (base, local, remote) in [
        (&big, &exact, &exact),
        (&exact, &big, &exact),
        (&exact, &exact, &big),
    ] {
        assert_eq!(
            merge_text(base.as_bytes(), local.as_bytes(), remote.as_bytes()),
            MergeOutcome::NotMergeable(NotMergeable::TooLarge)
        );
    }
}

#[test]
fn completely_different_large_texts_are_refused_as_too_complex() {
    // Г12 (7): 10 000 lines against 10 000 other lines is 100 million cells
    let base: String = (0..10_000).map(|i| format!("base line {i}\n")).collect();
    let local: String = (0..10_000).map(|i| format!("local line {i}\n")).collect();
    let remote = format!("{base}tail\n");
    assert_eq!(
        merge_text(base.as_bytes(), local.as_bytes(), remote.as_bytes()),
        MergeOutcome::NotMergeable(NotMergeable::TooComplex)
    );
}

#[test]
fn a_big_file_with_edits_far_apart_is_merged_at_once() {
    // Г12: the common beginning and end are cut off first, so distant small edits are cheap
    let base: String = (0..20_000)
        .map(|i| format!("line {i} of the note\n"))
        .collect();
    let local = base.replacen("line 10 of", "line TEN of", 1);
    let remote = base.replacen("line 19990 of", "line END of", 1);
    let started = std::time::Instant::now();
    let merged = clean(&base, &local, &remote);
    assert!(merged.contains("line TEN of") && merged.contains("line END of"));
    assert_eq!(
        merged.len(),
        base.len() + "TEN".len() - "10".len() + "END".len() - "19990".len()
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "took {:?}",
        started.elapsed()
    );
}

// ----- never marks -----

#[test]
fn a_merge_never_writes_conflict_marks() {
    // Г15 е, Г20: the result of a clean merge has only lines of the three versions
    let merged = clean(
        FIVE,
        "ONE\ntwo\nthree\nfour\nfive\n",
        "one\ntwo\nthree\nfour\nFIVE\n",
    );
    for mark in ["<<<<<<<", "=======", ">>>>>>>"] {
        assert!(!merged.contains(mark));
    }
    // A conflict has no bytes at all: the file stays as it is and the second version is kept
    // elsewhere (К2).
    let MergeOutcome::Conflict(_) = run(
        FIVE,
        "one\nL\nthree\nfour\nfive\n",
        "one\nR\nthree\nfour\nfive\n",
    ) else {
        panic!("expected a conflict");
    };
}
