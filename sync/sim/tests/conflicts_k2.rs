//! К2 (docs/sync-plan.md, appendix Г, Г20–Г30): the second version of a conflict lies in
//! `.amby/conflicts/<id>/`, not beside the file; its files are ordinary synchronised files, so the
//! conflict is seen and resolved from any device. Each scenario runs against the real engine (red
//! until К2 is written) and against the correct mini-engine (green: it can be satisfied).
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_sim::conflicts as sets;

/// Device 1 made a conflict with device 0 about `Notes/a.md`: "zero" kept the name, "one" is the
/// second version; both devices have seen the set.
fn conflict_of_two(b: EngineBuilder) -> World {
    let w = pair_with_a(b);
    w.save(0, "Notes/a.md", "zero");
    w.save(1, "Notes/a.md", "one");
    w.pass(0);
    w.pass(1);
    w.pass(0);
    assert_eq!(w.sets(0).len(), 1);
    assert_eq!(w.sets(1).len(), 1);
    w
}

fn no_file_in_the_tree_is_a_copy_and_the_set_is_where_the_plan_says(b: EngineBuilder) {
    // Г20, Г21, Г24: the tree of notes holds the two files it held, and `.amby/conflicts/` the rest
    let w = conflict_of_two(b);
    for d in 0..2 {
        let files = w.texts(d);
        let outside: Vec<&String> = files.keys().filter(|p| !p.starts_with(".amby/")).collect();
        assert_eq!(outside, vec!["Keep/k.md", "Notes/a.md"], "device {d}");
        assert!(w.old_copies(d).is_empty());
        let set = &w.sets(d)[0];
        let dir = format!(".amby/conflicts/{}", set.id);
        let mut inside: Vec<String> = files
            .keys()
            .filter(|p| p.starts_with(".amby/conflicts/"))
            .cloned()
            .collect();
        inside.sort();
        assert_eq!(
            inside,
            vec![
                format!("{dir}/base.md"),
                format!("{dir}/meta.json"),
                format!("{dir}/other.md"),
            ],
            "device {d}"
        );
    }
    w.finish(false);
}

fn the_files_of_a_set_are_ordinary_items_of_the_server(b: EngineBuilder) {
    // Г24, Р4: they are synchronised like any file
    let w = conflict_of_two(b);
    let id = w.sets(1)[0].id.clone();
    let server = w.server_files();
    assert_eq!(
        server
            .get(&format!(".amby/conflicts/{id}/other.md"))
            .map(|b| text(b))
            .as_deref(),
        Some("one")
    );
    assert_eq!(
        server
            .get(&format!(".amby/conflicts/{id}/base.md"))
            .map(|b| text(b))
            .as_deref(),
        Some("base")
    );
    assert!(server.contains_key(&format!(".amby/conflicts/{id}/meta.json")));
    w.finish(false);
}

fn the_files_of_a_set_go_up_in_one_commit(b: EngineBuilder) {
    // Г23: made in one pass, sent in one commit, so another device never sees half a set
    let w = pair_with_a(b);
    w.save(0, "Notes/a.md", "zero");
    w.save(1, "Notes/a.md", "one");
    w.pass(0);
    let head = w.server_head();
    w.pass(1);
    assert_eq!(w.server_head(), head + 1, "one commit for the three files");
    assert_eq!(w.server_item_count(), 5);
    w.finish(false);
}

fn meta_json_is_exactly_the_documented_bytes(b: EngineBuilder) {
    // Г21: compact JSON, the fixed order of the keys, lowercase hex, no time, no device
    let w = conflict_of_two(b);
    let (item, _) = w.item_at("Notes/a.md");
    let set = &w.sets(1)[0];
    let expected = sets::meta_bytes(
        &set.id,
        "bothEdited",
        item.as_bytes(),
        "Notes/a.md",
        "other.md",
        b"one",
        Some(("base.md", b"base")),
    );
    assert_eq!(
        text(&set.meta),
        text(&expected),
        "meta.json must be these exact bytes"
    );
    assert_eq!(set.meta, expected);
    w.finish(false);
}

fn the_identifier_follows_the_formula_of_the_plan(b: EngineBuilder) {
    // Г22: BLAKE3 of the item, the hash of the second version, the server version and the hash of
    // the base
    let w = conflict_of_two(b);
    let (item, version) = w.item_at("Notes/a.md");
    let expected = sets::set_id(
        item.as_bytes(),
        &blake3_hash(b"one"),
        version,
        Some(&blake3_hash(b"base")),
        0,
    );
    assert_eq!(w.sets(1)[0].id, expected);
    w.finish(false);
}

fn a_conflict_made_here_is_in_the_state_of_this_device_only(b: EngineBuilder) {
    // Г25: the state's list means "made on this device"; the other device lists it from the files
    let w = conflict_of_two(b);
    let made = w.dev(1).state.snapshot().conflicts;
    assert_eq!(made.len(), 1);
    assert_eq!(made[0].id, w.sets(1)[0].id);
    assert_eq!(
        made[0].copy_path,
        format!(".amby/conflicts/{}/other.md", made[0].id)
    );
    assert_eq!(made[0].original_path, "Notes/a.md");
    assert!(w.dev(0).state.snapshot().conflicts.is_empty());
    w.finish(false);
}

fn two_devices_that_make_the_same_set_write_the_same_bytes(b: EngineBuilder) {
    // Г21, Г22, Д15: nothing in the set depends on the device, so the same conflict made on two
    // devices is one set, not two, and no copy is made of a file inside the folder
    let w = three(b);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/a.md", "base");
    w.round();
    w.round();
    w.round();
    w.save(0, "Notes/a.md", "zero");
    w.save(1, "Notes/a.md", "one");
    w.save(2, "Notes/a.md", "one");
    w.pass(0);
    w.pass(1);
    w.pass(2);
    w.round();
    w.round();
    for d in 0..3 {
        assert_eq!(w.sets(d).len(), 1, "device {d}: {:?}", w.texts(d).keys());
        assert!(
            !w.texts(d).keys().any(|p| p.contains("-conflict")),
            "device {d}: {:?}",
            w.texts(d).keys()
        );
    }
    assert_eq!(
        w.server_item_count(),
        5,
        "keep, a.md and one set of three files"
    );
    w.finish(false);
}

fn a_binary_file_goes_into_a_set_whole(b: EngineBuilder) {
    // Г28, Г6: no base, the extension of the original in the name of the file
    let w = pair_with_a(b);
    w.dev(0)
        .fs
        .user_write("assets/pic.png", &[0x89, b'P', b'N', b'G', 1, 2, 3]);
    w.pass(0);
    w.pass(1);
    w.dev(0)
        .fs
        .user_write("assets/pic.png", &[0x89, b'P', b'N', b'G', 9, 9, 9, 9]);
    w.dev(1)
        .fs
        .user_write("assets/pic.png", &[0x89, b'P', b'N', b'G', 5, 5]);
    w.pass(0);
    w.pass(1);
    let sets = w.sets(1);
    assert_eq!(sets.len(), 1);
    assert_eq!(sets[0].other, vec![0x89, b'P', b'N', b'G', 5, 5]);
    assert_eq!(sets[0].other_name, "other.png");
    assert!(sets[0].base.is_none());
    assert_eq!(
        w.dev(1).fs.content("assets/pic.png"),
        Some(vec![0x89, b'P', b'N', b'G', 9, 9, 9, 9])
    );
    w.finish(false);
}

// ----- resolving from any device -----

/// What the application does when the person resolves: writes the chosen content into the file
/// and removes the files of the set (Г26). Here it is done by the user's hand on the files.
fn resolve_by_hand(w: &World, d: usize, keep_other: bool) {
    let set = w.sets(d).remove(0);
    if keep_other {
        w.dev(d).fs.user_write(&set.path, &set.other);
    }
    let dir = format!(".amby/conflicts/{}", set.id);
    for (path, _) in w.dev(d).fs.files() {
        if path.starts_with(&format!("{dir}/")) {
            w.dev(d).fs.user_delete(&path);
        }
    }
}

fn resolving_with_the_other_version_on_either_device_clears_the_conflict_everywhere(
    b: EngineBuilder,
) {
    // Г26, Р7, О4: the file gets the chosen content, the set goes, and so it goes on the other
    // device; the second version stays recoverable in the trash of the vault there
    for resolver in [0usize, 1] {
        let w = conflict_of_two(b);
        let other = 1 - resolver;
        resolve_by_hand(&w, resolver, true);
        w.pass(resolver);
        w.pass(other);
        w.pass(resolver);
        for d in 0..2 {
            assert!(w.sets(d).is_empty(), "resolver {resolver}, device {d}");
            assert_eq!(
                w.read(d, "Notes/a.md").as_deref(),
                Some("one"),
                "resolver {resolver}, device {d}"
            );
        }
        assert!(
            w.dev(other).fs.trash().iter().any(|t| t.bytes == b"one"),
            "the second version is in the trash of the other device (О4, Р8)"
        );
        w.finish(false);
    }
}

fn resolving_by_keeping_the_file_only_removes_the_set_everywhere(b: EngineBuilder) {
    // Г26
    for resolver in [0usize, 1] {
        let w = conflict_of_two(b);
        let other = 1 - resolver;
        resolve_by_hand(&w, resolver, false);
        w.pass(resolver);
        w.pass(other);
        w.pass(resolver);
        for d in 0..2 {
            assert!(w.sets(d).is_empty(), "resolver {resolver}, device {d}");
            assert_eq!(w.read(d, "Notes/a.md").as_deref(), Some("zero"));
        }
        w.finish(false);
    }
}

// ----- old copies, and the folder of sets itself -----

fn an_old_style_copy_is_just_a_file_for_the_engine(b: EngineBuilder) {
    // Г29: the engine neither merges nor moves a copy made before К2; the application lists it
    let w = pair_with_a(b);
    w.save(0, "Notes/a.0123456789ab-conflict.md", "an old copy");
    w.pass(0);
    w.pass(1);
    assert_eq!(
        w.read(1, "Notes/a.0123456789ab-conflict.md").as_deref(),
        Some("an old copy")
    );
    assert!(w.sets(1).is_empty());
    assert!(w.dev(1).state.snapshot().conflicts.is_empty());
}

fn a_clash_inside_the_folder_of_sets_keeps_the_old_copy_beside_the_file(b: EngineBuilder) {
    // Г19: no set of a set; the rare clash on such a path is a copy next to the file, as before
    let w = two(b);
    w.save(0, "Keep/k.md", "keep");
    w.save(1, "Keep/k.md", "keep");
    w.dev(0)
        .fs
        .user_write(".amby/conflicts/aaaaaaaaaaaa/other.md", b"made on 0");
    w.dev(1)
        .fs
        .user_write(".amby/conflicts/aaaaaaaaaaaa/other.md", b"made on 1");
    w.pass(0);
    w.pass(1);
    w.settle_ok();
    let files = w.texts(1);
    assert_eq!(
        files
            .get(".amby/conflicts/aaaaaaaaaaaa/other.md")
            .map(String::as_str),
        Some("made on 0")
    );
    let copies: Vec<&String> = files
        .keys()
        .filter(|p| {
            p.starts_with(".amby/conflicts/aaaaaaaaaaaa/other.") && p.ends_with("-conflict.md")
        })
        .collect();
    assert_eq!(copies.len(), 1, "{files:?}");
    assert_eq!(files[copies[0]], "made on 1");
    assert_eq!(
        files
            .keys()
            .filter(|p| p.contains(".amby/conflicts/"))
            .count(),
        2
    );
    assert_eq!(w.texts(0), w.texts(1));
}

both!(
    no_file_in_the_tree_is_a_copy_and_the_set_is_where_the_plan_says,
    the_files_of_a_set_are_ordinary_items_of_the_server,
    the_files_of_a_set_go_up_in_one_commit,
    meta_json_is_exactly_the_documented_bytes,
    the_identifier_follows_the_formula_of_the_plan,
    a_conflict_made_here_is_in_the_state_of_this_device_only,
    two_devices_that_make_the_same_set_write_the_same_bytes,
    a_binary_file_goes_into_a_set_whole,
    resolving_with_the_other_version_on_either_device_clears_the_conflict_everywhere,
    resolving_by_keeping_the_file_only_removes_the_set_everywhere,
    an_old_style_copy_is_just_a_file_for_the_engine,
    a_clash_inside_the_folder_of_sets_keeps_the_old_copy_beside_the_file,
);
