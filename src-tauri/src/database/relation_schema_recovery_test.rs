use super::super::mutations::{
    create_database, ChangeDatabasePropertyTypeRequest, ChangedDatabasePropertyType,
    CreateDatabasePropertyRequest, CreateDatabaseRequest, CreatedDatabaseProperty,
    DatabaseCreateMode, DatabaseManifestRevision,
};
use super::*;
use crate::vault_context::VaultContext;
use crate::watcher::WatcherState;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

struct SchemaRecoveryFixture {
    vault: PathBuf,
    operation_id: String,
    request: CreateDatabasePropertyRequest,
    result: CreatedDatabaseProperty,
    writes: Vec<SchemaPlannedWrite>,
    source_path: PathBuf,
    target_path: PathBuf,
    source_pre: Vec<u8>,
    source_post: Vec<u8>,
    target_pre: Vec<u8>,
    target_post: Vec<u8>,
}

fn temp_vault() -> PathBuf {
    let vault = std::env::temp_dir().join(format!(
        "amby-relation-schema-recovery-{}",
        ulid::Ulid::generate()
    ));
    fs::create_dir_all(&vault).unwrap();
    vault.canonicalize().unwrap()
}

fn schema_recovery_fixture() -> SchemaRecoveryFixture {
    let vault = temp_vault();
    let watcher = WatcherState::new();
    let source = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "Source".to_owned(),
        },
    )
    .unwrap();
    let target = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "Target".to_owned(),
        },
    )
    .unwrap();
    let source_database_id = source.database_id.clone();
    let target_database_id = target.database_id.clone();
    let operation_id = format!("relation-schema-{}", ulid::Ulid::generate());
    let inverse_property_id = ulid::Ulid::generate().to_string();
    let source_path = PathBuf::from(&source.manifest_path);
    let target_path = PathBuf::from(&target.manifest_path);
    let source_pre = fs::read(&source_path).unwrap();
    let target_pre = fs::read(&target_path).unwrap();
    let mut source_json: Value = serde_json::from_slice(&source_pre).unwrap();
    source_json["recoveryTest"] = json!("Related");
    let source_post = serde_json::to_vec_pretty(&source_json).unwrap();
    let mut target_json: Value = serde_json::from_slice(&target_pre).unwrap();
    target_json["recoveryTest"] = json!("Sources");
    let target_post = serde_json::to_vec_pretty(&target_json).unwrap();

    let request = CreateDatabasePropertyRequest {
        expected_generation: 1,
        database_id: source_database_id.clone(),
        expected_manifest_revision: raw_revision(&source_pre),
        name: "Related".to_owned(),
        property_type: "relation".to_owned(),
        relation_target_database_id: Some(target_database_id.clone()),
        relation_two_way: Some(true),
        relation_inverse_property_name: Some("Sources".to_owned()),
        operation_id: Some(operation_id.clone()),
        expected_target_manifest_revision: Some(raw_revision(&target_pre)),
        ..Default::default()
    };
    let result = CreatedDatabaseProperty {
        database_id: source_database_id.clone(),
        property_id: ulid::Ulid::generate().to_string(),
        name: "Related".to_owned(),
        property_type: "relation".to_owned(),
        manifest_revision: raw_revision(&source_post),
        operation_id: Some(operation_id.clone()),
        inverse_property_id: Some(inverse_property_id),
        manifest_revisions: vec![
            DatabaseManifestRevision {
                database_id: source_database_id.clone(),
                revision: raw_revision(&source_post),
            },
            DatabaseManifestRevision {
                database_id: target_database_id.clone(),
                revision: raw_revision(&target_post),
            },
        ],
        warnings: Vec::new(),
    };
    let writes = vec![
        SchemaPlannedWrite {
            database_id: source_database_id,
            path: source_path.clone(),
            pre_bytes: source_pre.clone(),
            post_bytes: source_post.clone(),
        },
        SchemaPlannedWrite {
            database_id: target_database_id,
            path: target_path.clone(),
            pre_bytes: target_pre.clone(),
            post_bytes: target_post.clone(),
        },
    ];

    SchemaRecoveryFixture {
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

fn journal_path(fixture: &SchemaRecoveryFixture) -> PathBuf {
    fixture
        .vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{}.json", fixture.operation_id))
}

fn backup_path(fixture: &SchemaRecoveryFixture, index: usize) -> PathBuf {
    fixture
        .vault
        .join(".amby/recovery/database_relation_schemas")
        .join(&fixture.operation_id)
        .join(format!("{index}.bin"))
}

fn publish_fixture(fixture: &SchemaRecoveryFixture) {
    let watcher = WatcherState::new();
    publish(
        &fixture.vault,
        &watcher,
        &fixture.request,
        &fixture.writes,
        &fixture.result,
    )
    .unwrap();
}

fn rewrite_journal(fixture: &SchemaRecoveryFixture, mutate: impl FnOnce(&mut Value)) {
    let path = journal_path(fixture);
    let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    mutate(&mut value);
    let mut bytes = serde_json::to_vec_pretty(&value).unwrap();
    bytes.push(b'\n');
    fs::write(path, bytes).unwrap();
}

fn set_step_path(value: &mut Value, index: usize, path: &str) {
    value["steps"][index]["manifestPath"] = json!(path);
}

fn mark_completed(value: &mut Value) {
    value["status"] = json!("completed");
    for step in value["steps"].as_array_mut().unwrap() {
        step["status"] = json!("applied");
    }
}

fn mark_pending(value: &mut Value) {
    value["status"] = json!("inProgress");
    for step in value["steps"].as_array_mut().unwrap() {
        step["status"] = json!("planned");
    }
}

struct TypeChangeRecoveryFixture {
    vault: PathBuf,
    request: ChangeDatabasePropertyTypeRequest,
    result: ChangedDatabasePropertyType,
    writes: Vec<SchemaPlannedWrite>,
    pre_bytes: Vec<Vec<u8>>,
    post_bytes: Vec<Vec<u8>>,
}

fn type_change_recovery_fixture(step_count: usize) -> TypeChangeRecoveryFixture {
    assert!(matches!(step_count, 1 | 3));
    let vault = temp_vault();
    let watcher = WatcherState::new();
    let mut databases = Vec::new();
    for name in (0..step_count).map(|index| match index {
        0 => "Source".to_owned(),
        1 => "Old".to_owned(),
        _ => "New".to_owned(),
    }) {
        databases.push(
            create_database(
                &vault,
                &watcher,
                &CreateDatabaseRequest {
                    expected_generation: 1,
                    mode: DatabaseCreateMode::Standalone,
                    parent_path: Some(vault.to_string_lossy().to_string()),
                    note_path: None,
                    name,
                },
            )
            .unwrap(),
        );
    }

    let pre_bytes = databases
        .iter()
        .map(|database| fs::read(&database.manifest_path).unwrap())
        .collect::<Vec<_>>();
    let post_bytes = pre_bytes
        .iter()
        .enumerate()
        .map(|(index, bytes)| {
            let mut value: Value = serde_json::from_slice(bytes).unwrap();
            value["recoveryFixture"] = json!({"step": index, "kind": "propertyType"});
            let mut next = serde_json::to_vec_pretty(&value).unwrap();
            next.push(b'\n');
            next
        })
        .collect::<Vec<_>>();
    let operation_id = format!("relation-schema-{}", ulid::Ulid::generate());
    let property_id = ulid::Ulid::generate().to_string();
    let request = ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: databases[0].database_id.clone(),
        property_id: property_id.clone(),
        expected_manifest_revision: raw_revision(&pre_bytes[0]),
        property_type: "relation".to_owned(),
        relation_target_database_id: databases
            .get(1)
            .map(|database| database.database_id.clone()),
        relation_two_way: Some(step_count > 1),
        operation_id: Some(operation_id.clone()),
        expected_related_manifest_revisions: databases
            .iter()
            .skip(1)
            .zip(pre_bytes.iter().skip(1))
            .map(|(database, bytes)| DatabaseManifestRevision {
                database_id: database.database_id.clone(),
                revision: raw_revision(bytes),
            })
            .collect(),
        ..Default::default()
    };
    let result = ChangedDatabasePropertyType {
        database_id: databases[0].database_id.clone(),
        property_id,
        property_type: "relation".to_owned(),
        manifest_revision: raw_revision(&post_bytes[0]),
        operation_id: Some(operation_id),
        inverse_property_id: (step_count > 1).then(|| ulid::Ulid::generate().to_string()),
        manifest_revisions: databases
            .iter()
            .zip(post_bytes.iter())
            .map(|(database, bytes)| DatabaseManifestRevision {
                database_id: database.database_id.clone(),
                revision: raw_revision(bytes),
            })
            .collect(),
        warnings: Vec::new(),
    };
    let writes = databases
        .iter()
        .zip(pre_bytes.iter().zip(post_bytes.iter()))
        .map(|(database, (pre_bytes, post_bytes))| SchemaPlannedWrite {
            database_id: database.database_id.clone(),
            path: PathBuf::from(&database.manifest_path),
            pre_bytes: pre_bytes.clone(),
            post_bytes: post_bytes.clone(),
        })
        .collect();
    TypeChangeRecoveryFixture {
        vault,
        request,
        result,
        writes,
        pre_bytes,
        post_bytes,
    }
}

#[test]
fn v2_property_type_recovery_restores_source_only_manifest_after_crash() {
    let fixture = type_change_recovery_fixture(1);
    let journal = prepare_type_change_journal(
        &fixture.vault,
        &fixture.request,
        &fixture.writes,
        &fixture.result,
    )
    .unwrap();
    assert_eq!(journal.journal.format_version, TYPE_CHANGE_VERSION);
    fs::write(&fixture.writes[0].path, &fixture.post_bytes[0]).unwrap();

    assert_eq!(recover_pending_relation_schemas(&fixture.vault).unwrap(), 1);
    assert_eq!(
        fs::read(&fixture.writes[0].path).unwrap(),
        fixture.pre_bytes[0]
    );
    assert_eq!(recover_pending_relation_schemas(&fixture.vault).unwrap(), 0);
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn v2_readonly_related_edit_before_completion_rolls_back_source_and_preserves_external_bytes() {
    let mut fixture = type_change_recovery_fixture(1);
    let watcher = WatcherState::new();
    let target = create_database(
        &fixture.vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(fixture.vault.to_string_lossy().to_string()),
            note_path: None,
            name: "Readonly".to_owned(),
        },
    )
    .unwrap();
    fixture.request.relation_target_database_id = Some(target.database_id.clone());
    fixture.request.expected_related_manifest_revisions = vec![DatabaseManifestRevision {
        database_id: target.database_id,
        revision: target.manifest_revision,
    }];
    let guards =
        type_change_readonly_guards(&fixture.vault, &fixture.request, &fixture.writes).unwrap();
    assert_eq!(guards.len(), 1);
    let journal = prepare_type_change_journal(
        &fixture.vault,
        &fixture.request,
        &fixture.writes,
        &fixture.result,
    )
    .unwrap();
    let target_path = PathBuf::from(target.manifest_path);
    let mut external: Value = serde_json::from_slice(&fs::read(&target_path).unwrap()).unwrap();
    external["externalEdit"] = json!(true);
    let external_bytes = serde_json::to_vec_pretty(&external).unwrap();
    let checks = std::cell::Cell::new(0);
    let error = publish_prepared(
        &watcher,
        fixture.request.operation_id.as_deref().unwrap(),
        journal,
        &fixture.writes,
        || {
            checks.set(checks.get() + 1);
            if checks.get() == 2 {
                // Source is already published; target is a read dependency,
                // never a planned write or a rollback destination.
                fs::write(&target_path, &external_bytes).unwrap();
            }
            recheck_readonly_guards(&fixture.vault, &guards)
        },
    )
    .unwrap_err();
    assert!(error.contains("revision conflict"), "{error}");
    assert_eq!(
        fs::read(&fixture.writes[0].path).unwrap(),
        fixture.pre_bytes[0]
    );
    assert_eq!(fs::read(&target_path).unwrap(), external_bytes);
    let journal_path = fixture
        .vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{}.json", fixture.request.operation_id.unwrap()));
    let journal: Value = serde_json::from_slice(&fs::read(journal_path).unwrap()).unwrap();
    assert_eq!(journal["status"], "rolledBack");
    assert!(journal["result"].is_null());
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn v2_property_type_recovery_restores_partial_three_manifest_operation() {
    let fixture = type_change_recovery_fixture(3);
    let journal = prepare_type_change_journal(
        &fixture.vault,
        &fixture.request,
        &fixture.writes,
        &fixture.result,
    )
    .unwrap();
    assert_eq!(journal.journal.steps.len(), 3);
    // Simulate a crash after source and old-target publication, before the
    // new target is written. Recovery must restore all three planned steps.
    for index in 0..2 {
        fs::write(&fixture.writes[index].path, &fixture.post_bytes[index]).unwrap();
    }

    assert_eq!(recover_pending_relation_schemas(&fixture.vault).unwrap(), 1);
    for (index, write) in fixture.writes.iter().enumerate() {
        assert_eq!(fs::read(&write.path).unwrap(), fixture.pre_bytes[index]);
    }
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn schema_recovery_rolls_back_first_manifest_write_and_is_idempotent() {
    let fixture = schema_recovery_fixture();
    publish_fixture(&fixture);
    rewrite_journal(&fixture, mark_pending);
    rewrite_journal(&fixture, |value| {
        value["futureMetadata"] = json!({"keep": true});
        value["steps"][0]["futureStepMetadata"] = json!("keep");
    });
    fs::write(&fixture.source_path, &fixture.source_post).unwrap();
    fs::write(&fixture.target_path, &fixture.target_pre).unwrap();

    assert_eq!(recover_pending_relation_schemas(&fixture.vault).unwrap(), 1);
    let recovered: Value =
        serde_json::from_slice(&fs::read(journal_path(&fixture)).unwrap()).unwrap();
    assert_eq!(recovered["futureMetadata"], json!({"keep": true}));
    assert_eq!(recovered["steps"][0]["futureStepMetadata"], json!("keep"));
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_pre);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_pre);
    assert_eq!(recover_pending_relation_schemas(&fixture.vault).unwrap(), 0);
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_pre);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_pre);
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn schema_recovery_rejects_external_edit_before_restoring_any_manifest() {
    let fixture = schema_recovery_fixture();
    publish_fixture(&fixture);
    rewrite_journal(&fixture, mark_pending);
    fs::write(&fixture.source_path, &fixture.source_post).unwrap();
    fs::write(&fixture.target_path, b"external target\n").unwrap();
    let journal_before = fs::read(journal_path(&fixture)).unwrap();

    assert!(recover_pending_relation_schemas(&fixture.vault).is_err());
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_post);
    assert_eq!(
        fs::read(&fixture.target_path).unwrap(),
        b"external target\n"
    );
    assert_eq!(fs::read(journal_path(&fixture)).unwrap(), journal_before);
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn completed_schema_replay_returns_persisted_result_without_manifest_reads() {
    let fixture = schema_recovery_fixture();
    publish_fixture(&fixture);
    rewrite_journal(&fixture, mark_completed);
    fs::remove_file(&fixture.source_path).unwrap();
    fs::remove_file(&fixture.target_path).unwrap();

    let replayed = replay(&fixture.vault, &fixture.request).unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(replayed).unwrap(),
        serde_json::to_value(&fixture.result).unwrap()
    );
    let mut mismatch = fixture.request.clone();
    mismatch.name = "Different".to_owned();
    assert!(replay(&fixture.vault, &mismatch).is_err());
    assert!(!fixture.source_path.exists());
    assert!(!fixture.target_path.exists());
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn schema_recovery_activation_restores_manifests_and_is_idempotent() {
    let fixture = schema_recovery_fixture();
    publish_fixture(&fixture);
    rewrite_journal(&fixture, mark_pending);
    fs::write(&fixture.source_path, &fixture.source_post).unwrap();
    fs::write(&fixture.target_path, &fixture.target_pre).unwrap();

    VaultContext::prepare_activation(fixture.vault.to_str().unwrap()).unwrap();
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_pre);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_pre);
    VaultContext::prepare_activation(fixture.vault.to_str().unwrap()).unwrap();
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_pre);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_pre);
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn schema_recovery_journal_metadata_cas_blocks_progress_after_external_edit() {
    let fixture = schema_recovery_fixture();
    let mut journal = prepare_journal(
        &fixture.vault,
        &fixture.request,
        &fixture.writes,
        &fixture.result,
    )
    .unwrap();
    rewrite_journal(&fixture, |value| {
        value["externalMetadata"] = json!({"keep": true});
    });
    assert!(journal.applied(0).is_err());
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_pre);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_pre);
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn schema_publish_error_rolls_back_written_source_and_records_rolled_back_outcome() {
    let fixture = schema_recovery_fixture();
    let watcher = WatcherState::new();
    let journal = prepare_journal(
        &fixture.vault,
        &fixture.request,
        &fixture.writes,
        &fixture.result,
    )
    .unwrap();
    let prepared = watcher.prepare_write(fixture.writes.iter().map(|write| {
        (
            write.path.clone(),
            crate::watcher::fingerprint_for_bytes(&write.post_bytes),
        )
    }));
    fs::write(&fixture.source_path, &fixture.source_post).unwrap();

    assert!(publish_error(
        journal,
        &fixture.writes,
        &[0],
        &watcher,
        &prepared,
        "injected source failure".to_owned(),
    )
    .is_err());
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_pre);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_pre);
    let journal: Value =
        serde_json::from_slice(&fs::read(journal_path(&fixture)).unwrap()).unwrap();
    assert_eq!(journal["status"], "rolledBack");
    assert!(journal["result"].is_null());
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn schema_publish_error_preserves_external_source_and_rolls_back_target() {
    let fixture = schema_recovery_fixture();
    let watcher = WatcherState::new();
    let journal = prepare_journal(
        &fixture.vault,
        &fixture.request,
        &fixture.writes,
        &fixture.result,
    )
    .unwrap();
    let prepared = watcher.prepare_write(fixture.writes.iter().map(|write| {
        (
            write.path.clone(),
            crate::watcher::fingerprint_for_bytes(&write.post_bytes),
        )
    }));
    let source_external = b"external source manifest".to_vec();
    fs::write(&fixture.source_path, &source_external).unwrap();
    fs::write(&fixture.target_path, &fixture.target_post).unwrap();

    let error = publish_error(
        journal,
        &fixture.writes,
        &[0, 1],
        &watcher,
        &prepared,
        "injected target failure".to_owned(),
    )
    .unwrap_err();
    assert!(
        error.contains("rollback incomplete"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(&fixture.source_path).unwrap(), source_external);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_pre);
    let journal: Value =
        serde_json::from_slice(&fs::read(journal_path(&fixture)).unwrap()).unwrap();
    assert_eq!(journal["status"], "inProgress");
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn schema_publish_error_refuses_all_rollback_after_journal_metadata_edit() {
    let fixture = schema_recovery_fixture();
    let watcher = WatcherState::new();
    let journal = prepare_journal(
        &fixture.vault,
        &fixture.request,
        &fixture.writes,
        &fixture.result,
    )
    .unwrap();
    let prepared = watcher.prepare_write(fixture.writes.iter().map(|write| {
        (
            write.path.clone(),
            crate::watcher::fingerprint_for_bytes(&write.post_bytes),
        )
    }));
    rewrite_journal(&fixture, |value| {
        value["externalMetadata"] = json!({"keep": true});
    });
    let journal_after_edit = fs::read(journal_path(&fixture)).unwrap();
    fs::write(&fixture.source_path, &fixture.source_post).unwrap();

    let error = publish_error(
        journal,
        &fixture.writes,
        &[0],
        &watcher,
        &prepared,
        "injected failure".to_owned(),
    )
    .unwrap_err();
    assert!(
        error.to_ascii_lowercase().contains("journal"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_post);
    assert_eq!(
        fs::read(journal_path(&fixture)).unwrap(),
        journal_after_edit
    );
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn schema_recovery_missing_manifest_blocks_restore_without_recreation() {
    let fixture = schema_recovery_fixture();
    publish_fixture(&fixture);
    rewrite_journal(&fixture, mark_pending);
    fs::write(&fixture.source_path, &fixture.source_post).unwrap();
    fs::write(&fixture.target_path, &fixture.target_post).unwrap();
    fs::remove_file(&fixture.target_path).unwrap();

    assert!(recover_pending_relation_schemas(&fixture.vault).is_err());
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_post);
    assert!(!fixture.target_path.exists());
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn schema_recovery_rejects_corrupt_backup_and_unknown_version_without_restore() {
    for mutation in ["backup", "version", "overlap", "traversal"] {
        let fixture = schema_recovery_fixture();
        publish_fixture(&fixture);
        rewrite_journal(&fixture, mark_pending);
        fs::write(&fixture.source_path, &fixture.source_post).unwrap();
        fs::write(&fixture.target_path, &fixture.target_post).unwrap();
        let source_before = fs::read(&fixture.source_path).unwrap();
        let target_before = fs::read(&fixture.target_path).unwrap();
        let journal_before = fs::read(journal_path(&fixture)).unwrap();
        match mutation {
            "backup" => fs::write(backup_path(&fixture, 0), b"corrupt").unwrap(),
            "version" => rewrite_journal(&fixture, |value| {
                value["formatVersion"] = json!(999);
            }),
            "overlap" => rewrite_journal(&fixture, |value| {
                value["steps"][1]["manifestPath"] = value["steps"][0]["manifestPath"].clone();
            }),
            "traversal" => rewrite_journal(&fixture, |value| {
                set_step_path(value, 0, "../outside.json");
            }),
            _ => unreachable!(),
        }
        assert!(recover_pending_relation_schemas(&fixture.vault).is_err());
        assert_eq!(fs::read(&fixture.source_path).unwrap(), source_before);
        assert_eq!(fs::read(&fixture.target_path).unwrap(), target_before);
        if mutation != "backup" {
            assert_ne!(fs::read(journal_path(&fixture)).unwrap(), journal_before);
        }
        let _ = fs::remove_dir_all(fixture.vault);
    }
}

#[cfg(unix)]
#[test]
fn schema_recovery_rejects_symlinked_manifest_path_before_restore() {
    let fixture = schema_recovery_fixture();
    publish_fixture(&fixture);
    rewrite_journal(&fixture, mark_pending);
    fs::write(&fixture.source_path, &fixture.source_post).unwrap();
    fs::write(&fixture.target_path, &fixture.target_post).unwrap();
    let copy = fixture.vault.join("source-copy.json");
    fs::write(&copy, &fixture.source_post).unwrap();
    fs::remove_file(&fixture.source_path).unwrap();
    std::os::unix::fs::symlink(&copy, &fixture.source_path).unwrap();

    let error = recover_pending_relation_schemas(&fixture.vault).unwrap_err();
    assert!(error.contains("Symlink"), "unexpected error: {error}");
    assert_eq!(fs::read(&fixture.source_path).unwrap(), fixture.source_post);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), fixture.target_post);
    let _ = fs::remove_dir_all(fixture.vault);
}
