//! SYNC-02: on macOS and Windows `.GIT`, `.Amby` and `.Obsidian` are the same folders as `.git`,
//! `.amby` and `.obsidian`. An incoming path spelled with other letter case (or, on Windows, by its
//! 8.3 short name) must be excluded exactly like the usual spelling, or it is written into Git's,
//! Amby's own or another application's data.

use amby_sync_core::engine::rules::is_excluded_path;

#[test]
fn service_folders_are_excluded_whatever_their_letter_case() {
    for path in [
        ".GIT/config",
        "notes/.Git/hooks/pre-commit",
        ".AMBY/sync/state.db",
        ".Amby/recovery/draft.json",
        ".Obsidian/workspace.json",
        ".TRASH/old.md",
        "folder/THUMBS.DB",
        "folder/Desktop.INI",
    ] {
        assert!(is_excluded_path(path), "{path} must stay on this device");
    }
}

#[test]
fn the_synchronised_amby_folders_stay_synchronised_in_any_case() {
    assert!(!is_excluded_path(".AMBY/properties.json"));
    assert!(!is_excluded_path(".Amby/Blocks/a.json"));
    assert!(is_excluded_path(".AMBY/history/manifest.json"));
}

#[test]
fn windows_short_names_of_service_folders_are_excluded() {
    for path in [
        "GIT~1/config",
        "AMBY~1/sync/state.db",
        "OBSIDI~1/workspace.json",
        "TRASH~2/a.md",
    ] {
        assert!(is_excluded_path(path), "{path} must stay on this device");
    }
    // An ordinary name with a tilde is a note.
    assert!(!is_excluded_path("Notes~1/a.md"));
}

#[test]
fn ordinary_notes_are_not_affected() {
    for path in [
        "Git notes.md",
        "amby/notes.md",
        "Obsidian tips.md",
        "Trash talk.md",
    ] {
        assert!(!is_excluded_path(path), "{path} is a note");
    }
}
