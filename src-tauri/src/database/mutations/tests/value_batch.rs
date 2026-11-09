use super::*;

#[test]
fn value_batch_validates_every_cell_before_publishing_any_record() {
    let vault = temp_vault();
    let created = create_database(
        &vault,
        &WatcherState::new(),
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "Projects".to_owned(),
        },
    )
    .unwrap();
    let property_id = ulid::Ulid::generate().to_string();
    let note_id = ulid::Ulid::generate().to_string();
    let manifest_path = Path::new(&created.manifest_path);
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    manifest["properties"] = json!([{
        "id": property_id.clone(),
        "name": "Status",
        "type": "text",
        "pageVisibility": "alwaysShow",
        "yamlBinding": null,
        "config": {"multiline": false}
    }]);
    fs::write(manifest_path, json_bytes(&manifest).unwrap()).unwrap();
    let record_path = vault
        .join("Projects/.ambd/records")
        .join(format!("{note_id}.json"));
    fs::create_dir_all(record_path.parent().unwrap()).unwrap();
    let original = json_bytes(&json!({
        "format": "amby-database-record",
        "formatVersion": 1,
        "databaseId": created.database_id.clone(),
        "noteId": note_id.clone(),
        "values": {}
    }))
    .unwrap();
    fs::write(&record_path, &original).unwrap();
    let result = apply_value_batch(
        &vault,
        &WatcherState::new(),
        &DatabaseValueBatchRequest {
            expected_generation: 1,
            database_id: created.database_id,
            operation_id: ulid::Ulid::generate().to_string(),
            cells: vec![
                DatabaseValueMutation {
                    note_id: note_id.clone(),
                    property_id,
                    value_json: Some(r#"{"kind":"text","value":"done"}"#.to_owned()),
                    expected_revision: raw_revision(&original),
                },
                DatabaseValueMutation {
                    note_id,
                    property_id: ulid::Ulid::generate().to_string(),
                    value_json: None,
                    expected_revision: raw_revision(&original),
                },
            ],
        },
        None,
    );
    assert!(result.is_err());
    assert_eq!(fs::read(record_path).unwrap(), original);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn value_batch_writes_a_durable_completed_journal_and_replays_idempotently() {
    let vault = temp_vault();
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
    let row = crate::database::rows::create_database_row(
        &vault,
        &watcher,
        &crate::database::rows::CreateDatabaseRowRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            title: "First".to_owned(),
            template: crate::database::rows::DatabaseRowTemplate::Default,
        },
    )
    .unwrap();
    let manifest_path =
        crate::database::discovery::manifest_path_for_container(&vault.join("Projects"));
    let mut locked_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    locked_manifest["locked"] = serde_json::Value::Bool(true);
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&locked_manifest).unwrap(),
    )
    .unwrap();
    let request = DatabaseValueBatchRequest {
        expected_generation: 1,
        database_id: created.database_id,
        operation_id: format!("test-{}", ulid::Ulid::generate()),
        cells: vec![DatabaseValueMutation {
            note_id: row.note_id,
            property_id: property.property_id,
            value_json: Some(r#"{"type":"text","value":"done"}"#.to_owned()),
            expected_revision: row.record_revision,
        }],
    };
    let first = apply_value_batch(&vault, &watcher, &request, None).unwrap();
    let replay = apply_value_batch(&vault, &watcher, &request, None).unwrap();
    assert_eq!(first, replay);
    let note_content = fs::read_to_string(&row.note_path).unwrap();
    assert!(note_content.contains("done"));
    assert!(!vault.join("Projects/.ambd/records").exists());
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn recovery_rollback_restores_only_the_exact_batch_revision() {
    let container = temp_vault();
    let note_id = ulid::Ulid::generate().to_string();
    let operation_id = format!("test-{}", ulid::Ulid::generate());
    let record_path = container
        .join(".ambd/records")
        .join(format!("{note_id}.json"));
    let backup_path = container
        .join(".ambd/recovery")
        .join(&operation_id)
        .join(format!("{note_id}.json"));
    let journal_path = container
        .join(".ambd/recovery")
        .join(format!("{operation_id}.json"));
    fs::create_dir_all(record_path.parent().unwrap()).unwrap();
    fs::create_dir_all(backup_path.parent().unwrap()).unwrap();
    let original = br#"{"values":{}}"#;
    let target = br#"{"values":{"changed":true}}"#;
    fs::write(&record_path, target).unwrap();
    fs::write(&backup_path, original).unwrap();
    let journal = BatchRecoveryJournal {
        format: "amby-database-recovery".to_owned(),
        format_version: 1,
        operation_id: operation_id.clone(),
        database_id: ulid::Ulid::generate().to_string(),
        request_revision: "request".to_owned(),
        status: "inProgress".to_owned(),
        steps: vec![BatchRecoveryStep {
            record_path: format!(".ambd/records/{note_id}.json"),
            backup_path: format!(".ambd/recovery/{operation_id}/{note_id}.json"),
            original_revision: raw_revision(original),
            target_revision: raw_revision(target),
            status: "written".to_owned(),
        }],
        result: None,
    };
    write_new(&journal_path, &journal_bytes(&journal).unwrap()).unwrap();
    rollback_batch_journal(&container, &journal_path, journal).unwrap();
    assert_eq!(fs::read(record_path).unwrap(), original);
    assert_eq!(
        read_batch_journal(&journal_path).unwrap().status,
        "rolledBack"
    );
    let _ = fs::remove_dir_all(container);
}

#[test]
fn recovery_rejects_paths_not_derived_from_the_operation_and_note_ids() {
    let container = temp_vault();
    let step = BatchRecoveryStep {
        record_path: ".ambd/records/../../outside.json".to_owned(),
        backup_path: ".ambd/recovery/safe/../../outside.json".to_owned(),
        original_revision: "original".to_owned(),
        target_revision: "target".to_owned(),
        status: "written".to_owned(),
    };
    assert!(recovery_step_paths(&container, "safe", &step).is_err());
    let _ = fs::remove_dir_all(container);
}

#[test]
fn test_recover_pending_batches_restores_interrupted_batch_on_startup() {
    let vault = temp_vault();
    let note_path = vault.join("Task.md");
    let original = b"---\nid: 01HZY1234567890ABCDEFGH001\nStatus: Todo\n---\nInitial body";
    let target = b"---\nid: 01HZY1234567890ABCDEFGH001\nStatus: Done\n---\nInitial body";

    // Note was written with target content before process crashed
    fs::write(&note_path, target).unwrap();

    let op_id = "test-crash-op-1";
    let recovery_batches_dir = vault
        .join(".amby")
        .join("recovery")
        .join("database_batches");
    let op_backup_dir = recovery_batches_dir.join(op_id);
    fs::create_dir_all(&op_backup_dir).unwrap();

    let backup_file = op_backup_dir.join("01HZY1234567890ABCDEFGH001.md");
    fs::write(&backup_file, original).unwrap();

    let journal_path = recovery_batches_dir.join(format!("{op_id}.json"));
    let journal = BatchRecoveryJournal {
        format: "amby-database-recovery".to_owned(),
        format_version: 1,
        operation_id: op_id.to_owned(),
        database_id: ulid::Ulid::generate().to_string(),
        request_revision: "test-rev".to_owned(),
        status: "inProgress".to_owned(),
        steps: vec![BatchRecoveryStep {
            record_path: "Task.md".to_owned(),
            backup_path: format!(
                ".amby/recovery/database_batches/{op_id}/01HZY1234567890ABCDEFGH001.md"
            ),
            original_revision: raw_revision(original),
            target_revision: raw_revision(target),
            status: "planned".to_owned(),
        }],
        result: None,
    };
    fs::write(&journal_path, journal_bytes(&journal).unwrap()).unwrap();

    // Run recovery as would occur during vault activation
    let recovered = recover_pending_batches(&vault).unwrap().recovered;
    assert_eq!(recovered, 1);

    // Note content must be restored back to original
    assert_eq!(fs::read(&note_path).unwrap(), original);

    // Journal must now be marked as rolledBack
    let updated_journal = read_batch_journal(&journal_path).unwrap();
    assert_eq!(updated_journal.status, "rolledBack");

    // Idempotent: subsequent recovery run finds 0 pending batches
    let second_run = recover_pending_batches(&vault).unwrap().recovered;
    assert_eq!(second_run, 0);

    let _ = fs::remove_dir_all(vault);
}

#[test]
fn recover_pending_batches_quarantines_unreadable_journals_without_locking_the_vault() {
    let vault = temp_vault();
    let batches = vault
        .join(".amby")
        .join("recovery")
        .join("database_batches");
    fs::create_dir_all(&batches).unwrap();

    // A pending batch that is valid and one whose journal is corrupt.
    let note_path = vault.join("Task.md");
    let original = b"---\nid: 01HZY1234567890ABCDEFGH001\nStatus: Todo\n---\nBody";
    let target = b"---\nid: 01HZY1234567890ABCDEFGH001\nStatus: Done\n---\nBody";
    fs::write(&note_path, target).unwrap();
    let op_id = "good-op";
    let backup_dir = batches.join(op_id);
    fs::create_dir_all(&backup_dir).unwrap();
    fs::write(backup_dir.join("01HZY1234567890ABCDEFGH001.md"), original).unwrap();
    let journal = BatchRecoveryJournal {
        format: "amby-database-recovery".to_owned(),
        format_version: 1,
        operation_id: op_id.to_owned(),
        database_id: ulid::Ulid::generate().to_string(),
        request_revision: "test-rev".to_owned(),
        status: "inProgress".to_owned(),
        steps: vec![BatchRecoveryStep {
            record_path: "Task.md".to_owned(),
            backup_path: format!(
                ".amby/recovery/database_batches/{op_id}/01HZY1234567890ABCDEFGH001.md"
            ),
            original_revision: raw_revision(original),
            target_revision: raw_revision(target),
            status: "planned".to_owned(),
        }],
        result: None,
    };
    fs::write(
        batches.join("good-op.json"),
        journal_bytes(&journal).unwrap(),
    )
    .unwrap();
    let corrupt = batches.join("bad-op.json");
    fs::write(&corrupt, b"{ not a journal").unwrap();

    let report = recover_pending_batches(&vault).unwrap();
    assert_eq!(report.recovered, 1);
    assert_eq!(report.quarantined.len(), 1, "{:?}", report.quarantined);
    assert!(report.quarantined[0].contains("bad-op.json"));
    // The valid journal is recovered; the corrupt one is moved, not deleted.
    assert_eq!(fs::read(&note_path).unwrap(), original);
    assert!(!corrupt.exists());
    assert_eq!(
        fs::read(batches.join("quarantine").join("bad-op.json")).unwrap(),
        b"{ not a journal"
    );
    // A second run is clean: the stuck journal no longer blocks anything.
    let again = recover_pending_batches(&vault).unwrap();
    assert!(again.quarantined.is_empty());

    let _ = fs::remove_dir_all(vault);
}

#[test]
fn recover_pending_batches_quarantines_a_journal_whose_note_changed_after_the_crash() {
    let vault = temp_vault();
    let batches = vault
        .join(".amby")
        .join("recovery")
        .join("database_batches");
    let note_path = vault.join("Task.md");
    let original = b"---\nid: 01HZY1234567890ABCDEFGH001\nStatus: Todo\n---\nBody";
    let target = b"---\nid: 01HZY1234567890ABCDEFGH001\nStatus: Done\n---\nBody";
    // The user edited the note after the crash: neither original nor target.
    let edited = b"---\nid: 01HZY1234567890ABCDEFGH001\nStatus: Mine\n---\nBody";
    fs::write(&note_path, edited).unwrap();
    let op_id = "changed-op";
    let backup_dir = batches.join(op_id);
    fs::create_dir_all(&backup_dir).unwrap();
    fs::write(backup_dir.join("01HZY1234567890ABCDEFGH001.md"), original).unwrap();
    let journal = BatchRecoveryJournal {
        format: "amby-database-recovery".to_owned(),
        format_version: 1,
        operation_id: op_id.to_owned(),
        database_id: ulid::Ulid::generate().to_string(),
        request_revision: "test-rev".to_owned(),
        status: "inProgress".to_owned(),
        steps: vec![BatchRecoveryStep {
            record_path: "Task.md".to_owned(),
            backup_path: format!(
                ".amby/recovery/database_batches/{op_id}/01HZY1234567890ABCDEFGH001.md"
            ),
            original_revision: raw_revision(original),
            target_revision: raw_revision(target),
            status: "planned".to_owned(),
        }],
        result: None,
    };
    fs::write(
        batches.join("changed-op.json"),
        journal_bytes(&journal).unwrap(),
    )
    .unwrap();

    let report = recover_pending_batches(&vault).unwrap();
    assert_eq!(report.recovered, 0);
    assert_eq!(report.quarantined.len(), 1);
    // The user's edit is never overwritten; journal and backup are preserved.
    assert_eq!(fs::read(&note_path).unwrap(), edited);
    let quarantine = batches.join("quarantine");
    assert!(quarantine.join("changed-op.json").is_file());
    assert_eq!(
        fs::read(
            quarantine
                .join("changed-op")
                .join("01HZY1234567890ABCDEFGH001.md")
        )
        .unwrap(),
        original
    );
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn batch_rollback_is_all_or_nothing_when_a_later_step_cannot_be_restored() {
    let vault = temp_vault();
    let batches = vault
        .join(".amby")
        .join("recovery")
        .join("database_batches");
    let op_id = "two-step-op";
    let backup_dir = batches.join(op_id);
    fs::create_dir_all(&backup_dir).unwrap();
    let mut steps = Vec::new();
    let mut expectations = Vec::new();
    for (index, name) in ["A.md", "B.md"].iter().enumerate() {
        let original = format!("---\nid: 01HZY1234567890ABCDEFGH00{index}\nS: Todo\n---\n{name}");
        let target = format!("---\nid: 01HZY1234567890ABCDEFGH00{index}\nS: Done\n---\n{name}");
        fs::write(backup_dir.join(format!("{index}.md")), &original).unwrap();
        // B was edited by the user after the crash; A still holds the target.
        let on_disk = if index == 1 {
            format!("---\nid: 01HZY1234567890ABCDEFGH00{index}\nS: Mine\n---\n{name}")
        } else {
            target.clone()
        };
        fs::write(vault.join(name), &on_disk).unwrap();
        expectations.push((vault.join(name), on_disk));
        steps.push(BatchRecoveryStep {
            record_path: (*name).to_owned(),
            backup_path: format!(".amby/recovery/database_batches/{op_id}/{index}.md"),
            original_revision: raw_revision(original.as_bytes()),
            target_revision: raw_revision(target.as_bytes()),
            status: "planned".to_owned(),
        });
    }
    let journal = BatchRecoveryJournal {
        format: "amby-database-recovery".to_owned(),
        format_version: 1,
        operation_id: op_id.to_owned(),
        database_id: ulid::Ulid::generate().to_string(),
        request_revision: "test-rev".to_owned(),
        status: "inProgress".to_owned(),
        steps,
        result: None,
    };
    fs::write(
        batches.join("two-step-op.json"),
        journal_bytes(&journal).unwrap(),
    )
    .unwrap();

    let report = recover_pending_batches(&vault).unwrap();
    assert_eq!(report.recovered, 0);
    assert_eq!(report.quarantined.len(), 1);
    // Neither note was touched: no half-reverted batch.
    for (path, bytes) in expectations {
        assert_eq!(fs::read(path).unwrap(), bytes.as_bytes());
    }
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn st04_batch_write_failure_rolls_back_first_file() {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(windows)]
    use std::os::windows::fs::OpenOptionsExt;

    let vault = temp_vault();
    let watcher = WatcherState::new();

    let db = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "Tasks".to_owned(),
        },
    )
    .unwrap();

    let prop = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            expected_manifest_revision: db.manifest_revision.clone(),
            database_id: db.database_id.clone(),
            name: "Status".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();

    let note1_id = ulid::Ulid::generate().to_string();
    let note1_path = vault.join("Tasks").join("Note1.md");
    let note1_orig = format!("---\namby-id: {note1_id}\nStatus: Old1\n---\n\nBody 1\n");
    fs::write(&note1_path, &note1_orig).unwrap();

    let note2_id = ulid::Ulid::generate().to_string();
    let sub_dir = vault.join("Tasks").join("locked_sub");
    fs::create_dir_all(&sub_dir).unwrap();
    let note2_path = sub_dir.join("Note2.md");
    let note2_orig = format!("---\namby-id: {note2_id}\nStatus: Old2\n---\n\nBody 2\n");
    fs::write(&note2_path, &note2_orig).unwrap();

    // Unix denies creation of the replacement file. Windows permits reads
    // but denies replacing an open file without FILE_SHARE_DELETE.
    #[cfg(unix)]
    let orig_perms = fs::metadata(&sub_dir).unwrap().permissions();
    #[cfg(unix)]
    fs::set_permissions(&sub_dir, fs::Permissions::from_mode(0o555)).unwrap();
    #[cfg(windows)]
    let locked_note = fs::OpenOptions::new()
        .read(true)
        .share_mode(1) // FILE_SHARE_READ
        .open(&note2_path)
        .unwrap();

    let batch_req = DatabaseValueBatchRequest {
        expected_generation: 1,
        database_id: db.database_id.clone(),
        operation_id: "op-test-rollback".to_owned(),
        cells: vec![
            DatabaseValueMutation {
                note_id: note1_id.clone(),
                property_id: prop.property_id.clone(),
                value_json: Some(
                    serde_json::to_string(&PropertyValue::Text {
                        value: "New1".to_owned(),
                        extra: Default::default(),
                    })
                    .unwrap(),
                ),
                expected_revision: String::new(),
            },
            DatabaseValueMutation {
                note_id: note2_id.clone(),
                property_id: prop.property_id.clone(),
                value_json: Some(
                    serde_json::to_string(&PropertyValue::Text {
                        value: "New2".to_owned(),
                        extra: Default::default(),
                    })
                    .unwrap(),
                ),
                expected_revision: String::new(),
            },
        ],
    };

    let result = apply_value_batch(&vault, &watcher, &batch_req, None);
    assert!(
        result.is_err(),
        "Batch write should fail because note2 cannot be written"
    );

    // Verify that note1 was rolled back to original bytes!
    let note1_after = fs::read_to_string(&note1_path).unwrap();
    assert_eq!(
        note1_after, note1_orig,
        "Note 1 must be rolled back to original content after batch failure"
    );
    assert_eq!(fs::read_to_string(&note2_path).unwrap(), note2_orig);

    // Restore permissions for cleanup
    #[cfg(unix)]
    fs::set_permissions(&sub_dir, orig_perms).unwrap();
    #[cfg(windows)]
    drop(locked_note);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn review_future_manifest_prevents_batch_write() {
    let vault = temp_vault();
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
    let row = crate::database::rows::create_database_row(
        &vault,
        &watcher,
        &crate::database::rows::CreateDatabaseRowRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            title: "First".to_owned(),
            template: crate::database::rows::DatabaseRowTemplate::Default,
        },
    )
    .unwrap();
    let manifest_path =
        crate::database::discovery::manifest_path_for_container(&vault.join("Projects"));
    let mut locked_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    locked_manifest["formatVersion"] = serde_json::json!(999);
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&locked_manifest).unwrap(),
    )
    .unwrap();
    let request = DatabaseValueBatchRequest {
        expected_generation: 1,
        database_id: created.database_id,
        operation_id: format!("test-{}", ulid::Ulid::generate()),
        cells: vec![DatabaseValueMutation {
            note_id: row.note_id,
            property_id: property.property_id,
            value_json: Some(r#"{"type":"text","value":"done"}"#.to_owned()),
            expected_revision: row.record_revision,
        }],
    };
    let before = fs::read(&row.note_path).unwrap();
    let result = apply_value_batch(&vault, &watcher, &request, None);
    assert_eq!(
        fs::read(&row.note_path).unwrap(),
        before,
        "future-format database was changed: {result:?}"
    );
    assert!(result.is_err());
    let _ = fs::remove_dir_all(vault);
}

/// Carrying the properties of a note into a database field with the name of its header key writes
/// nothing new: the value lives in the header of the note and nowhere else, and a value that already
/// matches leaves the note byte for byte as it was (the migration of a moved note's properties).
#[test]
fn migrating_header_values_into_fields_named_like_their_keys_changes_no_byte() {
    let vault = temp_vault();
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
    let note_id = ulid::Ulid::generate().to_string();
    let note_path = vault.join("Projects").join("Row.md");
    let original = format!("---\namby-id: {note_id}\nrating: 5\nstatus: draft\n---\nBody\n");
    fs::write(&note_path, &original).unwrap();

    let status = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision.clone(),
            name: "status".to_owned(),
            property_type: "select".to_owned(),
            options: vec!["Idea".to_owned(), "draft".to_owned()],
            ..Default::default()
        },
    )
    .unwrap();
    let rating = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: status.manifest_revision.clone(),
            name: "rating".to_owned(),
            property_type: "number".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let manifest = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    let option_id = manifest
        .value
        .properties
        .iter()
        .find(|p| p.id() == Some(status.property_id.as_str()))
        .and_then(|p| p.find_option_id("draft"))
        .unwrap()
        .to_owned();
    let revision = raw_revision(original.as_bytes());
    apply_value_batch(
        &vault,
        &watcher,
        &DatabaseValueBatchRequest {
            expected_generation: 1,
            database_id: created.database_id,
            operation_id: ulid::Ulid::generate().to_string(),
            cells: vec![
                DatabaseValueMutation {
                    note_id: note_id.clone(),
                    property_id: status.property_id,
                    value_json: Some(format!(r#"{{"type":"select","optionId":"{option_id}"}}"#)),
                    expected_revision: revision.clone(),
                },
                DatabaseValueMutation {
                    note_id,
                    property_id: rating.property_id,
                    value_json: Some(r#"{"type":"number","decimal":"5"}"#.to_owned()),
                    expected_revision: revision,
                },
            ],
        },
        None,
    )
    .unwrap();
    assert_eq!(fs::read_to_string(&note_path).unwrap(), original);
    let _ = fs::remove_dir_all(vault);
}
