use super::*;
use crate::database::discovery::migrate_legacy_database_manifests;
use crate::frontmatter::{clear_atomic_write_failure, inject_nth_atomic_write_failure};
use serde_json::json;

const DB_ID: &str = "01M2NKEGMJY9YHDNTV6HNWDFE6";
const VIEW_ID: &str = "01M1PTZSVFN6EZA2H7ENZ1CSB9";
const NOTE_ID: &str = "01M1Q23EBJDZNPWBC01W513DS0";
const PROPERTY_ID: &str = "01M1Q2K3ZZ0000000000000001";

struct Fixture {
    vault: PathBuf,
    db: PathBuf,
}

impl Fixture {
    /// A legacy database with one text property `Status`, one note and, when
    /// given, a record shard for `NOTE_ID` carrying `Status = shard_value`.
    fn new(note: Option<&str>, shard: Option<serde_json::Value>) -> Self {
        let vault =
            std::env::temp_dir().join(format!("amby-legacy-records-{}", ulid::Ulid::generate()));
        let db = vault.join("Legacy");
        fs::create_dir_all(db.join(".ambd/views")).unwrap();
        fs::create_dir_all(db.join(".ambd/records")).unwrap();
        let manifest = json!({
            "format": "amby-database", "formatVersion": 1, "databaseId": DB_ID,
            "name": "Legacy", "containerKind": "standalone", "locked": false,
            "membership": {"kind": "filesystem-descendants", "recursive": true},
            "properties": [{
                "id": PROPERTY_ID, "name": "Status", "type": "text",
                "pageVisibility": "alwaysShow", "yamlBinding": null,
                "config": {"multiline": false}
            }],
            "viewOrder": [VIEW_ID], "defaultViewId": VIEW_ID, "templateOrder": []
        });
        fs::write(
            db.join("Legacy.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let view = json!({
            "format": "amby-database-view", "formatVersion": 1, "databaseId": DB_ID,
            "viewId": VIEW_ID, "name": "Table", "layout": "table", "openMode": "sidePeek",
            "subitemsMode": "nested", "density": "default",
            "fields": [{"field": {"kind": "system", "field": "title"}, "visible": true, "width": null, "frozen": true}],
            "filter": null, "sorts": [], "group": null, "aggregates": []
        });
        fs::write(
            db.join(".ambd/views").join(format!("{VIEW_ID}.json")),
            serde_json::to_vec_pretty(&view).unwrap(),
        )
        .unwrap();
        if let Some(note) = note {
            fs::write(db.join("Row.md"), note).unwrap();
        }
        if let Some(value) = shard {
            fs::write(
                db.join(".ambd/records").join(format!("{NOTE_ID}.json")),
                serde_json::to_vec_pretty(&json!({
                    "format": "amby-database-record", "formatVersion": 1,
                    "databaseId": DB_ID, "noteId": NOTE_ID,
                    "values": {PROPERTY_ID: {"type": "text", "value": value}}
                }))
                .unwrap(),
            )
            .unwrap();
        }
        Self { vault, db }
    }

    fn note(&self) -> String {
        fs::read_to_string(self.db.join("Row.md")).unwrap()
    }

    fn shard(&self) -> PathBuf {
        self.db
            .join(".ambd/records")
            .join(format!("{NOTE_ID}.json"))
    }

    fn archived(&self) -> PathBuf {
        self.db.join(ARCHIVE_DIR).join(format!("{NOTE_ID}.json"))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        clear_atomic_write_failure();
        let _ = fs::remove_dir_all(&self.vault);
    }
}

fn note_with(status: Option<&str>) -> String {
    match status {
        Some(status) => format!("---\namby-id: {NOTE_ID}\nStatus: {status}\n---\n# Row\n"),
        None => format!("---\namby-id: {NOTE_ID}\n---\n# Row\n"),
    }
}

#[test]
fn a_value_already_in_the_note_is_never_overwritten_by_the_shard() {
    let fixture = Fixture::new(Some(&note_with(Some("Done"))), Some(json!("Todo")));
    let original_shard = fs::read(fixture.shard()).unwrap();
    migrate_legacy_database_manifests(&fixture.vault).unwrap();
    assert!(fixture.note().contains("Status: Done"));
    assert!(!fixture.note().contains("Todo"));
    // The conflicting old value survives in the archive.
    assert_eq!(fs::read(fixture.archived()).unwrap(), original_shard);
    assert!(!fixture.db.join(".ambd/records").exists());
}

#[test]
fn a_missing_value_moves_into_frontmatter_and_the_shard_is_archived() {
    let fixture = Fixture::new(Some(&note_with(None)), Some(json!("Todo")));
    migrate_legacy_database_manifests(&fixture.vault).unwrap();
    assert!(fixture.note().contains("Status: Todo"));
    assert!(fixture.archived().is_file());
    assert!(!fixture.shard().exists());
}

#[test]
fn a_shard_without_a_note_is_left_in_place() {
    let fixture = Fixture::new(None, Some(json!("Todo")));
    let before = fs::read(fixture.shard()).unwrap();
    migrate_legacy_database_manifests(&fixture.vault).unwrap();
    assert_eq!(fs::read(fixture.shard()).unwrap(), before);
    assert!(!fixture.archived().exists());
}

#[test]
fn an_unreadable_shard_is_left_in_place() {
    let fixture = Fixture::new(Some(&note_with(None)), Some(json!("Todo")));
    fs::write(fixture.shard(), b"{ not json").unwrap();
    migrate_legacy_database_manifests(&fixture.vault).unwrap();
    assert_eq!(fs::read(fixture.shard()).unwrap(), b"{ not json");
    assert_eq!(fixture.note(), note_with(None));
}

#[test]
fn a_failed_note_write_keeps_the_shard_and_the_note_untouched() {
    let fixture = Fixture::new(Some(&note_with(None)), Some(json!("Todo")));
    inject_nth_atomic_write_failure(1, false);
    migrate_legacy_database_manifests(&fixture.vault).unwrap();
    clear_atomic_write_failure();
    assert_eq!(fixture.note(), note_with(None));
    assert!(fixture.shard().is_file());
    // The next run, with the disk healthy again, finishes the transfer.
    migrate_legacy_database_manifests(&fixture.vault).unwrap();
    assert!(fixture.note().contains("Status: Todo"));
    assert!(fixture.archived().is_file());
}
