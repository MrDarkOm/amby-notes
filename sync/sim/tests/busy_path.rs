//! Seed 1207 of the long run (Э4б): a rename of one item onto a path where another device made a
//! new file (Д49, Д71). Whatever the order of the passes, the devices must end up with the same
//! files (раздел 7, rule 1) and nothing may be lost. Real engine only.
//!
//! The path stays with the item of the smaller id on every device (Д71). Before the fix the rule
//! worked in one direction only: a *new* item of the larger id was parked, but when the smaller
//! one *arrived by a rename* onto a path held by the file of the larger one, nothing moved that
//! file away, and the rename waited for ever (`PathBusy`) while the other device had decided the
//! other way round.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

/// Both devices know `a.md`. Device 1 renames it to `p.md`; device 0 meanwhile edits `a.md`
/// (if `edit_on_0`) and makes a new file `p.md`. `first` is the device that synchronises first.
fn rename_onto_a_new_file(edit_on_0: bool, first: usize) {
    let w = two(Engine::boxed);
    w.save(0, "a.md", "base of a");
    w.pass(0);
    w.pass(1);
    w.dev(1).fs.user_rename("a.md", "p.md");
    if edit_on_0 {
        w.save(0, "a.md", "base of a, edited on device 0");
    }
    w.save(0, "p.md", "a new file of device 0");
    w.pass(first);
    w.pass(1 - first);
    w.finish(false);
    // Nothing is lost and nothing is parked for good: both contents are in the tree of both
    // devices (the second one in a conflict set), and the lists of unsynchronised files are empty.
    for d in 0..2 {
        let texts = w.texts(d);
        let all: Vec<&String> = texts.values().collect();
        assert!(
            all.iter().any(|t| t.as_str() == "a new file of device 0"),
            "device {d}: the new file is gone: {texts:?}"
        );
        let renamed_text = if edit_on_0 {
            "base of a, edited on device 0"
        } else {
            "base of a"
        };
        assert!(
            all.iter().any(|t| t.as_str() == renamed_text),
            "device {d}: the renamed file is gone: {texts:?}"
        );
        assert!(
            w.dev(d).state.snapshot().unsynced.is_empty(),
            "device {d}: a file stays parked: {:?}",
            w.dev(d).state.snapshot().unsynced
        );
    }
}

fn busy_edit_and_new_file_device_0_first(_b: EngineBuilder) {
    rename_onto_a_new_file(true, 0);
}
fn busy_edit_and_new_file_device_1_first(_b: EngineBuilder) {
    rename_onto_a_new_file(true, 1);
}
fn busy_plain_rename_and_new_file_device_0_first(_b: EngineBuilder) {
    rename_onto_a_new_file(false, 0);
}
fn busy_plain_rename_and_new_file_device_1_first(_b: EngineBuilder) {
    rename_onto_a_new_file(false, 1);
}

real_only!(
    busy_edit_and_new_file_device_0_first,
    busy_edit_and_new_file_device_1_first,
    busy_plain_rename_and_new_file_device_0_first,
    busy_plain_rename_and_new_file_device_1_first,
);
