use super::*;

#[test]
fn relation_stale_or_empty_revision_rejects_without_touching_source_or_inverse() {
    let fixture = relation_fixture();
    let original_revision = raw_revision(&fixture.source_bytes);
    let externally_changed_source = format!(
        "---\namby-id: {}\n---\nExternal source\n",
        fixture.source_note_id
    )
    .into_bytes();
    fs::write(&fixture.source_note_path, &externally_changed_source).unwrap();

    let stale = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(
            &fixture,
            original_revision,
            vec![fixture.target_note_id.clone()],
        ),
        None,
    );
    assert!(stale.is_err(), "stale source revision must be rejected");
    assert_eq!(
        fs::read(&fixture.source_note_path).unwrap(),
        externally_changed_source
    );
    assert_eq!(
        fs::read(&fixture.target_note_path).unwrap(),
        fixture.target_bytes
    );

    let empty = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(
            &fixture,
            String::new(),
            vec![fixture.target_note_id.clone()],
        ),
        None,
    );
    assert!(empty.is_err(), "empty source revision must be rejected");
    assert_eq!(
        fs::read(&fixture.source_note_path).unwrap(),
        externally_changed_source
    );
    assert_eq!(
        fs::read(&fixture.target_note_path).unwrap(),
        fixture.target_bytes
    );
    assert_eq!(
        fs::read(&fixture.target_manifest_path).unwrap(),
        fixture.target_manifest_bytes
    );
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_link_and_unlink_return_revisions_for_actual_post_write_bytes() {
    let fixture = relation_fixture();
    let linked = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(
            &fixture,
            raw_revision(&fixture.source_bytes),
            vec![fixture.target_note_id.clone()],
        ),
        None,
    )
    .unwrap();
    assert_relation_revisions(&linked, &fixture);

    let source_after_link = fs::read(&fixture.source_note_path).unwrap();
    let unlinked = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(&fixture, raw_revision(&source_after_link), Vec::new()),
        None,
    )
    .unwrap();
    assert_relation_revisions(&unlinked, &fixture);
    let source_after_unlink = fs::read_to_string(&fixture.source_note_path).unwrap();
    let source_mapping = frontmatter::frontmatter_yaml_mapping(&source_after_unlink)
        .unwrap()
        .unwrap();
    assert!(!source_mapping.contains_key(serde_yaml::Value::String("Related".to_owned())));
    assert!(source_after_unlink.contains(&fixture.source_note_id));
    assert!(source_after_unlink.contains("# Source\n"));
    let target_after_unlink = fs::read_to_string(&fixture.target_note_path).unwrap();
    let target_mapping = frontmatter::frontmatter_yaml_mapping(&target_after_unlink)
        .unwrap()
        .unwrap();
    assert!(!target_mapping.contains_key(serde_yaml::Value::String("Sources".to_owned())));
    assert!(target_after_unlink.contains(&fixture.target_note_id));
    assert!(target_after_unlink.contains("# Target\n"));
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_preflight_conflict_preserves_target_and_schema_without_writes() {
    let fixture = relation_fixture();
    let target_path = fixture.target_note_path.clone();
    let target_manifest_path = fixture.target_manifest_path.clone();
    let target_external = b"---\namby-id: target-external\n---\nExternal target\n".to_vec();
    let manifest_external = {
        let mut bytes = fixture.target_manifest_bytes.clone();
        bytes.push(b'\n');
        bytes
    };
    let target_external_for_hook = target_external.clone();
    let manifest_external_for_hook = manifest_external.clone();
    super::set_relation_before_publish_hook(Box::new(move || {
        fs::write(&target_path, &target_external_for_hook).unwrap();
        fs::write(&target_manifest_path, &manifest_external_for_hook).unwrap();
    }));

    let result = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(
            &fixture,
            raw_revision(&fixture.source_bytes),
            vec![fixture.target_note_id.clone()],
        ),
        None,
    );
    assert!(
        result.is_err(),
        "preflight must reject changed target/schema bytes"
    );
    assert_eq!(
        fs::read(&fixture.source_note_path).unwrap(),
        fixture.source_bytes
    );
    assert_eq!(
        fs::read(&fixture.target_note_path).unwrap(),
        target_external
    );
    assert_eq!(
        fs::read(&fixture.target_manifest_path).unwrap(),
        manifest_external
    );
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_source_manifest_conflict_before_publish_preserves_both_notes() {
    let fixture = relation_fixture();
    let source_manifest_path = fixture.source_manifest_path.clone();
    let mut external_manifest = fixture.source_manifest_bytes.clone();
    external_manifest.push(b'\n');
    let external_manifest_for_hook = external_manifest.clone();
    super::set_relation_before_publish_hook(Box::new(move || {
        fs::write(&source_manifest_path, &external_manifest_for_hook).unwrap();
    }));

    let result = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(
            &fixture,
            raw_revision(&fixture.source_bytes),
            vec![fixture.target_note_id.clone()],
        ),
        None,
    );
    assert!(
        result.is_err(),
        "a changed source manifest must abort relation publication"
    );
    assert_eq!(
        fs::read(&fixture.source_note_path).unwrap(),
        fixture.source_bytes
    );
    assert_eq!(
        fs::read(&fixture.target_note_path).unwrap(),
        fixture.target_bytes
    );
    assert_eq!(
        fs::read(&fixture.source_manifest_path).unwrap(),
        external_manifest
    );
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_target_conflict_after_source_write_rolls_back_only_unchanged_source() {
    let fixture = relation_fixture();
    let target_path = fixture.target_note_path.clone();
    let target_external = b"---\namby-id: target-external\n---\nExternal target\n".to_vec();
    let target_external_for_hook = target_external.clone();
    super::set_relation_before_write_hook(Box::new(move |index| {
        if index == 1 {
            fs::write(&target_path, &target_external_for_hook).unwrap();
        }
    }));

    let result = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(
            &fixture,
            raw_revision(&fixture.source_bytes),
            vec![fixture.target_note_id.clone()],
        ),
        None,
    );
    assert!(
        result.is_err(),
        "target conflict must fail the relation write"
    );
    assert_eq!(
        fs::read(&fixture.source_note_path).unwrap(),
        fixture.source_bytes
    );
    assert_eq!(
        fs::read(&fixture.target_note_path).unwrap(),
        target_external
    );
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_unlink_invalid_utf8_inverse_fails_without_source_write() {
    let fixture = relation_fixture();
    update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(
            &fixture,
            raw_revision(&fixture.source_bytes),
            vec![fixture.target_note_id.clone()],
        ),
        None,
    )
    .unwrap();
    let source_linked = fs::read(&fixture.source_note_path).unwrap();
    let mut invalid_target = format!(
        "---\namby-id: {}\n---\nInvalid target body: ",
        fixture.target_note_id
    )
    .into_bytes();
    invalid_target.push(0xff);
    fs::write(&fixture.target_note_path, &invalid_target).unwrap();

    let result = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(&fixture, raw_revision(&source_linked), Vec::new()),
        None,
    );
    assert!(
        result.is_err(),
        "invalid UTF-8 in the previous inverse target must abort unlink"
    );
    assert_eq!(fs::read(&fixture.source_note_path).unwrap(), source_linked);
    assert_eq!(fs::read(&fixture.target_note_path).unwrap(), invalid_target);
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_unlink_malformed_inverse_value_fails_without_source_write() {
    let fixture = relation_fixture();
    update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(
            &fixture,
            raw_revision(&fixture.source_bytes),
            vec![fixture.target_note_id.clone()],
        ),
        None,
    )
    .unwrap();
    let source_linked = fs::read(&fixture.source_note_path).unwrap();
    let malformed_target = format!(
        "---\namby-id: {}\nSources: [{}, {{foreign: value}}]\n---\n# Target\n",
        fixture.target_note_id, fixture.source_note_id
    )
    .into_bytes();
    fs::write(&fixture.target_note_path, &malformed_target).unwrap();

    let result = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(&fixture, raw_revision(&source_linked), Vec::new()),
        None,
    );
    assert!(
        result.is_err(),
        "non-string inverse relation elements must abort unlink"
    );
    assert_eq!(fs::read(&fixture.source_note_path).unwrap(), source_linked);
    assert_eq!(
        fs::read(&fixture.target_note_path).unwrap(),
        malformed_target
    );
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_unlink_invalid_stored_target_ids_fail_without_writes() {
    let invalid_values = [
        "\"\"".to_owned(),
        "\"unknown\"".to_owned(),
        "\"[[VALID_ID\"".to_owned(),
        "\"[[[[VALID_ID]]]]\"".to_owned(),
    ];
    for invalid_value in invalid_values
        .into_iter()
        .chain(std::iter::once(String::new()))
    {
        let fixture = relation_fixture();
        let stored_value = if invalid_value.is_empty() {
            format!("\"{}\"", fixture.target_note_id.to_ascii_lowercase())
        } else {
            invalid_value.replace("VALID_ID", &fixture.target_note_id)
        };
        let source_with_invalid_target = format!(
            "---\namby-id: {}\nRelated: {}\n---\n# Source\n",
            fixture.source_note_id, stored_value
        )
        .into_bytes();
        fs::write(&fixture.source_note_path, &source_with_invalid_target).unwrap();
        let target_before = fs::read(&fixture.target_note_path).unwrap();

        let result = update_database_relation_value(
            &fixture.vault,
            &fixture.watcher,
            &relation_request(
                &fixture,
                raw_revision(&source_with_invalid_target),
                Vec::new(),
            ),
            None,
        );
        assert!(
            result.is_err(),
            "stored relation value {stored_value:?} must be rejected"
        );
        assert_eq!(
            fs::read(&fixture.source_note_path).unwrap(),
            source_with_invalid_target
        );
        assert_eq!(fs::read(&fixture.target_note_path).unwrap(), target_before);
        let _ = fs::remove_dir_all(fixture.vault);
    }
}

#[test]
fn relation_unlink_quoted_padded_wikilink_target_is_normalized() {
    let fixture = relation_fixture();
    let source_with_wikilink = format!(
        "---\namby-id: {}\nRelated: \" [[ {} ]] \"\n---\n# Source\n",
        fixture.source_note_id, fixture.target_note_id
    )
    .into_bytes();
    let target_with_inverse = format!(
        "---\namby-id: {}\nSources: [{}]\n---\n# Target\n",
        fixture.target_note_id, fixture.source_note_id
    )
    .into_bytes();
    fs::write(&fixture.source_note_path, &source_with_wikilink).unwrap();
    fs::write(&fixture.target_note_path, &target_with_inverse).unwrap();

    let result = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(&fixture, raw_revision(&source_with_wikilink), Vec::new()),
        None,
    )
    .unwrap();
    assert!(result.warnings.is_empty());
    let source_after = fs::read_to_string(&fixture.source_note_path).unwrap();
    let target_after = fs::read_to_string(&fixture.target_note_path).unwrap();
    assert!(!source_after.contains("Related:"));
    assert!(!target_after.contains("Sources:"));
    assert!(source_after.contains(&fixture.source_note_id));
    assert!(target_after.contains(&fixture.target_note_id));
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_update_invalid_input_target_id_rejects_without_writes() {
    let fixture = relation_fixture();
    let source_before = fs::read(&fixture.source_note_path).unwrap();
    let target_before = fs::read(&fixture.target_note_path).unwrap();
    let result = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(
            &fixture,
            raw_revision(&source_before),
            vec!["not-a-canonical-ulid".to_owned()],
        ),
        None,
    );
    assert!(result.is_err(), "invalid input target ID must be rejected");
    assert_eq!(fs::read(&fixture.source_note_path).unwrap(), source_before);
    assert_eq!(fs::read(&fixture.target_note_path).unwrap(), target_before);
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_unlink_missing_inverse_target_succeeds_with_warning() {
    let fixture = relation_fixture();
    let linked = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(
            &fixture,
            raw_revision(&fixture.source_bytes),
            vec![fixture.target_note_id.clone()],
        ),
        None,
    )
    .unwrap();
    let source_linked = fs::read(&fixture.source_note_path).unwrap();
    fs::remove_file(&fixture.target_note_path).unwrap();

    let result = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(&fixture, raw_revision(&source_linked), Vec::new()),
        None,
    )
    .unwrap();
    assert!(
        !result.warnings.is_empty(),
        "missing inverse target must be reported as a warning"
    );
    let source_after_unlink = fs::read_to_string(&fixture.source_note_path).unwrap();
    let source_mapping = frontmatter::frontmatter_yaml_mapping(&source_after_unlink)
        .unwrap()
        .unwrap();
    assert!(!source_mapping.contains_key(serde_yaml::Value::String("Related".to_owned())));
    assert!(source_after_unlink.contains(&fixture.source_note_id));
    assert!(source_after_unlink.contains("# Source\n"));
    assert!(!fixture.target_note_path.exists());
    assert_eq!(result.revisions.len(), 1);
    assert_eq!(result.revisions[0].note_id, fixture.source_note_id);
    assert_eq!(
        result.revisions[0].revision,
        raw_revision(&fs::read(&fixture.source_note_path).unwrap())
    );
    assert!(linked
        .revisions
        .iter()
        .any(|revision| revision.note_id == fixture.target_note_id));
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_unlink_duplicate_previous_targets_plans_inverse_once() {
    let fixture = relation_fixture();
    let source_with_duplicates = format!(
        "---\namby-id: {}\nRelated: [{}, {}]\n---\n# Source\n",
        fixture.source_note_id, fixture.target_note_id, fixture.target_note_id
    )
    .into_bytes();
    let target_with_inverse = format!(
        "---\namby-id: {}\nSources: [{}]\n---\n# Target\n",
        fixture.target_note_id, fixture.source_note_id
    )
    .into_bytes();
    fs::write(&fixture.source_note_path, &source_with_duplicates).unwrap();
    fs::write(&fixture.target_note_path, &target_with_inverse).unwrap();

    let result = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(&fixture, raw_revision(&source_with_duplicates), Vec::new()),
        None,
    )
    .unwrap();
    assert_eq!(result.revisions.len(), 2);
    assert_eq!(
        result
            .revisions
            .iter()
            .filter(|revision| revision.note_id == fixture.target_note_id)
            .count(),
        1
    );
    let source_after_unlink = fs::read_to_string(&fixture.source_note_path).unwrap();
    let source_mapping = frontmatter::frontmatter_yaml_mapping(&source_after_unlink)
        .unwrap()
        .unwrap();
    assert!(!source_mapping.contains_key(serde_yaml::Value::String("Related".to_owned())));
    assert!(source_after_unlink.contains(&fixture.source_note_id));
    assert!(source_after_unlink.contains("# Source\n"));
    let target_after_unlink = fs::read_to_string(&fixture.target_note_path).unwrap();
    let target_mapping = frontmatter::frontmatter_yaml_mapping(&target_after_unlink)
        .unwrap()
        .unwrap();
    assert!(!target_mapping.contains_key(serde_yaml::Value::String("Sources".to_owned())));
    assert!(target_after_unlink.contains(&fixture.target_note_id));
    assert!(target_after_unlink.contains("# Target\n"));
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_rollback_does_not_overwrite_external_source_edit() {
    let fixture = relation_fixture();
    let source_path = fixture.source_note_path.clone();
    let target_path = fixture.target_note_path.clone();
    let source_external = b"---\namby-id: source-external\n---\nExternal source\n".to_vec();
    let target_external = b"---\namby-id: target-external\n---\nExternal target\n".to_vec();
    let source_external_for_hook = source_external.clone();
    let target_external_for_hook = target_external.clone();
    super::set_relation_before_write_hook(Box::new(move |index| {
        if index == 1 {
            fs::write(&source_path, &source_external_for_hook).unwrap();
            fs::write(&target_path, &target_external_for_hook).unwrap();
        }
    }));

    let result = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(
            &fixture,
            raw_revision(&fixture.source_bytes),
            vec![fixture.target_note_id.clone()],
        ),
        None,
    );
    assert!(
        result.is_err(),
        "target conflict must fail the relation write"
    );
    assert_eq!(
        fs::read(&fixture.source_note_path).unwrap(),
        source_external
    );
    assert_eq!(
        fs::read(&fixture.target_note_path).unwrap(),
        target_external
    );
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_same_operation_id_replays_completed_result_without_writing_history_again() {
    let fixture = relation_fixture();
    let request = relation_request(
        &fixture,
        raw_revision(&fixture.source_bytes),
        vec![fixture.target_note_id.clone()],
    );
    let history = DatabaseHistoryState::default();
    let first =
        update_database_relation_value(&fixture.vault, &fixture.watcher, &request, Some(&history))
            .unwrap();
    let source_after = fs::read(&fixture.source_note_path).unwrap();
    let target_after = fs::read(&fixture.target_note_path).unwrap();
    let status_after_first = history.status(&fixture.source_database_id);

    let replay =
        update_database_relation_value(&fixture.vault, &fixture.watcher, &request, Some(&history))
            .unwrap();
    assert_eq!(replay, first);
    assert_eq!(fs::read(&fixture.source_note_path).unwrap(), source_after);
    assert_eq!(fs::read(&fixture.target_note_path).unwrap(), target_after);
    let status_after_replay = history.status(&fixture.source_database_id);
    assert_eq!(status_after_replay.can_undo, status_after_first.can_undo);
    assert_eq!(status_after_replay.can_redo, status_after_first.can_redo);

    history
        .undo(
            &fixture.vault,
            &fixture.watcher,
            &fixture.source_database_id,
        )
        .unwrap();
    assert!(history
        .undo(
            &fixture.vault,
            &fixture.watcher,
            &fixture.source_database_id
        )
        .is_err());
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_same_operation_id_rejects_different_payload_without_writes() {
    let fixture = relation_fixture();
    let request = relation_request(
        &fixture,
        raw_revision(&fixture.source_bytes),
        vec![fixture.target_note_id.clone()],
    );
    update_database_relation_value(&fixture.vault, &fixture.watcher, &request, None).unwrap();
    let source_after = fs::read(&fixture.source_note_path).unwrap();
    let target_after = fs::read(&fixture.target_note_path).unwrap();
    let journal_path = fixture
        .vault
        .join(".amby/recovery/database_relations")
        .join(format!("{}.json", request.operation_id));
    let journal_before = fs::read(&journal_path).unwrap();

    let mut mismatch = request.clone();
    mismatch.target_note_ids.clear();
    assert!(
        update_database_relation_value(&fixture.vault, &fixture.watcher, &mismatch, None).is_err()
    );
    assert_eq!(fs::read(&fixture.source_note_path).unwrap(), source_after);
    assert_eq!(fs::read(&fixture.target_note_path).unwrap(), target_after);
    assert_eq!(fs::read(journal_path).unwrap(), journal_before);
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn relation_rolled_back_operation_id_cannot_be_reused() {
    let fixture = relation_fixture();
    let request = relation_request(
        &fixture,
        raw_revision(&fixture.source_bytes),
        vec![fixture.target_note_id.clone()],
    );
    let target_path = fixture.target_note_path.clone();
    let external_target = b"---\namby-id: external-target\n---\nExternal target\n".to_vec();
    let external_target_for_hook = external_target.clone();
    super::set_relation_before_write_hook(Box::new(move |index| {
        if index == 1 {
            fs::write(&target_path, &external_target_for_hook).unwrap();
        }
    }));

    assert!(
        update_database_relation_value(&fixture.vault, &fixture.watcher, &request, None).is_err()
    );
    assert_eq!(
        fs::read(&fixture.source_note_path).unwrap(),
        fixture.source_bytes
    );
    assert_eq!(
        fs::read(&fixture.target_note_path).unwrap(),
        external_target
    );
    assert!(
        update_database_relation_value(&fixture.vault, &fixture.watcher, &request, None).is_err(),
        "rolled-back operation IDs must not be reused"
    );
    assert_eq!(
        fs::read(&fixture.source_note_path).unwrap(),
        fixture.source_bytes
    );
    assert_eq!(
        fs::read(&fixture.target_note_path).unwrap(),
        external_target
    );
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn vault_activation_recovers_pending_relation_before_projection() {
    let fixture = relation_fixture();
    let request = relation_request(
        &fixture,
        raw_revision(&fixture.source_bytes),
        vec![fixture.target_note_id.clone()],
    );
    update_database_relation_value(&fixture.vault, &fixture.watcher, &request, None).unwrap();
    let mut journal: serde_json::Value = serde_json::from_slice(
        &fs::read(
            fixture
                .vault
                .join(".amby/recovery/database_relations")
                .join(format!("{}.json", request.operation_id)),
        )
        .unwrap(),
    )
    .unwrap();
    journal["status"] = json!("inProgress");
    let journal_path = fixture
        .vault
        .join(".amby/recovery/database_relations")
        .join(format!("{}.json", request.operation_id));
    fs::write(&journal_path, serde_json::to_vec_pretty(&journal).unwrap()).unwrap();

    let prepared = VaultContext::prepare_activation(fixture.vault.to_str().unwrap());
    assert!(
        prepared.is_ok(),
        "pending relation should recover before activation"
    );
    drop(prepared);
    assert_eq!(
        fs::read(&fixture.source_note_path).unwrap(),
        fixture.source_bytes
    );
    assert_eq!(
        fs::read(&fixture.target_note_path).unwrap(),
        fixture.target_bytes
    );
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn vault_activation_refuses_late_external_target_without_restoring_notes() {
    let fixture = relation_fixture();
    let request = relation_request(
        &fixture,
        raw_revision(&fixture.source_bytes),
        vec![fixture.target_note_id.clone()],
    );
    update_database_relation_value(&fixture.vault, &fixture.watcher, &request, None).unwrap();
    let source_post = fs::read(&fixture.source_note_path).unwrap();
    let external_target = b"---\namby-id: external-target\n---\nExternal target\n".to_vec();
    fs::write(&fixture.target_note_path, &external_target).unwrap();
    let journal_path = fixture
        .vault
        .join(".amby/recovery/database_relations")
        .join(format!("{}.json", request.operation_id));
    let mut journal: serde_json::Value =
        serde_json::from_slice(&fs::read(&journal_path).unwrap()).unwrap();
    journal["status"] = json!("inProgress");
    fs::write(&journal_path, serde_json::to_vec_pretty(&journal).unwrap()).unwrap();
    let journal_before_activation = fs::read(&journal_path).unwrap();

    let prepared = VaultContext::prepare_activation(fixture.vault.to_str().unwrap());
    assert!(
        prepared.is_err(),
        "activation must stop before projection when a pending target changed"
    );
    assert_eq!(fs::read(&fixture.source_note_path).unwrap(), source_post);
    assert_eq!(
        fs::read(&fixture.target_note_path).unwrap(),
        external_target
    );
    assert_eq!(fs::read(&journal_path).unwrap(), journal_before_activation);
    let _ = fs::remove_dir_all(fixture.vault);
}
