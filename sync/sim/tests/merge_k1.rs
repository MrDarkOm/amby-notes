//! К1 (docs/sync-plan.md, appendix Г, Г4–Г19): edits of two computers in different places of one
//! note are merged by the engine, with no conflict and no loss; the merged text goes up as the next
//! version; the base the merge needs is kept by the rules of Г6–Г10. Each scenario runs against the
//! real engine (red until К1 is written) and against the correct mini-engine (green: the scenario
//! can be satisfied). After every scenario the invariants of раздел 7 and of К2 are checked.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::keys::ItemId;
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::{SnapshotReason, StateStore};

const SIX: &str = "l0\nl1\nl2\nl3\nl4\nl5\n";

/// Two devices that both have `Keep/k.md` and the file `path` with `content`.
fn pair_with(b: EngineBuilder, path: &str, content: &[u8]) -> World {
    let w = two(b);
    w.save(0, "Keep/k.md", "keep");
    w.dev(0).fs.user_write(path, content);
    w.pass(0);
    w.pass(1);
    assert_eq!(w.dev(1).fs.content(path).as_deref(), Some(content));
    w
}

fn base_of(w: &World, d: usize, item: &ItemId, content: &[u8]) -> Option<Vec<u8>> {
    let mut state = w.dev(d).state.clone();
    state.base_get(item, &blake3_hash(content)).unwrap()
}

// ----- the goal -----

fn edits_in_different_places_are_merged_without_a_conflict(b: EngineBuilder) {
    // К1, Г4, Г12, Г16, Г17, О5: nothing is lost and nobody is asked
    let w = pair_with(b, "Notes/n.md", SIX.as_bytes());
    w.save(0, "Notes/n.md", "l0\nL1 edited on 0\nl2\nl3\nl4\nl5\n");
    w.save(1, "Notes/n.md", "l0\nl1\nl2\nl3\nL4 edited on 1\nl5\n");
    w.pass(0);
    let report = w.pass(1);
    let merged = "l0\nL1 edited on 0\nl2\nl3\nL4 edited on 1\nl5\n";
    assert_eq!(w.read(1, "Notes/n.md").as_deref(), Some(merged));
    assert!(report.conflicts.is_empty(), "{:?}", report.conflicts);
    assert_eq!(report.merged_paths, vec!["Notes/n.md".to_string()]);
    assert!(w.sets(1).is_empty() && w.old_copies(1).is_empty());
    w.pass(0);
    assert_eq!(w.read(0, "Notes/n.md").as_deref(), Some(merged));
    assert_eq!(
        w.server_files()
            .get("Notes/n.md")
            .map(|b| text(b))
            .as_deref(),
        Some(merged)
    );
    assert!(w.sets(0).is_empty());
    w.finish(false);
}

fn the_merged_text_goes_up_as_the_next_version_of_the_same_item(b: EngineBuilder) {
    // К1, Г16: no new item, no extra mechanism: the merged file is an ordinary edit (Д22) of the
    // item, based on the server version
    let w = pair_with(b, "Notes/n.md", SIX.as_bytes());
    let (item, version) = w.item_at("Notes/n.md");
    w.save(0, "Notes/n.md", "l0\nL1\nl2\nl3\nl4\nl5\n");
    w.save(1, "Notes/n.md", "l0\nl1\nl2\nl3\nL4\nl5\n");
    w.pass(0);
    w.pass(1);
    assert_eq!(
        w.item_at("Notes/n.md"),
        (item, version + 2),
        "the edit of device 0, then the merged text"
    );
    assert_eq!(w.versions_at("Notes/n.md").len(), 3);
    assert_eq!(w.server_item_count(), 2, "no set, no copy, no second item");
    w.finish(false);
}

fn the_local_content_that_the_merge_replaces_stays_in_the_history(b: EngineBuilder) {
    // К1, Г16, Д53, Р8, О4: a snapshot with the reason `sync-overwrite`, even though the edits are
    // in the result
    let w = pair_with(b, "Notes/n.md", SIX.as_bytes());
    w.save(0, "Notes/n.md", "l0\nL1\nl2\nl3\nl4\nl5\n");
    w.save(1, "Notes/n.md", "l0\nl1\nl2\nl3\nL4\nl5\n");
    w.pass(0);
    w.pass(1);
    let history = w.dev(1).fs.history();
    assert!(
        history
            .iter()
            .any(|h| h.bytes == b"l0\nl1\nl2\nl3\nL4\nl5\n"
                && h.reason == SnapshotReason::SyncOverwrite),
        "{history:?}"
    );
    w.finish(false);
}

fn a_merge_on_three_devices_converges(b: EngineBuilder) {
    // К1, Г4, раздел 7: three computers, three different lines
    let w = three(b);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/n.md", SIX);
    w.pass(0);
    w.pass(1);
    w.pass(2);
    w.save(0, "Notes/n.md", "l0 A\nl1\nl2\nl3\nl4\nl5\n");
    w.save(1, "Notes/n.md", "l0\nl1\nl2 B\nl3\nl4\nl5\n");
    w.save(2, "Notes/n.md", "l0\nl1\nl2\nl3\nl4\nl5 C\n");
    w.round();
    w.round();
    w.round();
    for d in 0..3 {
        assert_eq!(
            w.read(d, "Notes/n.md").as_deref(),
            Some("l0 A\nl1\nl2 B\nl3\nl4\nl5 C\n"),
            "device {d}"
        );
        assert!(w.sets(d).is_empty(), "device {d}");
    }
    w.finish(false);
}

fn a_second_round_of_edits_merges_against_the_merged_text(b: EngineBuilder) {
    // К1, Г8 б, Г9: the base moves on with the commit, so the next merge has the right base
    let w = pair_with(b, "Notes/n.md", SIX.as_bytes());
    w.save(0, "Notes/n.md", "l0\nL1\nl2\nl3\nl4\nl5\n");
    w.save(1, "Notes/n.md", "l0\nl1\nl2\nl3\nL4\nl5\n");
    w.pass(0);
    w.pass(1);
    w.pass(0);
    let merged = "l0\nL1\nl2\nl3\nL4\nl5\n";
    assert_eq!(w.read(0, "Notes/n.md").as_deref(), Some(merged));
    w.save(0, "Notes/n.md", "l0 again\nL1\nl2\nl3\nL4\nl5\n");
    w.save(1, "Notes/n.md", "l0\nL1\nl2\nl3\nL4\nl5 again\n");
    w.pass(1);
    w.pass(0);
    w.pass(1);
    for d in 0..2 {
        assert_eq!(
            w.read(d, "Notes/n.md").as_deref(),
            Some("l0 again\nL1\nl2\nl3\nL4\nl5 again\n"),
            "device {d}"
        );
        assert!(w.sets(d).is_empty());
    }
    w.finish(false);
}

fn a_foreign_rename_together_with_an_edit_is_merged_at_the_new_path(b: EngineBuilder) {
    // К1, Д31, Г4: the server renamed and edited, this device edited another place: merged at
    // the server's path
    let w = pair_with(b, "Notes/n.md", SIX.as_bytes());
    w.dev(0).fs.user_rename("Notes/n.md", "Notes/m.md");
    w.pass(0);
    w.save(0, "Notes/m.md", "l0\nL1 server\nl2\nl3\nl4\nl5\n");
    w.pass(0);
    w.save(1, "Notes/n.md", "l0\nl1\nl2\nl3\nL4 here\nl5\n");
    let report = w.pass(1);
    assert_eq!(
        w.read(1, "Notes/m.md").as_deref(),
        Some("l0\nL1 server\nl2\nl3\nL4 here\nl5\n")
    );
    assert!(!w.dev(1).fs.exists("Notes/n.md"));
    assert_eq!(report.merged_paths, vec!["Notes/m.md".to_string()]);
    assert!(w.sets(1).is_empty());
    w.finish(false);
}

fn a_merge_that_equals_the_server_version_uploads_nothing(b: EngineBuilder) {
    // К1, Г16: the local edit is already in the server's version, which also has more: the file
    // is replaced by the server's version (with a snapshot) and no commit is made
    let w = pair_with(b, "Notes/n.md", SIX.as_bytes());
    w.save(0, "Notes/n.md", "l0\nL1\nl2\nl3\nL4\nl5\n");
    w.save(1, "Notes/n.md", "l0\nL1\nl2\nl3\nl4\nl5\n");
    w.pass(0);
    let head = w.server_head();
    let report = w.pass(1);
    assert_eq!(
        w.read(1, "Notes/n.md").as_deref(),
        Some("l0\nL1\nl2\nl3\nL4\nl5\n")
    );
    assert_eq!(
        w.server_head(),
        head,
        "nothing is sent: the server has this text"
    );
    assert!(report.conflicts.is_empty() && w.sets(1).is_empty());
    assert!(w.dev(1).fs.history().iter().any(
        |h| h.bytes == b"l0\nL1\nl2\nl3\nl4\nl5\n" && h.reason == SnapshotReason::SyncOverwrite
    ));
    w.finish(false);
}

fn a_merge_that_equals_the_local_file_does_not_write_it_and_sends_it(b: EngineBuilder) {
    // К1, Г16: the server's edit is already in the local file, which has more: the file is not
    // written, and it goes up as the next version
    let w = pair_with(b, "Notes/n.md", SIX.as_bytes());
    let (item, version) = w.item_at("Notes/n.md");
    w.save(0, "Notes/n.md", "l0\nL1\nl2\nl3\nl4\nl5\n");
    w.save(1, "Notes/n.md", "l0\nL1\nl2\nl3\nL4\nl5\n");
    w.pass(0);
    w.dev(1).fs.clear_events();
    w.pass(1);
    assert_eq!(
        w.read(1, "Notes/n.md").as_deref(),
        Some("l0\nL1\nl2\nl3\nL4\nl5\n")
    );
    assert!(
        disk_changes(&w, 1).is_empty(),
        "the file already is the result: {:?}",
        disk_changes(&w, 1)
    );
    assert_eq!(w.item_at("Notes/n.md"), (item, version + 2));
    w.pass(0);
    assert_eq!(
        w.read(0, "Notes/n.md").as_deref(),
        Some("l0\nL1\nl2\nl3\nL4\nl5\n")
    );
    w.finish(false);
}

// ----- which places are "the same" -----

fn edits_of_neighbouring_lines_are_merged(b: EngineBuilder) {
    // К1, Г12 п. 5: touching is not overlapping
    let w = pair_with(b, "Notes/n.md", SIX.as_bytes());
    w.save(0, "Notes/n.md", "l0\nl1\nL2\nl3\nl4\nl5\n");
    w.save(1, "Notes/n.md", "l0\nl1\nl2\nL3\nl4\nl5\n");
    w.pass(0);
    w.pass(1);
    assert_eq!(
        w.read(1, "Notes/n.md").as_deref(),
        Some("l0\nl1\nL2\nL3\nl4\nl5\n")
    );
    assert!(w.sets(1).is_empty());
    w.finish(false);
}

fn insertions_at_the_same_place_are_a_conflict_and_at_different_places_are_merged(
    b: EngineBuilder,
) {
    // К1, Г12 п. 5
    let w = pair_with(b, "Notes/n.md", SIX.as_bytes());
    w.save(0, "Notes/n.md", "l0\nl1\nfrom 0\nl2\nl3\nl4\nl5\n");
    w.save(1, "Notes/n.md", "l0\nl1\nfrom 1\nl2\nl3\nl4\nl5\n");
    w.pass(0);
    let report = w.pass(1);
    assert!(report.merged_paths.is_empty());
    assert_eq!(w.sets(1).len(), 1, "two different insertions at one gap");
    assert_eq!(w.sets(1)[0].other, b"l0\nl1\nfrom 1\nl2\nl3\nl4\nl5\n");
    w.finish(false);

    let w = pair_with(b, "Notes/n.md", SIX.as_bytes());
    w.save(0, "Notes/n.md", "l0\nl1\nfrom 0\nl2\nl3\nl4\nl5\n");
    w.save(1, "Notes/n.md", "l0\nl1\nl2\nl3\nl4\nfrom 1\nl5\n");
    w.pass(0);
    w.pass(1);
    assert_eq!(
        w.read(1, "Notes/n.md").as_deref(),
        Some("l0\nl1\nfrom 0\nl2\nl3\nl4\nfrom 1\nl5\n")
    );
    assert!(w.sets(1).is_empty());
    w.finish(false);
}

// ----- the bytes -----

fn untouched_bytes_stay_byte_for_byte_in_a_merge(b: EngineBuilder) {
    // К1, Г14, О7: a BOM, CRLF and LF mixed, trailing spaces, a no-break space, an NFD name and
    // no newline at the end are all kept; only the two edited lines change
    let base =
        "\u{feff}Title\r\nline  \t\nnb\u{a0}sp\r\ne\u{301}cole\nA\nB\r\nlast without newline";
    let w = pair_with(b, "Notes/bytes.md", base.as_bytes());
    let local = base.replace("A\n", "A edited\n");
    let remote = base.replace("Title\r\n", "Title edited\r\n");
    w.dev(0).fs.user_write("Notes/bytes.md", local.as_bytes());
    w.dev(1).fs.user_write("Notes/bytes.md", remote.as_bytes());
    w.pass(0);
    w.pass(1);
    let expected = base
        .replace("A\n", "A edited\n")
        .replace("Title\r\n", "Title edited\r\n");
    assert_eq!(
        w.dev(1).fs.content("Notes/bytes.md").as_deref(),
        Some(expected.as_bytes())
    );
    w.pass(0);
    assert_eq!(
        w.dev(0).fs.content("Notes/bytes.md").as_deref(),
        Some(expected.as_bytes())
    );
    w.finish(false);
}

// ----- what is not merged -----

fn a_file_that_is_not_markdown_is_never_merged(b: EngineBuilder) {
    // К1, Г5: a text file `.txt` is edited in different places: still a conflict, and no base
    let w = pair_with(b, "Notes/n.txt", SIX.as_bytes());
    w.save(0, "Notes/n.txt", "l0\nL1\nl2\nl3\nl4\nl5\n");
    w.save(1, "Notes/n.txt", "l0\nl1\nl2\nl3\nL4\nl5\n");
    w.pass(0);
    let report = w.pass(1);
    assert!(report.merged_paths.is_empty());
    let sets = w.sets(1);
    assert_eq!(sets.len(), 1);
    assert_eq!(sets[0].other, b"l0\nl1\nl2\nl3\nL4\nl5\n");
    assert!(
        sets[0].base.is_none(),
        "no base for a file that is not a note (Г6)"
    );
    assert_eq!(sets[0].other_name, "other.txt");
    w.finish(false);
}

fn a_note_with_a_nul_byte_or_that_is_not_utf8_is_not_merged(b: EngineBuilder) {
    // К1, Г5
    for (base, local, remote) in [
        (
            b"l0\nl1\nl2\nl3\nl4\nl5\n".to_vec(),
            b"l0\0\nl1\nl2\nl3\nl4\nl5\n".to_vec(),
            b"l0\nl1\nl2\nl3\nL4\nl5\n".to_vec(),
        ),
        (
            b"l0\nl1\nl2\nl3\nl4\nl5\n".to_vec(),
            b"l0\n\xff\xfe\nl2\nl3\nl4\nl5\n".to_vec(),
            b"l0\nl1\nl2\nl3\nL4\nl5\n".to_vec(),
        ),
    ] {
        let w = pair_with(b, "Notes/n.md", &base);
        w.dev(0).fs.user_write("Notes/n.md", &local);
        w.dev(1).fs.user_write("Notes/n.md", &remote);
        w.pass(0);
        let report = w.pass(1);
        assert!(report.merged_paths.is_empty());
        assert_eq!(w.sets(1).len(), 1, "{:?}", w.texts(1));
        assert_eq!(w.sets(1)[0].other, remote);
        w.finish(false);
    }
}

fn a_note_over_one_mebibyte_is_not_merged_and_has_no_base(b: EngineBuilder) {
    // К1, Г5, Г6, Г8: the limit is 1 MiB
    let line = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\n";
    let mut big = line.repeat(1024 * 1024 / line.len());
    big.push_str("tail\n");
    assert!(big.len() > 1024 * 1024);
    let w = pair_with(b, "Notes/big.md", big.as_bytes());
    let (item, _) = w.item_at("Notes/big.md");
    assert_eq!(
        base_of(&w, 1, &item, big.as_bytes()),
        None,
        "no base over the limit"
    );
    let local = big.replacen("0123", "ABCD", 1);
    let remote = format!("{}Z{}", &big[..big.len() - 10], &big[big.len() - 9..]);
    w.dev(0).fs.user_write("Notes/big.md", local.as_bytes());
    w.dev(1).fs.user_write("Notes/big.md", remote.as_bytes());
    w.pass(0);
    let report = w.pass(1);
    assert!(report.merged_paths.is_empty());
    assert_eq!(w.sets(1).len(), 1);
    assert!(w.sets(1)[0].base.is_none());
}

// ----- no base: a conflict, never a merge -----

fn a_device_without_its_state_has_no_base_so_a_conflict_not_a_merge(b: EngineBuilder) {
    // К1, Г10, Д8, Д43, С11: the edits are in different places, but the state is gone, so there
    // is no common version
    let w = pair_with(b, "Notes/n.md", SIX.as_bytes());
    w.save(0, "Notes/n.md", "l0\nL1\nl2\nl3\nl4\nl5\n");
    w.save(1, "Notes/n.md", "l0\nl1\nl2\nl3\nL4\nl5\n");
    w.pass(0);
    w.dev(1).state.wipe();
    let report = w.pass(1);
    assert!(report.merged_paths.is_empty());
    assert_eq!(
        w.read(1, "Notes/n.md").as_deref(),
        Some("l0\nL1\nl2\nl3\nl4\nl5\n")
    );
    let sets = w.sets(1);
    assert_eq!(sets.len(), 1, "{:?}", w.texts(1));
    assert_eq!(sets[0].kind, "bothCreated");
    assert_eq!(sets[0].other, b"l0\nl1\nl2\nl3\nL4\nl5\n");
    assert!(sets[0].base.is_none());
    w.finish(false);
}

fn a_damaged_base_is_no_base(b: EngineBuilder) {
    // К1, Г7, Г10: a base whose bytes do not match their hash is not used
    let w = pair_with(b, "Notes/n.md", SIX.as_bytes());
    let (item, _) = w.item_at("Notes/n.md");
    w.dev(1)
        .state
        .damage_base(&item, &blake3_hash(SIX.as_bytes()));
    assert_eq!(base_of(&w, 1, &item, SIX.as_bytes()), None);
    w.save(0, "Notes/n.md", "l0\nL1\nl2\nl3\nl4\nl5\n");
    w.save(1, "Notes/n.md", "l0\nl1\nl2\nl3\nL4\nl5\n");
    w.pass(0);
    let report = w.pass(1);
    assert!(report.merged_paths.is_empty());
    let sets = w.sets(1);
    assert_eq!(sets.len(), 1);
    assert_eq!(sets[0].kind, "bothEdited");
    assert!(sets[0].base.is_none(), "there was no base to keep");
    w.finish(false);
}

// ----- the base: when it is written and removed -----

fn the_base_follows_the_four_cases_of_the_common_version(b: EngineBuilder) {
    // К1, Г8, Г9, Д1: (а) a file written from the server, (б) a commit accepted, (г) a deletion
    let w = pair_with(b, "Notes/n.md", SIX.as_bytes());
    let (item, _) = w.item_at("Notes/n.md");
    assert_eq!(
        base_of(&w, 1, &item, SIX.as_bytes()).as_deref(),
        Some(SIX.as_bytes()),
        "(а) written from the server"
    );
    assert_eq!(
        base_of(&w, 0, &item, SIX.as_bytes()).as_deref(),
        Some(SIX.as_bytes()),
        "(б) the commit of the new file was accepted"
    );
    assert_eq!(w.dev(0).state.base_count(), 2, "Keep/k.md and Notes/n.md");
    // an edit: the old base goes after the commit, the new one is there
    let edited = "l0\nL1\nl2\nl3\nl4\nl5\n";
    w.save(0, "Notes/n.md", edited);
    w.pass(0);
    assert_eq!(
        base_of(&w, 0, &item, edited.as_bytes()).as_deref(),
        Some(edited.as_bytes())
    );
    assert_eq!(base_of(&w, 0, &item, SIX.as_bytes()), None, "pruned (Г9)");
    assert_eq!(w.dev(0).state.base_count(), 2);
    // (г) a deletion
    w.dev(0).fs.user_delete("Notes/n.md");
    w.pass(0);
    assert_eq!(w.dev(0).state.base_count(), 1, "only Keep/k.md is left");
    w.pass(1);
    assert_eq!(w.dev(1).state.base_count(), 1);
    w.finish(false);
}

fn only_notes_that_can_be_merged_get_a_base(b: EngineBuilder) {
    // К1, Г6, Г8: not a picture, not a text file that is not Markdown, not a note with a NUL
    let w = two(b);
    w.save(0, "Keep/k.md", "keep");
    w.dev(0)
        .fs
        .user_write("assets/p.png", &[0x89, b'P', b'N', b'G', 1, 2, 3]);
    w.dev(0)
        .fs
        .user_write("Notes/t.txt", b"text, not markdown\n");
    w.dev(0).fs.user_write("Notes/z.md", b"nul\0inside\n");
    w.dev(0).fs.user_write("Notes/ok.md", b"fine\n");
    w.pass(0);
    w.pass(1);
    for d in 0..2 {
        assert_eq!(
            w.dev(d).state.base_count(),
            2,
            "device {d}: Keep/k.md and Notes/ok.md"
        );
    }
    w.finish(false);
}

fn the_base_survives_a_rename(b: EngineBuilder) {
    // К1, Г8: a rename does not change the content, so the base stays valid (the key is the hash)
    let w = pair_with(b, "Notes/n.md", SIX.as_bytes());
    let (item, _) = w.item_at("Notes/n.md");
    w.dev(0).fs.user_rename("Notes/n.md", "Notes/m.md");
    w.pass(0);
    w.pass(1);
    assert_eq!(
        base_of(&w, 1, &item, SIX.as_bytes()).as_deref(),
        Some(SIX.as_bytes())
    );
    w.save(0, "Notes/m.md", "l0\nL1\nl2\nl3\nl4\nl5\n");
    w.save(1, "Notes/m.md", "l0\nl1\nl2\nl3\nL4\nl5\n");
    w.pass(0);
    w.pass(1);
    assert_eq!(
        w.read(1, "Notes/m.md").as_deref(),
        Some("l0\nL1\nl2\nl3\nL4\nl5\n")
    );
    w.finish(false);
}

// ----- failures -----

fn a_crash_at_any_call_still_ends_in_one_merge(b: EngineBuilder) {
    // К1, Г18, Д4, С3: whatever call the process dies at, a later pass ends with the same merged
    // text, no conflict, no set, and no extra version
    for crash_at in 1..250 {
        let w = pair_with(b, "Notes/n.md", SIX.as_bytes());
        let (item, version) = w.item_at("Notes/n.md");
        w.save(0, "Notes/n.md", "l0\nL1\nl2\nl3\nl4\nl5\n");
        w.save(1, "Notes/n.md", "l0\nl1\nl2\nl3\nL4\nl5\n");
        w.pass(0);
        w.dev(1).faults.crash_at(crash_at);
        let _ = w.dev(1).sync();
        let calls_made = w.dev(1).faults.calls();
        w.finish(false);
        for d in 0..2 {
            assert_eq!(
                w.read(d, "Notes/n.md").as_deref(),
                Some("l0\nL1\nl2\nl3\nL4\nl5\n"),
                "device {d}, crash at call {crash_at}"
            );
            assert!(
                w.sets(d).is_empty(),
                "crash at {crash_at}: {:?}",
                w.texts(d)
            );
        }
        assert_eq!(
            w.item_at("Notes/n.md"),
            (item, version + 2),
            "crash at {crash_at}"
        );
        if calls_made < crash_at {
            break;
        }
    }
}

both!(
    edits_in_different_places_are_merged_without_a_conflict,
    the_merged_text_goes_up_as_the_next_version_of_the_same_item,
    the_local_content_that_the_merge_replaces_stays_in_the_history,
    a_merge_on_three_devices_converges,
    a_second_round_of_edits_merges_against_the_merged_text,
    a_foreign_rename_together_with_an_edit_is_merged_at_the_new_path,
    a_merge_that_equals_the_server_version_uploads_nothing,
    a_merge_that_equals_the_local_file_does_not_write_it_and_sends_it,
    edits_of_neighbouring_lines_are_merged,
    insertions_at_the_same_place_are_a_conflict_and_at_different_places_are_merged,
    untouched_bytes_stay_byte_for_byte_in_a_merge,
    a_file_that_is_not_markdown_is_never_merged,
    a_note_with_a_nul_byte_or_that_is_not_utf8_is_not_merged,
    a_note_over_one_mebibyte_is_not_merged_and_has_no_base,
    a_device_without_its_state_has_no_base_so_a_conflict_not_a_merge,
    a_damaged_base_is_no_base,
    the_base_follows_the_four_cases_of_the_common_version,
    only_notes_that_can_be_merged_get_a_base,
    the_base_survives_a_rename,
    a_crash_at_any_call_still_ends_in_one_merge,
);
