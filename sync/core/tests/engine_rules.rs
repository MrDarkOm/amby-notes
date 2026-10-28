//! Small pure rules of the engine: what is not synchronised (Р4, Д11) and when a pass stops for a
//! mass change (Р8, О6, Д54). Red until written.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_core::engine::rules::{is_excluded_path, mass_change_reached};

#[test]
fn service_folders_and_litter_are_excluded() {
    // Р4, Д11.
    for path in [
        ".git/config",
        "sub/.git/HEAD",
        "a/b/.git/objects/x",
        ".git",
        ".obsidian/app.json",
        ".trash/old.md",
        ".amby/notes.db",
        ".amby/notes.db-wal",
        ".amby/history/a/1.md",
        ".amby/recovery/journal.json",
        ".amby/trash/x.md",
        ".amby/sync/state.db",
        ".amby/something-unknown.json",
        ".a.md.amby-tmp-3f",
        "Notes/.report.docx.amby-tmp-9",
        ".DS_Store",
        "Notes/.DS_Store",
        "._a.md",
        "Notes/._b.md",
        "Thumbs.db",
        "x/y/Thumbs.db",
        "desktop.ini",
        "x/desktop.ini",
    ] {
        assert!(is_excluded_path(path), "{path} must not be synchronised");
    }
}

#[test]
fn the_documented_amby_files_and_ordinary_files_are_synchronised() {
    // Р4, Д11: from `.amby/` only the named files; nested `.obsidian` and `.trash` are ordinary.
    for path in [
        "Notes/a.md",
        "a.md",
        ".amby/properties.json",
        ".amby/blocks/block-1.json",
        ".amby/graph-layout.json",
        ".amby/property-backups/2026.json",
        "sub/.obsidian/x.md",
        "sub/.trash/x.md",
        ".gitignore",
        ".github/workflows/ci.yml",
        "a.amby-tmp-1",
        "notes.DS_Store",
        "Thumbs.db.md",
        "_a.md",
        "Заметки/Ёлка.md",
    ] {
        assert!(!is_excluded_path(path), "{path} must be synchronised");
    }
}

#[test]
fn the_threshold_of_the_plan() {
    // Р8, О6, Д54: at least 20 files and more than 10% of the synchronised ones.
    let reached = |count, total| mass_change_reached(count, total, 20, 10);
    assert!(!reached(20, 200), "exactly 10% is not more than 10%");
    assert!(reached(21, 200));
    assert!(reached(20, 199));
    assert!(!reached(19, 50), "fewer than 20 never stops");
    assert!(!reached(19, 19));
    assert!(reached(20, 100));
    assert!(reached(20, 20));
    assert!(!reached(0, 0));
    assert!(!reached(0, 1000));
    assert!(!reached(100, 1000), "100 of 1000 is exactly 10%");
    assert!(reached(101, 1000));
}

#[test]
fn the_threshold_follows_its_settings() {
    // Р8, Д54, §9: the owner may change the numbers.
    assert!(!mass_change_reached(5, 20, 5, 25));
    assert!(mass_change_reached(6, 20, 5, 25));
    assert!(!mass_change_reached(4, 4, 5, 25));
    assert!(mass_change_reached(2, 19, 2, 10));
    assert!(!mass_change_reached(2, 20, 2, 10));
}

#[test]
fn the_threshold_does_not_overflow() {
    // Р8, Д54: sizes near the limits of the integer type must not panic or wrap.
    assert!(mass_change_reached(usize::MAX, usize::MAX, 20, 10));
    assert!(!mass_change_reached(usize::MAX / 20, usize::MAX, 20, 10));
    assert!(mass_change_reached(20, 0, 20, 10));
}
