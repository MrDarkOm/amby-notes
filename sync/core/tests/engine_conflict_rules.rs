//! Which files of `.amby/conflicts/` travel (docs/sync-plan.md, Р4, appendix Г, Г24): the whole
//! folder does, and nothing around it changes. Red until `is_excluded_path` knows the folder.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_core::engine::rules::is_excluded_path;

#[test]
fn the_files_of_a_conflict_set_are_synchronised() {
    // Г24, Р4: the second version is seen and resolved from any device
    for path in [
        ".amby/conflicts",
        ".amby/conflicts/0123456789ab",
        ".amby/conflicts/0123456789ab/meta.json",
        ".amby/conflicts/0123456789ab/other.md",
        ".amby/conflicts/0123456789ab/other",
        ".amby/conflicts/0123456789ab/base.md",
        ".amby/conflicts/0123456789ab/other.png",
    ] {
        assert!(!is_excluded_path(path), "{path} must be synchronised");
    }
}

#[test]
fn temporary_files_and_litter_inside_the_folder_are_still_excluded() {
    // Р4, Д11
    assert!(!is_excluded_path(".amby/conflicts/0123456789ab/meta.json"));
    for path in [
        ".amby/conflicts/0123456789ab/.meta.json.amby-tmp-1-2",
        ".amby/conflicts/0123456789ab/.DS_Store",
        ".amby/conflicts/0123456789ab/._other.md",
        ".amby/conflicts/.DS_Store",
    ] {
        assert!(is_excluded_path(path), "{path}");
    }
}

#[test]
fn only_the_named_folder_was_added() {
    // Р4: the default stays "no" for everything not named
    assert!(!is_excluded_path(".amby/conflicts/0123456789ab/meta.json"));
    for path in [
        ".amby/conflicts-old/x",
        ".amby/conflict/x",
        ".amby/conflictsx",
        ".amby/sync/bases/0123/abcd",
        ".amby/sync/state.db",
        ".amby/history/x",
        ".amby/trash/conflicts/0123456789ab/meta.json",
        ".amby/recovery/conflicts/x",
    ] {
        assert!(is_excluded_path(path), "{path}");
    }
    // and conflicts/ outside .amby/ is an ordinary folder of the user
    assert!(!is_excluded_path("conflicts/0123456789ab/meta.json"));
    assert!(!is_excluded_path("Notes/conflicts/a.md"));
}
