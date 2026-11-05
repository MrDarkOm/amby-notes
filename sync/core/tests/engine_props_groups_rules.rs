//! What is synchronised of the properties (docs/sync-plan.md, appendix З: З14, З18, З28, З34, З36,
//! З41). Red until `rules.rs` knows the folder `.amby/properties/`. One test: the rules that hold
//! today are checked together with the one that is new, so the test cannot pass on the old rules.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_core::engine::rules::is_excluded_path;

#[test]
fn the_groups_travel_and_the_state_of_this_device_does_not() {
    // З14, З48, З53: `.amby/properties/` — the groups, the marks and `layout.json`
    for path in [
        ".amby/properties/layout.json",
        ".amby/properties/prop_0.jsonl",
        ".amby/properties/prop_a.jsonl",
        ".amby/properties/legacy_f.jsonl",
    ] {
        assert!(!is_excluded_path(path), "{path} must be synchronised (З14)");
    }
    // З14, З18: the old file is still synchronised, for the old versions
    assert!(!is_excluded_path(".amby/properties.json"));
    // З34: copies of removed records are immutable files with unique names
    assert!(!is_excluded_path(
        ".amby/property-backups/01JNOTE/01JOP.json"
    ));
    // З28 (Р4), З36, З41: the journal of edits and the state of a migration stay on the device
    for path in [
        ".amby/property-ops/01JABC.json",
        ".amby/property-ops/x/y.json",
        ".amby/migrations/01JABC/journal.json",
        ".amby/migrations/01JABC/properties.json",
    ] {
        assert!(is_excluded_path(path), "{path} must stay on this device");
    }
    // Р4: temporary files next to a group
    assert!(is_excluded_path(
        ".amby/properties/.prop_a.jsonl.amby-tmp-3f"
    ));
}
