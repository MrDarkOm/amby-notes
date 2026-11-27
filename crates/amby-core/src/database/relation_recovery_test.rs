use super::super::mutations::{DatabaseAffectedNote, DatabaseNoteRevision};
use super::*;
use crate::vault_context::VaultContext;
use serde_json::{json, Value};

struct RelationRecoveryFixture {
    vault: PathBuf,
    operation_id: String,
    request: UpdateDatabaseRelationValueRequest,
    result: UpdateDatabaseRelationValueResult,
    writes: Vec<RelationPlannedWrite>,
    source_path: PathBuf,
    target_path: PathBuf,
    source_pre: Vec<u8>,
    source_post: Vec<u8>,
    target_pre: Vec<u8>,
    target_post: Vec<u8>,
}

fn temp_vault() -> PathBuf {
    let vault =
        std::env::temp_dir().join(format!("amby-relation-recovery-{}", ulid::Ulid::generate()));
    fs::create_dir_all(&vault).unwrap();
    vault.canonicalize().unwrap()
}

fn relation_recovery_fixture() -> RelationRecoveryFixture {
    let vault = temp_vault();
    let source_database_id = ulid::Ulid::generate().to_string();
    let target_database_id = ulid::Ulid::generate().to_string();
    let source_note_id = ulid::Ulid::generate().to_string();
    let target_note_id = ulid::Ulid::generate().to_string();
    let property_id = ulid::Ulid::generate().to_string();
    let operation_id = format!("relation-{}", ulid::Ulid::generate());
    let source_path = vault.join("Source").join("Source.md");
    let target_path = vault.join("Target").join("Target.md");
    fs::create_dir_all(source_path.parent().unwrap()).unwrap();
    fs::create_dir_all(target_path.parent().unwrap()).unwrap();

    let source_pre =
        format!("\u{feff}---\r\namby-id: {source_note_id}\r\n---\r\nSource body\r\n").into_bytes();
    let source_post = format!(
        "\u{feff}---\r\namby-id: {source_note_id}\r\nRelated: [{target_note_id}]\r\n---\r\nSource body\r\n"
    )
    .into_bytes();
    let target_pre =
        format!("\u{feff}---\r\namby-id: {target_note_id}\r\n---\r\nTarget body\r\n").into_bytes();
    let target_post = format!(
        "\u{feff}---\r\namby-id: {target_note_id}\r\nSources: [{source_note_id}]\r\n---\r\nTarget body\r\n"
    )
    .into_bytes();
    fs::write(&source_path, &source_pre).unwrap();
    fs::write(&target_path, &target_pre).unwrap();

    let request = UpdateDatabaseRelationValueRequest {
        expected_generation: 1,
        operation_id: operation_id.clone(),
        expected_revision: raw_revision(&source_pre),
        database_id: source_database_id.clone(),
        note_id: source_note_id.clone(),
        property_id,
        target_note_ids: vec![target_note_id.clone()],
    };
    let result = UpdateDatabaseRelationValueResult {
        operation_id: operation_id.clone(),
        database_id: source_database_id.clone(),
        note_id: source_note_id.clone(),
        target_note_ids: vec![target_note_id.clone()],
        affected_notes: vec![
            DatabaseAffectedNote {
                database_id: source_database_id.clone(),
                note_id: source_note_id.clone(),
            },
            DatabaseAffectedNote {
                database_id: target_database_id.clone(),
                note_id: target_note_id.clone(),
            },
        ],
        revisions: vec![
            DatabaseNoteRevision {
                note_id: source_note_id.clone(),
                revision: raw_revision(&source_post),
            },
            DatabaseNoteRevision {
                note_id: target_note_id.clone(),
                revision: raw_revision(&target_post),
            },
        ],
        warnings: Vec::new(),
    };
    let writes = vec![
        RelationPlannedWrite {
            path: source_path.clone(),
            post_bytes: source_post.clone(),
            pre_bytes: source_pre.clone(),
            affected_note: DatabaseAffectedNote {
                database_id: source_database_id,
                note_id: source_note_id,
            },
        },
        RelationPlannedWrite {
            path: target_path.clone(),
            post_bytes: target_post.clone(),
            pre_bytes: target_pre.clone(),
            affected_note: DatabaseAffectedNote {
                database_id: target_database_id,
                note_id: target_note_id,
            },
        },
    ];

    RelationRecoveryFixture {
        vault,
        operation_id,
        request,
        result,
        writes,
        source_path,
        target_path,
        source_pre,
        source_post,
        target_pre,
        target_post,
    }
}

fn journal_path(fixture: &RelationRecoveryFixture) -> PathBuf {
    fixture
        .vault
        .join(".amby/recovery/database_relations")
        .join(format!("{}.json", fixture.operation_id))
}

fn backup_path(fixture: &RelationRecoveryFixture, index: usize) -> PathBuf {
    fixture
        .vault
        .join(".amby/recovery/database_relations")
        .join(&fixture.operation_id)
        .join(format!("{index}.bin"))
}

fn prepare_fixture(fixture: &RelationRecoveryFixture) -> RelationJournal {
    prepare(
        &fixture.vault,
        &fixture.request,
        &fixture.writes,
        &fixture.result,
    )
    .unwrap()
}

fn rewrite_journal(fixture: &RelationRecoveryFixture, mutate: impl FnOnce(&mut Value)) {
    let path = journal_path(fixture);
    let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    mutate(&mut value);
    let mut bytes = serde_json::to_vec_pretty(&value).unwrap();
    bytes.push(b'\n');
    fs::write(path, bytes).unwrap();
}

#[test]
fn relation_recovery_restores_raw_bytes_after_source_only_crash_and_is_idempotent() {
    let fixture = relation_recovery_fixture();
    let mut journal = prepare_fixture(&fixture);
    fs::write(&fixture.source_path, &fixture.source_post).unwrap();
    journal.applied(0).unwrap();

    assert_eq!(recover_pending_relations(&fixture.vault).unwrap(), 1);
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_pre);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_pre);
    assert_eq!(
        read_journal(&journal_path(&fixture)).unwrap().status,
        "rolledBack"
    );
    assert_eq!(recover_pending_relations(&fixture.vault).unwrap(), 0);
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_pre);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_pre);
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_progress_preserves_external_journal_edits_and_pending_outcome() {
    let fixture = relation_recovery_fixture();
    let mut journal = prepare_fixture(&fixture);
    rewrite_journal(&fixture, |value| {
        value["externalMetadata"] = json!({"keep": true});
    });
    let before = fs::read(journal_path(&fixture)).unwrap();
    assert!(journal.applied(0).is_err());
    assert!(journal.completed().is_err());
    assert_eq!(fs::read(journal_path(&fixture)).unwrap(), before);
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_pre);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_pre);
    assert_eq!(recover_pending_relations(&fixture.vault).unwrap(), 1);
    let value: Value = serde_json::from_slice(&fs::read(journal_path(&fixture)).unwrap()).unwrap();
    assert_eq!(value["externalMetadata"], json!({"keep": true}));
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_replay_rejects_outcome_targets_that_do_not_match_the_request() {
    let fixture = relation_recovery_fixture();
    let mut journal = prepare_fixture(&fixture);
    journal.applied(0).unwrap();
    journal.applied(1).unwrap();
    journal.completed().unwrap();
    rewrite_journal(&fixture, |value| {
        value["result"]["targetNoteIds"] = json!([ulid::Ulid::generate().to_string()]);
    });
    let before = fs::read(journal_path(&fixture)).unwrap();
    assert!(replay(&fixture.vault, &fixture.request).is_err());
    assert_eq!(fs::read(journal_path(&fixture)).unwrap(), before);
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_pre);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_pre);
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_recovery_restores_all_raw_bytes_after_last_write_before_completion() {
    let fixture = relation_recovery_fixture();
    let mut journal = prepare_fixture(&fixture);
    fs::write(&fixture.source_path, &fixture.source_post).unwrap();
    fs::write(&fixture.target_path, &fixture.target_post).unwrap();
    journal.applied(0).unwrap();
    journal.applied(1).unwrap();

    assert_eq!(recover_pending_relations(&fixture.vault).unwrap(), 1);
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_pre);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_pre);
    assert_eq!(
        read_journal(&journal_path(&fixture)).unwrap().status,
        "rolledBack"
    );
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn completed_relation_replay_returns_persisted_result_without_reading_records() {
    let fixture = relation_recovery_fixture();
    let mut journal = prepare_fixture(&fixture);
    journal.applied(0).unwrap();
    journal.applied(1).unwrap();
    journal.completed().unwrap();
    fs::remove_file(&fixture.source_path).unwrap();
    fs::remove_file(&fixture.target_path).unwrap();

    let replayed = replay(&fixture.vault, &fixture.request).unwrap().unwrap();
    assert_eq!(replayed, fixture.result);
    assert_eq!(
        replay(&fixture.vault, &fixture.request).unwrap(),
        Some(fixture.result)
    );
    assert!(!fixture.source_path.exists());
    assert!(!fixture.target_path.exists());
    assert_eq!(recover_pending_relations(&fixture.vault).unwrap(), 0);
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_replay_rejects_payload_mismatch_and_rolled_back_operation_reuse() {
    let fixture = relation_recovery_fixture();
    let mut journal = prepare_fixture(&fixture);
    journal.applied(0).unwrap();
    journal.applied(1).unwrap();
    journal.completed().unwrap();
    let mut mismatch = fixture.request.clone();
    mismatch.target_note_ids.clear();
    assert!(replay(&fixture.vault, &mismatch).is_err());
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_pre);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_pre);

    let fixture = relation_recovery_fixture();
    let mut journal = prepare_fixture(&fixture);
    fs::write(&fixture.source_path, &fixture.source_post).unwrap();
    journal.applied(0).unwrap();
    assert_eq!(recover_pending_relations(&fixture.vault).unwrap(), 1);
    assert!(replay(&fixture.vault, &fixture.request).is_err());
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_recovery_rejects_corrupt_backup_without_changing_records_or_journal() {
    let fixture = relation_recovery_fixture();
    let _journal = prepare_fixture(&fixture);
    fs::write(&fixture.source_path, &fixture.source_post).unwrap();
    fs::write(&fixture.target_path, &fixture.target_post).unwrap();
    fs::write(backup_path(&fixture, 0), b"corrupt backup").unwrap();
    let journal_before = fs::read(journal_path(&fixture)).unwrap();

    assert!(recover_pending_relations(&fixture.vault).is_err());
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_post);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_post);
    assert_eq!(fs::read(journal_path(&fixture)).unwrap(), journal_before);
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_recovery_rejects_later_external_edit_without_changing_journal() {
    let fixture = relation_recovery_fixture();
    let _journal = prepare_fixture(&fixture);
    let source_external = b"\xef\xbb\xbf---\r\namby-id: external\r\n---\r\nExternal\r\n";
    fs::write(&fixture.source_path, source_external).unwrap();
    fs::write(&fixture.target_path, &fixture.target_post).unwrap();
    let journal_before = fs::read(journal_path(&fixture)).unwrap();

    assert!(recover_pending_relations(&fixture.vault).is_err());
    assert_eq!(fs::read(&fixture.source_path).unwrap(), source_external);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_post);
    assert_eq!(fs::read(journal_path(&fixture)).unwrap(), journal_before);
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_recovery_missing_record_refuses_without_recreating_it() {
    let fixture = relation_recovery_fixture();
    let _journal = prepare_fixture(&fixture);
    fs::write(&fixture.source_path, &fixture.source_post).unwrap();
    fs::remove_file(&fixture.target_path).unwrap();
    let journal_before = fs::read(journal_path(&fixture)).unwrap();

    assert!(recover_pending_relations(&fixture.vault).is_err());
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_post);
    assert!(!fixture.target_path.exists());
    assert_eq!(fs::read(journal_path(&fixture)).unwrap(), journal_before);
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_recovery_preserves_unknown_journal_fields_when_rolling_back() {
    let fixture = relation_recovery_fixture();
    let _journal = prepare_fixture(&fixture);
    rewrite_journal(&fixture, |value| {
        value["vendorMetadata"] = json!({"keep": ["source", 7]});
        value["steps"][0]["vendorStep"] = json!("preserve");
    });
    fs::write(&fixture.source_path, &fixture.source_post).unwrap();
    assert_eq!(recover_pending_relations(&fixture.vault).unwrap(), 1);

    let value: Value = serde_json::from_slice(&fs::read(journal_path(&fixture)).unwrap()).unwrap();
    assert_eq!(value["vendorMetadata"], json!({"keep": ["source", 7]}));
    assert_eq!(value["steps"][0]["vendorStep"], json!("preserve"));
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_recovery_rejects_duplicate_paths_and_traversal_before_restoring() {
    for mutation in ["duplicate", "traversal"] {
        let fixture = relation_recovery_fixture();
        let _journal = prepare_fixture(&fixture);
        fs::write(&fixture.source_path, &fixture.source_post).unwrap();
        fs::write(&fixture.target_path, &fixture.target_post).unwrap();
        let source_before = fs::read(&fixture.source_path).unwrap();
        let target_before = fs::read(&fixture.target_path).unwrap();
        rewrite_journal(&fixture, |value| {
            if mutation == "duplicate" {
                value["steps"][1]["recordPath"] = value["steps"][0]["recordPath"].clone();
            } else {
                value["steps"][0]["recordPath"] = json!("../outside.md");
            }
        });
        assert!(recover_pending_relations(&fixture.vault).is_err());
        assert_eq!(fs::read(&fixture.source_path).unwrap(), source_before);
        assert_eq!(fs::read(&fixture.target_path).unwrap(), target_before);
        let _ = fs::remove_dir_all(fixture.vault);
    }
}

#[cfg(unix)]
#[test]
fn relation_recovery_rejects_symlinked_record_path_before_restoring() {
    let fixture = relation_recovery_fixture();
    let _journal = prepare_fixture(&fixture);
    fs::write(&fixture.source_path, &fixture.source_post).unwrap();
    fs::write(&fixture.target_path, &fixture.target_post).unwrap();
    let alias = fixture.vault.join("Source").join("Alias.md");
    std::os::unix::fs::symlink(&fixture.source_path, &alias).unwrap();
    rewrite_journal(&fixture, |value| {
        value["steps"][0]["recordPath"] = json!("Source/Alias.md");
    });
    assert!(recover_pending_relations(&fixture.vault).is_err());
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_post);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_post);
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn activation_rejects_corrupt_schema_journal_before_restoring_pending_relation_notes() {
    let fixture = relation_recovery_fixture();
    let _journal = prepare_fixture(&fixture);
    fs::write(&fixture.source_path, &fixture.source_post).unwrap();
    fs::write(&fixture.target_path, &fixture.target_post).unwrap();
    let schema_root = fixture
        .vault
        .join(".amby/recovery/database_relation_schemas");
    fs::create_dir_all(&schema_root).unwrap();
    fs::write(
        schema_root.join("corrupt-schema-operation.json"),
        b"{ this is not a recovery journal }",
    )
    .unwrap();

    assert!(VaultContext::prepare_activation(fixture.vault.to_str().unwrap()).is_err());
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_post);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_post);
    let _ = fs::remove_dir_all(fixture.vault);
}
