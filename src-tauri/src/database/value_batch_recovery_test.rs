use super::*;
use crate::database::mutations::{
    apply_value_batch, create_database, create_database_property, CreateDatabasePropertyRequest,
    CreateDatabaseRequest, DatabaseCreateMode, DatabaseValueBatchRequest, DatabaseValueMutation,
};
use crate::database::rows::{create_database_row, CreateDatabaseRowRequest, DatabaseRowTemplate};
use crate::frontmatter::{clear_atomic_write_failure, inject_nth_atomic_write_failure};
use crate::watcher::WatcherState;

struct Fixture {
    vault: PathBuf,
    watcher: WatcherState,
    database_id: String,
    property_id: String,
    note_id: String,
    note_path: PathBuf,
    original: Vec<u8>,
    revision: String,
}

impl Fixture {
    fn new() -> Self {
        let vault =
            std::env::temp_dir().join(format!("amby-batch-recovery-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&vault).unwrap();
        let watcher = WatcherState::new();
        let created = create_database(
            &vault,
            &watcher,
            &CreateDatabaseRequest {
                expected_generation: 1,
                mode: DatabaseCreateMode::Standalone,
                parent_path: Some(vault.to_string_lossy().to_string()),
                note_path: None,
                name: "Projects".to_owned(),
            },
        )
        .unwrap();
        let property = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                expected_manifest_revision: created.manifest_revision,
                name: "Summary".to_owned(),
                property_type: "text".to_owned(),
                before_property_id: None,
                options: Vec::new(),
                formula_expression: None,
                ..Default::default()
            },
        )
        .unwrap();
        let row = create_database_row(
            &vault,
            &watcher,
            &CreateDatabaseRowRequest {
                expected_generation: 1,
                database_id: created.database_id.clone(),
                title: "First".to_owned(),
                template: DatabaseRowTemplate::Default,
            },
        )
        .unwrap();
        let original = fs::read(&row.note_path).unwrap();
        Self {
            vault,
            watcher,
            database_id: created.database_id,
            property_id: property.property_id,
            note_id: row.note_id,
            note_path: PathBuf::from(&row.note_path),
            original,
            revision: row.record_revision,
        }
    }

    fn request(&self, operation_id: &str, value: &str) -> DatabaseValueBatchRequest {
        DatabaseValueBatchRequest {
            expected_generation: 1,
            database_id: self.database_id.clone(),
            operation_id: operation_id.to_owned(),
            cells: vec![DatabaseValueMutation {
                note_id: self.note_id.clone(),
                property_id: self.property_id.clone(),
                value_json: Some(format!(r#"{{"type":"text","value":"{value}"}}"#)),
                expected_revision: self.revision.clone(),
            }],
        }
    }

    fn apply(
        &self,
        request: &DatabaseValueBatchRequest,
    ) -> Result<super::DatabaseValueBatchResult, String> {
        apply_value_batch(&self.vault, &self.watcher, request, None)
    }

    fn journal_path(&self, operation_id: &str) -> PathBuf {
        recovery_root(&self.vault).join(format!("{operation_id}.json"))
    }

    fn backup_dir(&self, operation_id: &str) -> PathBuf {
        recovery_root(&self.vault).join(operation_id)
    }

    fn assert_no_recovery_state(&self, operation_id: &str) {
        assert!(!self.journal_path(operation_id).exists());
        assert!(!self.backup_dir(operation_id).exists());
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        clear_atomic_write_failure();
        let _ = fs::remove_dir_all(&self.vault);
    }
}

/// Number of atomic writes one successful single-note batch performs. The
/// completed-journal publication is the last of them and the note write is the
/// one before it.
fn atomic_writes_of_a_batch() -> u64 {
    let fixture = Fixture::new();
    inject_nth_atomic_write_failure(u64::MAX, false);
    fixture.apply(&fixture.request("count-op", "x")).unwrap();
    let calls = clear_atomic_write_failure();
    assert!(calls >= 4, "backup, journal, note and completed journal");
    calls
}

#[test]
fn backup_failure_stops_the_batch_before_any_note_changes() {
    let fixture = Fixture::new();
    inject_nth_atomic_write_failure(1, false);
    let error = fixture
        .apply(&fixture.request("op-backup", "done"))
        .unwrap_err();
    clear_atomic_write_failure();
    assert!(error.contains("back up"), "{error}");
    assert_eq!(fs::read(&fixture.note_path).unwrap(), fixture.original);
    fixture.assert_no_recovery_state("op-backup");
}

#[test]
fn journal_publication_failure_stops_the_batch_before_any_note_changes() {
    let fixture = Fixture::new();
    inject_nth_atomic_write_failure(2, false);
    let error = fixture
        .apply(&fixture.request("op-journal", "done"))
        .unwrap_err();
    clear_atomic_write_failure();
    assert!(error.contains("recovery journal"), "{error}");
    assert_eq!(fs::read(&fixture.note_path).unwrap(), fixture.original);
    fixture.assert_no_recovery_state("op-journal");
}

#[test]
fn recovery_directory_failure_stops_the_batch_before_any_note_changes() {
    let fixture = Fixture::new();
    // A file where the recovery directory must be makes create_dir_all fail.
    let blocker = fixture.vault.join(".amby").join("recovery");
    fs::create_dir_all(blocker.parent().unwrap()).unwrap();
    fs::write(&blocker, b"not a directory").unwrap();
    let error = fixture
        .apply(&fixture.request("op-dir", "done"))
        .unwrap_err();
    assert!(error.contains("recovery directory"), "{error}");
    assert_eq!(fs::read(&fixture.note_path).unwrap(), fixture.original);
}

#[test]
fn finalization_failure_quarantines_the_recovery_state_instead_of_dropping_it() {
    let last = atomic_writes_of_a_batch();
    let fixture = Fixture::new();
    inject_nth_atomic_write_failure(last, false);
    let result = fixture.apply(&fixture.request("op-final", "done")).unwrap();
    clear_atomic_write_failure();

    // The note is written and confirmed, so the batch is not reported as failed.
    assert!(fs::read_to_string(&fixture.note_path)
        .unwrap()
        .contains("done"));
    assert_eq!(result.revisions.len(), 1);
    assert_eq!(result.warnings.len(), 1, "{:?}", result.warnings);
    assert!(result.warnings[0].contains("quarantine"));

    // Nothing is deleted, but nothing is left that vault activation would roll back.
    assert!(!fixture.journal_path("op-final").exists());
    assert_eq!(
        recover_pending_batches(&fixture.vault).unwrap().recovered,
        0
    );
    assert!(fs::read_to_string(&fixture.note_path)
        .unwrap()
        .contains("done"));
    let quarantine = recovery_root(&fixture.vault).join("quarantine");
    let journal = read_batch_journal(&quarantine.join("op-final.json")).unwrap();
    // The unfinished journal is kept as evidence; quarantine is never auto-applied.
    assert_eq!(journal.status, "inProgress");
    let backup = quarantine
        .join("op-final")
        .join(format!("{}.md", fixture.note_id));
    assert_eq!(fs::read(backup).unwrap(), fixture.original);

    // Replaying the same payload is a clean no-op.
    let replay = fixture.apply(&fixture.request("op-final", "done")).unwrap();
    assert!(replay.warnings.is_empty());
    assert_eq!(replay.revisions, result.revisions);
}

#[test]
fn finalization_failure_with_blocked_quarantine_warns_that_a_rollback_may_follow() {
    let last = atomic_writes_of_a_batch();
    let fixture = Fixture::new();
    // A file where `quarantine/` must be makes the move impossible.
    fs::create_dir_all(recovery_root(&fixture.vault)).unwrap();
    fs::write(recovery_root(&fixture.vault).join("quarantine"), b"blocker").unwrap();
    inject_nth_atomic_write_failure(last, false);
    let result = fixture
        .apply(&fixture.request("op-blocked", "done"))
        .unwrap();
    clear_atomic_write_failure();

    assert!(
        result.warnings[0].contains("may roll"),
        "{:?}",
        result.warnings
    );
    // Evidence is untouched: journal and exact backup are still on disk.
    assert_eq!(
        read_batch_journal(&fixture.journal_path("op-blocked"))
            .unwrap()
            .status,
        "inProgress"
    );
    let backup = fixture
        .backup_dir("op-blocked")
        .join(format!("{}.md", fixture.note_id));
    assert_eq!(fs::read(backup).unwrap(), fixture.original);
}

#[test]
fn an_unfinished_journal_for_the_same_operation_is_never_overwritten() {
    let fixture = Fixture::new();
    // Simulate an interrupted run: the journal is published, the note untouched.
    let planned = vec![(
        fixture.note_path.clone(),
        b"new".to_vec(),
        fixture.original.clone(),
        fixture.note_id.clone(),
    )];
    let recovery = BatchRecovery::publish(
        &fixture.vault,
        "op-pending",
        &fixture.database_id,
        "rev".to_owned(),
        &planned,
    )
    .unwrap();
    drop(recovery);

    let error = fixture
        .apply(&fixture.request("op-pending", "other"))
        .unwrap_err();
    assert!(error.contains("unfinished recovery journal"), "{error}");
    let backup = fixture
        .backup_dir("op-pending")
        .join(format!("{}.md", fixture.note_id));
    assert_eq!(fs::read(backup).unwrap(), fixture.original);
    assert_eq!(
        read_batch_journal(&fixture.journal_path("op-pending"))
            .unwrap()
            .status,
        "inProgress"
    );
}

#[test]
fn failed_note_write_rolls_back_and_completed_batches_clean_up() {
    let last = atomic_writes_of_a_batch();
    let fixture = Fixture::new();
    // The note write is the atomic write just before the completed journal.
    inject_nth_atomic_write_failure(last - 1, true);
    let error = fixture
        .apply(&fixture.request("op-write", "done"))
        .unwrap_err();
    clear_atomic_write_failure();
    assert!(error.contains("rolled back"), "{error}");
    assert_eq!(fs::read(&fixture.note_path).unwrap(), fixture.original);
    assert_eq!(
        read_batch_journal(&fixture.journal_path("op-write"))
            .unwrap()
            .status,
        "rolledBack"
    );

    let ok = Fixture::new();
    let result = ok.apply(&ok.request("op-ok", "done")).unwrap();
    assert!(result.warnings.is_empty());
    assert_eq!(
        read_batch_journal(&ok.journal_path("op-ok"))
            .unwrap()
            .status,
        "completed"
    );
    assert!(!ok.backup_dir("op-ok").exists());
}
