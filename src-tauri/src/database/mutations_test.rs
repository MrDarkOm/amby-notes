use super::*;
use crate::database::history::DatabaseHistoryState;
use crate::vault_context::VaultContext;

fn temp_vault() -> PathBuf {
    let path = std::env::temp_dir().join(format!("amby-db-create-{}", ulid::Ulid::generate()));
    fs::create_dir_all(&path).unwrap();
    path
}

struct RelationFixture {
    vault: PathBuf,
    watcher: WatcherState,
    source_database_id: String,
    source_note_id: String,
    source_property_id: String,
    source_note_path: PathBuf,
    source_bytes: Vec<u8>,
    source_manifest_path: PathBuf,
    source_manifest_bytes: Vec<u8>,
    target_note_id: String,
    target_note_path: PathBuf,
    target_bytes: Vec<u8>,
    target_manifest_path: PathBuf,
    target_manifest_bytes: Vec<u8>,
}

fn relation_fixture() -> RelationFixture {
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
    let source_property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: source.manifest_revision,
            name: "Related".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Sources".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(raw_revision(
                &fs::read(&target.manifest_path).unwrap(),
            )),
            ..Default::default()
        },
    )
    .unwrap();
    let source_manifest_path = PathBuf::from(&source.manifest_path);
    let source_manifest_bytes = fs::read(&source_manifest_path).unwrap();

    let source_note_id = ulid::Ulid::generate().to_string();
    let source_note_path = Path::new(&source.manifest_path)
        .parent()
        .unwrap()
        .join("Source Record.md");
    let source_bytes = format!("---\namby-id: {source_note_id}\n---\n# Source\n").into_bytes();
    fs::write(&source_note_path, &source_bytes).unwrap();

    let target_note_id = ulid::Ulid::generate().to_string();
    let target_note_path = Path::new(&target.manifest_path)
        .parent()
        .unwrap()
        .join("Target Record.md");
    let target_bytes = format!("---\namby-id: {target_note_id}\n---\n# Target\n").into_bytes();
    fs::write(&target_note_path, &target_bytes).unwrap();

    let target_manifest_path = PathBuf::from(&target.manifest_path);
    let target_manifest_bytes = fs::read(&target_manifest_path).unwrap();

    RelationFixture {
        vault,
        watcher,
        source_database_id: source.database_id,
        source_note_id,
        source_property_id: source_property.property_id,
        source_note_path,
        source_bytes,
        source_manifest_path,
        source_manifest_bytes,
        target_note_id,
        target_note_path,
        target_bytes,
        target_manifest_path,
        target_manifest_bytes,
    }
}

fn relation_request(
    fixture: &RelationFixture,
    expected_revision: String,
    target_note_ids: Vec<String>,
) -> UpdateDatabaseRelationValueRequest {
    UpdateDatabaseRelationValueRequest {
        expected_generation: 1,
        operation_id: format!("relation-{}", ulid::Ulid::generate()),
        database_id: fixture.source_database_id.clone(),
        note_id: fixture.source_note_id.clone(),
        property_id: fixture.source_property_id.clone(),
        expected_revision,
        target_note_ids,
    }
}

fn assert_relation_revisions(
    result: &UpdateDatabaseRelationValueResult,
    fixture: &RelationFixture,
) {
    assert_eq!(
        result.revisions,
        vec![
            DatabaseNoteRevision {
                note_id: fixture.source_note_id.clone(),
                revision: raw_revision(&fs::read(&fixture.source_note_path).unwrap()),
            },
            DatabaseNoteRevision {
                note_id: fixture.target_note_id.clone(),
                revision: raw_revision(&fs::read(&fixture.target_note_path).unwrap()),
            },
        ]
    );
}

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
    assert!(!source_mapping.contains_key(&serde_yaml::Value::String("Related".to_owned())));
    assert!(source_after_unlink.contains(&fixture.source_note_id));
    assert!(source_after_unlink.contains("# Source\n"));
    let target_after_unlink = fs::read_to_string(&fixture.target_note_path).unwrap();
    let target_mapping = frontmatter::frontmatter_yaml_mapping(&target_after_unlink)
        .unwrap()
        .unwrap();
    assert!(!target_mapping.contains_key(&serde_yaml::Value::String("Sources".to_owned())));
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
    assert!(!source_mapping.contains_key(&serde_yaml::Value::String("Related".to_owned())));
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
    assert!(!source_mapping.contains_key(&serde_yaml::Value::String("Related".to_owned())));
    assert!(source_after_unlink.contains(&fixture.source_note_id));
    assert!(source_after_unlink.contains("# Source\n"));
    let target_after_unlink = fs::read_to_string(&fixture.target_note_path).unwrap();
    let target_mapping = frontmatter::frontmatter_yaml_mapping(&target_after_unlink)
        .unwrap()
        .unwrap();
    assert!(!target_mapping.contains_key(&serde_yaml::Value::String("Sources".to_owned())));
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

#[test]
fn standalone_creation_writes_manifest_and_default_view_without_markdown() {
    let vault = temp_vault();
    let result = create_database(
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
    assert!(Path::new(&result.manifest_path).is_file());
    assert!(Path::new(&result.view_path).is_file());
    let manifest =
        super::super::format::parse_manifest(&fs::read(&result.manifest_path).unwrap()).unwrap();
    assert_eq!(manifest.value.views.len(), 1);
    let view = &manifest.value.views[0];
    let validation = super::super::validation::validate_view(view, None);
    assert!(
        validation.errors.is_empty(),
        "generated view failed validation: {:?}",
        validation.errors
    );
    assert!(!vault.join("Projects").join("Projects.md").exists());
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn attached_creation_preserves_note_bytes() {
    let vault = temp_vault();
    let note = vault.join("Meeting.md");
    let original = b"---\ntitle: Meeting\n---\n\nBody\r\n";
    fs::write(&note, original).unwrap();
    let result = create_database(
        &vault,
        &WatcherState::new(),
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Attached,
            parent_path: None,
            note_path: Some(note.to_string_lossy().to_string()),
            name: "Meeting DB".to_owned(),
        },
    )
    .unwrap();
    let moved_note = vault.join("Meeting").join("Meeting.md");
    assert_eq!(fs::read(moved_note).unwrap(), original);
    assert!(Path::new(&result.manifest_path).is_file());
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_creation_updates_manifest_with_raw_revision_cas() {
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
            expected_manifest_revision: created.manifest_revision.clone(),
            name: "Priority".to_owned(),
            property_type: "number".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();
    let bytes = fs::read(&created.manifest_path).unwrap();
    let parsed = parse_manifest(&bytes).unwrap();
    assert_eq!(parsed.revision, property.manifest_revision);
    assert_eq!(parsed.value.properties.len(), 1);
    assert_eq!(
        parsed.value.properties[0].id(),
        Some(property.property_id.as_str())
    );
    assert!(create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            expected_manifest_revision: created.manifest_revision,
            name: "Stale".to_owned(),
            property_type: "text".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .is_err());
    assert_eq!(fs::read(&created.manifest_path).unwrap(), bytes);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn select_property_creation_preserves_unique_non_empty_options() {
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
    create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            expected_manifest_revision: created.manifest_revision,
            name: "Status".to_owned(),
            property_type: "select".to_owned(),
            before_property_id: None,
            options: vec!["Todo".to_owned(), " todo ".to_owned(), "".to_owned()],
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();

    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    let value = serde_json::to_value(&parsed.value.properties[0]).unwrap();
    let options = value["config"]["options"].as_array().unwrap();
    assert_eq!(options.len(), 1);
    assert_eq!(options[0]["name"], "Todo");
    assert!(ulid::Ulid::from_string(options[0]["id"].as_str().unwrap()).is_ok());
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn formula_property_creation_stores_the_validated_expression() {
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
    create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            expected_manifest_revision: created.manifest_revision,
            name: "Score".to_owned(),
            property_type: "formula".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: Some("1 + 2".to_owned()),
            ..Default::default()
        },
    )
    .unwrap();

    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    let value = serde_json::to_value(&parsed.value.properties[0]).unwrap();
    assert_eq!(value["type"], "formula");
    assert_eq!(value["config"]["expression"], "1 + 2");
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn relation_property_creation_defaults_to_the_current_database() {
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
    create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision,
            name: "Related projects".to_owned(),
            property_type: "relation".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();

    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    let value = serde_json::to_value(&parsed.value.properties[0]).unwrap();
    assert_eq!(value["type"], "relation");
    assert_eq!(value["config"]["targetDatabaseId"], created.database_id);
    assert!(value["config"]["maxItems"].is_null());
    assert!(value["config"]["inversePropertyId"].is_null());
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn relation_property_creation_can_target_another_database() {
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
            name: "Characters".to_owned(),
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
            name: "Locations".to_owned(),
        },
    )
    .unwrap();
    create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: source.manifest_revision,
            name: "Location".to_owned(),
            property_type: "relation".to_owned(),
            before_property_id: None,
            options: vec![target.database_id.clone()],
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();

    let parsed = parse_manifest(&fs::read(&source.manifest_path).unwrap()).unwrap();
    let value = serde_json::to_value(&parsed.value.properties[0]).unwrap();
    assert_eq!(value["config"]["targetDatabaseId"], target.database_id);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_updates_an_unused_definition() {
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
            name: "Estimate".to_owned(),
            property_type: "text".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();

    let changed = change_database_property_type(
        &vault,
        &watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: property.property_id.clone(),
            expected_manifest_revision: property.manifest_revision,
            property_type: "number".to_owned(),
            relation_target_database_id: None,
            ..Default::default()
        },
    )
    .unwrap();

    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    assert_eq!(parsed.revision, changed.manifest_revision);
    assert_eq!(parsed.value.properties[0].kind(), "number");
    assert_eq!(
        parsed.value.properties[0].id(),
        Some(property.property_id.as_str())
    );
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_refuses_to_discard_existing_values() {
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
            name: "Estimate".to_owned(),
            property_type: "text".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();
    let note_id = ulid::Ulid::generate().to_string();
    let record_path = Path::new(&created.manifest_path)
        .parent()
        .unwrap()
        .join(".ambd/records")
        .join(format!("{note_id}.json"));
    fs::create_dir_all(record_path.parent().unwrap()).unwrap();
    fs::write(
        record_path,
        serde_json::to_vec_pretty(&json!({
            "format": "amby-database-record",
            "formatVersion": 1,
            "databaseId": created.database_id,
            "noteId": note_id,
            "values": {
                property.property_id.clone(): {"type": "text", "value": "keep me"}
            },
            "yamlSyncBases": {}
        }))
        .unwrap(),
    )
    .unwrap();
    let manifest_before = fs::read(&created.manifest_path).unwrap();

    let error = change_database_property_type(
        &vault,
        &watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: property.property_id,
            expected_manifest_revision: property.manifest_revision,
            property_type: "number".to_owned(),
            relation_target_database_id: None,
            ..Default::default()
        },
    )
    .unwrap_err();

    assert!(error.contains("existing values"));
    assert_eq!(fs::read(&created.manifest_path).unwrap(), manifest_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_rename_updates_manifest_and_preserves_property_id() {
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
            expected_manifest_revision: created.manifest_revision.clone(),
            name: "Priority".to_owned(),
            property_type: "number".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();
    let renamed = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            property_id: property.property_id.clone(),
            expected_manifest_revision: property.manifest_revision.clone(),
            name: "Importance".to_owned(),
        },
    )
    .unwrap();
    let bytes = fs::read(&created.manifest_path).unwrap();
    let parsed = parse_manifest(&bytes).unwrap();
    assert_eq!(parsed.revision, renamed.manifest_revision);
    assert_eq!(
        parsed.value.properties[0].id(),
        Some(property.property_id.as_str())
    );
    let serialized = serde_json::to_value(&parsed.value.properties[0]).unwrap();
    assert_eq!(
        serialized.get("name").and_then(|value| value.as_str()),
        Some("Importance")
    );
    assert!(rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: property.property_id,
            expected_manifest_revision: property.manifest_revision,
            name: "Stale".to_owned(),
        },
    )
    .is_err());
    assert_eq!(fs::read(&created.manifest_path).unwrap(), bytes);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_rename_preserves_notes_and_explicit_binding_across_nested_database() {
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
            name: "Priority".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();

    let manifest_path = Path::new(&created.manifest_path);
    let explicit_binding = json!({
        "key": "priority_key",
        "direction": "twoWay",
        "vendorMetadata": "keep"
    });
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    manifest["properties"][0]["yamlBinding"] = explicit_binding.clone();
    let manifest_bytes = json_bytes(&manifest).unwrap();
    fs::write(manifest_path, &manifest_bytes).unwrap();

    let nested = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.join("Projects").to_string_lossy().to_string()),
            note_path: None,
            name: "Nested".to_owned(),
        },
    )
    .unwrap();
    let nested_property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: nested.database_id.clone(),
            expected_manifest_revision: nested.manifest_revision,
            name: "Priority".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();

    let root_note_id = ulid::Ulid::generate().to_string();
    let root_note_path = vault.join("Projects").join("Root.md");
    let root_note = format!(
        "\u{feff}---\r\namby-id: {root_note_id}\r\n# user comment\r\npriority_key: old\r\nunknown: [one, two]\r\n---\r\n# Root\r\n"
    )
    .into_bytes();
    fs::write(&root_note_path, &root_note).unwrap();

    let nested_note_id = ulid::Ulid::generate().to_string();
    let nested_note_path = vault.join("Projects/Nested").join("Child.md");
    let nested_note = format!(
        "\u{feff}---\r\namby-id: {nested_note_id}\r\nPriority: nested\r\nunknown: {{keep: true}}\r\n---\r\nNested body\r\n"
    )
    .into_bytes();
    fs::write(&nested_note_path, &nested_note).unwrap();
    let nested_manifest_before = fs::read(&nested.manifest_path).unwrap();

    let renamed = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            property_id: property.property_id.clone(),
            expected_manifest_revision: raw_revision(&manifest_bytes),
            name: "Importance".to_owned(),
        },
    )
    .unwrap();

    let renamed_manifest = parse_manifest(&fs::read(manifest_path).unwrap()).unwrap();
    let renamed_property = renamed_manifest
        .value
        .properties
        .iter()
        .find(|candidate| candidate.id() == Some(property.property_id.as_str()))
        .unwrap();
    let renamed_json = serde_json::to_value(renamed_property).unwrap();
    assert_eq!(renamed_json["name"], "Importance");
    assert_eq!(renamed_json["yamlBinding"], explicit_binding);
    assert_eq!(renamed_manifest.revision, renamed.manifest_revision);
    assert_eq!(fs::read(&root_note_path).unwrap(), root_note);
    assert_eq!(fs::read(&nested_note_path).unwrap(), nested_note);
    assert_eq!(
        fs::read(&nested.manifest_path).unwrap(),
        nested_manifest_before
    );
    assert_eq!(nested_property.name, "Priority");

    let _ = fs::remove_dir_all(vault);
}

#[test]
fn legacy_property_rename_pins_storage_key_for_repeated_renames_and_edits() {
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
            name: "Status".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let note_id = ulid::Ulid::generate().to_string();
    let note_path = vault.join("Projects").join("Legacy.md");
    let original = format!(
        "\u{feff}---\r\namby-id: {note_id}\r\n# keep this comment\r\nStatus: old\r\nunknown: {{keep: true}}\r\n---\r\nBody\r\n"
    )
    .into_bytes();
    fs::write(&note_path, &original).unwrap();

    let first = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            property_id: property.property_id.clone(),
            expected_manifest_revision: property.manifest_revision,
            name: "State".to_owned(),
        },
    )
    .unwrap();
    assert_eq!(fs::read(&note_path).unwrap(), original);

    let first_manifest = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    let first_property = first_manifest
        .value
        .properties
        .iter()
        .find(|candidate| candidate.id() == Some(property.property_id.as_str()))
        .unwrap();
    let first_json = serde_json::to_value(first_property).unwrap();
    assert_eq!(first_json["name"], "State");
    assert_eq!(first_json["yamlBinding"]["key"], "Status");
    assert_eq!(first_json["yamlBinding"]["direction"], "twoWay");

    let second = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            property_id: property.property_id.clone(),
            expected_manifest_revision: first.manifest_revision,
            name: "Phase".to_owned(),
        },
    )
    .unwrap();
    let second_manifest = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    let second_property = second_manifest
        .value
        .properties
        .iter()
        .find(|candidate| candidate.id() == Some(property.property_id.as_str()))
        .unwrap();
    let second_json = serde_json::to_value(second_property).unwrap();
    assert_eq!(second_json["name"], "Phase");
    assert_eq!(second_json["yamlBinding"]["key"], "Status");
    assert_eq!(second_json["yamlBinding"]["direction"], "twoWay");

    let edit = apply_value_batch(
        &vault,
        &watcher,
        &DatabaseValueBatchRequest {
            expected_generation: 1,
            database_id: created.database_id,
            operation_id: "legacy-rename-edit".to_owned(),
            cells: vec![DatabaseValueMutation {
                note_id,
                property_id: property.property_id,
                value_json: Some(r#"{"type":"text","value":"new"}"#.to_owned()),
                expected_revision: raw_revision(&original),
            }],
        },
        None,
    )
    .unwrap();
    assert_eq!(edit.revisions.len(), 1);
    let updated = fs::read(&note_path).unwrap();
    assert!(updated
        .windows(b"Status: new\r\n".len())
        .any(|window| { window == b"Status: new\r\n" }));
    assert!(!updated
        .windows(b"State:".len())
        .any(|window| window == b"State:"));
    assert!(!updated
        .windows(b"Phase:".len())
        .any(|window| window == b"Phase:"));
    assert!(updated.starts_with(b"\xef\xbb\xbf---\r\n"));
    assert!(updated
        .windows(b"# keep this comment\r\n".len())
        .any(|window| { window == b"# keep this comment\r\n" }));
    assert_eq!(second.manifest_revision, second_manifest.revision);

    let _ = fs::remove_dir_all(vault);
}

#[test]
fn computed_property_rename_does_not_create_yaml_bindings() {
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
    let formula = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision,
            name: "Score".to_owned(),
            property_type: "formula".to_owned(),
            formula_expression: Some("1 + 2".to_owned()),
            ..Default::default()
        },
    )
    .unwrap();

    let manifest_path = Path::new(&created.manifest_path);
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    let rollup_id = ulid::Ulid::generate().to_string();
    manifest["properties"].as_array_mut().unwrap().push(json!({
        "type": "rollup",
        "id": rollup_id,
        "name": "Total",
        "pageVisibility": "alwaysShow",
        "yamlBinding": null,
        "config": {
            "relationPropertyId": ulid::Ulid::generate().to_string(),
            "targetPropertyId": formula.property_id,
            "aggregation": "sum"
        }
    }));
    let manifest_bytes = json_bytes(&manifest).unwrap();
    fs::write(manifest_path, &manifest_bytes).unwrap();
    let parsed = parse_manifest(&manifest_bytes).unwrap();
    let rollup_id = parsed.value.properties[1].id().unwrap().to_owned();

    let renamed_formula = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            property_id: formula.property_id.clone(),
            expected_manifest_revision: parsed.revision,
            name: "Calculated".to_owned(),
        },
    )
    .unwrap();
    let after_formula = parse_manifest(&fs::read(manifest_path).unwrap()).unwrap();
    let formula_json = serde_json::to_value(
        after_formula
            .value
            .properties
            .iter()
            .find(|property| property.id() == Some(formula.property_id.as_str()))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(formula_json["name"], "Calculated");
    assert!(formula_json["yamlBinding"].is_null());

    let renamed_rollup = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: rollup_id.clone(),
            expected_manifest_revision: renamed_formula.manifest_revision,
            name: "Aggregated".to_owned(),
        },
    )
    .unwrap();
    let after_rollup = parse_manifest(&fs::read(manifest_path).unwrap()).unwrap();
    let rollup_json = serde_json::to_value(
        after_rollup
            .value
            .properties
            .iter()
            .find(|property| property.id() == Some(rollup_id.as_str()))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(rollup_json["name"], "Aggregated");
    assert!(rollup_json["yamlBinding"].is_null());
    assert_eq!(after_rollup.revision, renamed_rollup.manifest_revision);

    let _ = fs::remove_dir_all(vault);
}

#[test]
fn explicit_binding_rename_rejects_legacy_display_value_without_writing() {
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
            name: "Priority".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();

    let manifest_path = Path::new(&created.manifest_path);
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    manifest["properties"][0]["yamlBinding"] = json!({
        "key": "priority_key",
        "direction": "twoWay"
    });
    let manifest_before = json_bytes(&manifest).unwrap();
    fs::write(manifest_path, &manifest_before).unwrap();

    let note_id = ulid::Ulid::generate().to_string();
    let note_path = vault.join("Projects").join("Legacy.md");
    let note_before = format!(
        "\u{feff}---\r\namby-id: {note_id}\r\n# keep this comment\r\nPriority: legacy\r\nunknown: {{keep: true}}\r\n---\r\nBody\r\n"
    )
    .into_bytes();
    fs::write(&note_path, &note_before).unwrap();

    let error = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: property.property_id,
            expected_manifest_revision: raw_revision(&manifest_before),
            name: "Importance".to_owned(),
        },
    )
    .unwrap_err();

    assert!(
        error.contains("legacy YAML value"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(manifest_path).unwrap(), manifest_before);
    assert_eq!(fs::read(&note_path).unwrap(), note_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn legacy_binding_pin_rejects_case_insensitive_yaml_binding_collision() {
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
    let target = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision,
            name: "Status".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let other = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: target.manifest_revision,
            name: "Other".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();

    let manifest_path = Path::new(&created.manifest_path);
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    let other_json = manifest["properties"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|property| property["id"] == other.property_id)
        .unwrap();
    other_json["yamlBinding"] = json!({
        "key": " status ",
        "direction": "twoWay"
    });
    let manifest_before = json_bytes(&manifest).unwrap();
    fs::write(manifest_path, &manifest_before).unwrap();

    let note_id = ulid::Ulid::generate().to_string();
    let note_path = vault.join("Projects").join("Status.md");
    let note_before = format!("---\namby-id: {note_id}\nStatus: old\n---\nBody\n").into_bytes();
    fs::write(&note_path, &note_before).unwrap();

    let error = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: target.property_id,
            expected_manifest_revision: raw_revision(&manifest_before),
            name: "State".to_owned(),
        },
    )
    .unwrap_err();

    assert!(
        error.contains("ambiguous YAML binding"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(manifest_path).unwrap(), manifest_before);
    assert_eq!(fs::read(&note_path).unwrap(), note_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn legacy_binding_pin_rejects_collision_with_foreign_property_id() {
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
    let foreign = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision,
            name: "Foreign".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let target = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: foreign.manifest_revision,
            name: foreign.property_id.clone(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();

    let manifest_path = Path::new(&created.manifest_path);
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    let foreign_json = manifest["properties"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|property| property["id"] == foreign.property_id)
        .unwrap();
    foreign_json["yamlBinding"] = json!({
        "key": "foreign_value",
        "direction": "twoWay"
    });
    let manifest_before = json_bytes(&manifest).unwrap();
    fs::write(manifest_path, &manifest_before).unwrap();

    let note_id = ulid::Ulid::generate().to_string();
    let note_path = vault.join("Projects").join("ForeignId.md");
    let note_before = format!(
        "\u{feff}---\r\namby-id: {note_id}\r\n{}: legacy\r\nforeign_value: current\r\n---\r\nBody\r\n",
        foreign.property_id
    )
    .into_bytes();
    fs::write(&note_path, &note_before).unwrap();

    let error = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: target.property_id,
            expected_manifest_revision: raw_revision(&manifest_before),
            name: "Renamed".to_owned(),
        },
    )
    .unwrap_err();

    assert!(
        error.contains("ambiguous YAML binding"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(manifest_path).unwrap(), manifest_before);
    assert_eq!(fs::read(&note_path).unwrap(), note_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_rename_rejects_name_based_formula_dependency_without_writing() {
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
    let price = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision,
            name: "Price".to_owned(),
            property_type: "number".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let tax = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: price.manifest_revision,
            name: "Tax".to_owned(),
            property_type: "number".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let formula = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: tax.manifest_revision,
            name: "Total".to_owned(),
            property_type: "formula".to_owned(),
            formula_expression: Some("Price + Tax".to_owned()),
            ..Default::default()
        },
    )
    .unwrap();

    let manifest_path = Path::new(&created.manifest_path);
    let manifest_before = fs::read(manifest_path).unwrap();
    let note_id = ulid::Ulid::generate().to_string();
    let note_path = vault.join("Projects").join("Invoice.md");
    let note_before =
        format!("---\namby-id: {note_id}\nPrice: 10\nTax: 2\n---\nBody\n").into_bytes();
    fs::write(&note_path, &note_before).unwrap();

    let error = rename_database_property(
        &vault,
        &watcher,
        &RenameDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: price.property_id,
            expected_manifest_revision: raw_revision(&manifest_before),
            name: "Cost".to_owned(),
        },
    )
    .unwrap_err();

    assert!(
        error.contains("break formula dependencies"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(manifest_path).unwrap(), manifest_before);
    assert_eq!(fs::read(&note_path).unwrap(), note_before);
    assert_eq!(formula.name, "Total");
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_insert_and_delete_update_schema_order() {
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
    let right = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision,
            name: "Right".to_owned(),
            property_type: "text".to_owned(),
            before_property_id: None,
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();
    let left = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: right.manifest_revision,
            name: "Left".to_owned(),
            property_type: "number".to_owned(),
            before_property_id: Some(right.property_id.clone()),
            options: Vec::new(),
            formula_expression: None,
            ..Default::default()
        },
    )
    .unwrap();
    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    assert_eq!(
        parsed.value.properties[0].id(),
        Some(left.property_id.as_str())
    );
    assert_eq!(
        parsed.value.properties[1].id(),
        Some(right.property_id.as_str())
    );

    let reordered = reorder_database_properties(
        &vault,
        &watcher,
        &ReorderDatabasePropertiesRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: left.manifest_revision,
            property_ids: vec![right.property_id.clone(), left.property_id.clone()],
        },
    )
    .unwrap();
    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    assert_eq!(
        parsed.value.properties[0].id(),
        Some(right.property_id.as_str())
    );
    assert_eq!(
        parsed.value.properties[1].id(),
        Some(left.property_id.as_str())
    );

    let deleted = delete_database_property(
        &vault,
        &watcher,
        &DeleteDatabasePropertyRequest {
            expected_generation: 1,
            database_id: created.database_id,
            property_id: left.property_id,
            expected_manifest_revision: reordered.manifest_revision,
        },
    )
    .unwrap();
    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    assert_eq!(parsed.revision, deleted.manifest_revision);
    assert_eq!(parsed.value.properties.len(), 1);
    assert_eq!(
        parsed.value.properties[0].id(),
        Some(right.property_id.as_str())
    );
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn database_rename_updates_manifest_with_raw_revision_cas() {
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
    let renamed = rename_database(
        &vault,
        &watcher,
        &RenameDatabaseRequest {
            expected_generation: 1,
            database_id: created.database_id.clone(),
            expected_manifest_revision: created.manifest_revision.clone(),
            name: "Roadmap".to_owned(),
        },
    )
    .unwrap();
    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    assert_eq!(parsed.value.name, "Roadmap");
    assert_eq!(parsed.revision, renamed.manifest_revision);
    assert!(rename_database(
        &vault,
        &watcher,
        &RenameDatabaseRequest {
            expected_generation: 1,
            database_id: created.database_id,
            expected_manifest_revision: created.manifest_revision,
            name: "Stale".to_owned(),
        },
    )
    .is_err());
    let _ = fs::remove_dir_all(vault);
}

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
    let recovered = recover_pending_batches(&vault).unwrap();
    assert_eq!(recovered, 1);

    // Note content must be restored back to original
    assert_eq!(fs::read(&note_path).unwrap(), original);

    // Journal must now be marked as rolledBack
    let updated_journal = read_batch_journal(&journal_path).unwrap();
    assert_eq!(updated_journal.status, "rolledBack");

    // Idempotent: subsequent recovery run finds 0 pending batches
    let second_run = recover_pending_batches(&vault).unwrap();
    assert_eq!(second_run, 0);

    let _ = fs::remove_dir_all(vault);
}

#[test]
fn recover_pending_batches_reports_unreadable_journals_without_dropping_them() {
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

    let error = recover_pending_batches(&vault).unwrap_err();
    assert!(error.contains("bad-op.json"), "{error}");
    // The valid journal is still recovered and the corrupt one is preserved.
    assert_eq!(fs::read(&note_path).unwrap(), original);
    assert_eq!(fs::read(&corrupt).unwrap(), b"{ not a journal");

    let _ = fs::remove_dir_all(vault);
}

/// Failure matrix over the real publish boundaries of a two-way Relation value
/// update (journal create, backups, source write, inverse write, journal
/// progress, completion). For every n-th atomic write, failing either before
/// or right after publication, activation recovery must leave the two notes
/// consistent: either both linked or both byte-identical to the original, with
/// no temp files, and a second recovery must change nothing.
#[test]
fn relation_value_update_failure_matrix_keeps_both_notes_consistent() {
    let mut exercised = 0;
    for after_publish in [false, true] {
        for nth in 1..=40u64 {
            let vault = temp_vault();
            let watcher = WatcherState::new();
            let mut databases = Vec::new();
            for name in ["Tasks", "Projects"] {
                databases.push(
                    create_database(
                        &vault,
                        &watcher,
                        &CreateDatabaseRequest {
                            expected_generation: 1,
                            mode: DatabaseCreateMode::Standalone,
                            parent_path: Some(vault.to_string_lossy().to_string()),
                            note_path: None,
                            name: name.to_owned(),
                        },
                    )
                    .unwrap(),
                );
            }
            let (tasks_db, projects_db) = (&databases[0], &databases[1]);
            let tasks_rel = create_database_property(
                &vault,
                &watcher,
                &CreateDatabasePropertyRequest {
                    expected_generation: 1,
                    database_id: tasks_db.database_id.clone(),
                    expected_manifest_revision: tasks_db.manifest_revision.clone(),
                    name: "Project".to_owned(),
                    property_type: "relation".to_owned(),
                    relation_target_database_id: Some(projects_db.database_id.clone()),
                    relation_max_items: Some(1),
                    relation_two_way: Some(true),
                    relation_inverse_property_name: Some("Tasks".to_owned()),
                    operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
                    expected_target_manifest_revision: Some(raw_revision(
                        &fs::read(&projects_db.manifest_path).unwrap(),
                    )),
                    ..Default::default()
                },
            )
            .unwrap();
            let task_id = ulid::Ulid::generate().to_string();
            let project_id = ulid::Ulid::generate().to_string();
            let task_path = Path::new(&tasks_db.manifest_path)
                .parent()
                .unwrap()
                .join("Task.md");
            let project_path = Path::new(&projects_db.manifest_path)
                .parent()
                .unwrap()
                .join("Project.md");
            fs::write(
                &task_path,
                format!("---\namby-id: {task_id}\n---\n# Task\n"),
            )
            .unwrap();
            fs::write(
                &project_path,
                format!("---\namby-id: {project_id}\n---\n# Project\n"),
            )
            .unwrap();
            let original_task = fs::read(&task_path).unwrap();
            let original_project = fs::read(&project_path).unwrap();
            let request = UpdateDatabaseRelationValueRequest {
                expected_generation: 1,
                operation_id: format!("relation-{}", ulid::Ulid::generate()),
                database_id: tasks_db.database_id.clone(),
                note_id: task_id.clone(),
                property_id: tasks_rel.property_id.clone(),
                expected_revision: raw_revision(&original_task),
                target_note_ids: vec![project_id.clone()],
            };

            frontmatter::inject_nth_atomic_write_failure(nth, after_publish);
            let result = update_database_relation_value(&vault, &watcher, &request, None);
            let calls = frontmatter::clear_atomic_write_failure();
            if calls < nth {
                // The operation finished before reaching this write: matrix complete.
                assert!(result.is_ok(), "no fault injected, operation must succeed");
                let _ = fs::remove_dir_all(vault);
                break;
            }
            exercised += 1;

            crate::database::relation_recovery::recover_pending_relations(&vault).unwrap_or_else(
                |error| panic!("recovery failed (nth={nth}, after={after_publish}): {error}"),
            );
            let task = fs::read(&task_path).unwrap();
            let project = fs::read(&project_path).unwrap();
            let task_linked = String::from_utf8_lossy(&task).contains(&project_id);
            let project_linked = String::from_utf8_lossy(&project).contains(&task_id);
            assert_eq!(
                task_linked, project_linked,
                "notes diverged (nth={nth}, after_publish={after_publish})"
            );
            if !task_linked {
                assert_eq!(task, original_task, "nth={nth} after={after_publish}");
                assert_eq!(project, original_project, "nth={nth} after={after_publish}");
            }
            for dir in [task_path.parent().unwrap(), project_path.parent().unwrap()] {
                for entry in fs::read_dir(dir).unwrap() {
                    let name = entry.unwrap().file_name().to_string_lossy().into_owned();
                    assert!(!name.contains(".amby-tmp-"), "temp leftover {name}");
                }
            }
            crate::database::relation_recovery::recover_pending_relations(&vault).unwrap();
            assert_eq!(
                fs::read(&task_path).unwrap(),
                task,
                "recovery not idempotent"
            );
            assert_eq!(
                fs::read(&project_path).unwrap(),
                project,
                "recovery not idempotent"
            );
            let _ = fs::remove_dir_all(vault);
        }
    }
    eprintln!("failure matrix exercised {exercised} boundaries");
    assert!(
        exercised >= 8,
        "matrix exercised only {exercised} boundaries"
    );
}

#[test]
fn two_way_relation_creates_property_in_target_database_and_links_reciprocals() {
    let vault = temp_vault();
    let watcher = WatcherState::new();
    let tasks_db = create_database(
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
    let projects_db = create_database(
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

    let tasks_rel = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: tasks_db.database_id.clone(),
            expected_manifest_revision: tasks_db.manifest_revision.clone(),
            name: "Project".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(projects_db.database_id.clone()),
            relation_max_items: Some(1),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Tasks".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(raw_revision(
                &fs::read(&projects_db.manifest_path).unwrap(),
            )),
            ..Default::default()
        },
    )
    .unwrap();

    let tasks_manifest = parse_manifest(&fs::read(&tasks_db.manifest_path).unwrap()).unwrap();
    let tasks_prop_val = serde_json::to_value(&tasks_manifest.value.properties[0]).unwrap();
    assert_eq!(tasks_prop_val["name"], "Project");
    assert_eq!(
        tasks_prop_val["config"]["targetDatabaseId"],
        projects_db.database_id
    );
    assert_eq!(tasks_prop_val["config"]["maxItems"], 1);
    let inverse_id = tasks_prop_val["config"]["inversePropertyId"]
        .as_str()
        .unwrap()
        .to_string();

    let projects_manifest = parse_manifest(&fs::read(&projects_db.manifest_path).unwrap()).unwrap();
    let projects_prop_val = serde_json::to_value(&projects_manifest.value.properties[0]).unwrap();
    assert_eq!(projects_prop_val["name"], "Tasks");
    assert_eq!(projects_prop_val["id"], inverse_id);
    assert_eq!(
        projects_prop_val["config"]["targetDatabaseId"],
        tasks_db.database_id
    );
    assert_eq!(
        projects_prop_val["config"]["inversePropertyId"],
        tasks_rel.property_id
    );

    // Now test update_database_relation_value syncs reciprocal records
    let task_note_id = ulid::Ulid::generate().to_string();
    let project_note_id = ulid::Ulid::generate().to_string();

    let tasks_dir = Path::new(&tasks_db.manifest_path).parent().unwrap();
    let task_note_path = tasks_dir.join("Task.md");
    fs::write(
        &task_note_path,
        format!("---\namby-id: {task_note_id}\n---\n# Task\n"),
    )
    .unwrap();

    let projects_dir = Path::new(&projects_db.manifest_path).parent().unwrap();
    let project_note_path = projects_dir.join("Project.md");
    fs::write(
        &project_note_path,
        format!("---\namby-id: {project_note_id}\n---\n# Project\n"),
    )
    .unwrap();

    update_database_relation_value(
        &vault,
        &watcher,
        &UpdateDatabaseRelationValueRequest {
            expected_generation: 1,
            operation_id: format!("relation-{}", ulid::Ulid::generate()),
            database_id: tasks_db.database_id.clone(),
            note_id: task_note_id.clone(),
            property_id: tasks_rel.property_id.clone(),
            expected_revision: raw_revision(&fs::read(&task_note_path).unwrap()),
            target_note_ids: vec![project_note_id.clone()],
        },
        None,
    )
    .unwrap();

    // Check task note frontmatter
    let task_content = fs::read_to_string(&task_note_path).unwrap();
    let task_mapping = frontmatter::frontmatter_yaml_mapping(&task_content)
        .unwrap()
        .unwrap();
    let task_rel_val = task_mapping
        .get(&serde_yaml::Value::String("Project".to_string()))
        .expect("Task frontmatter must contain Project relation");
    let task_prop_def = &tasks_manifest.value.properties[0];
    let task_prop_val =
        crate::database::format::frontmatter_value_to_property_value(task_rel_val, task_prop_def)
            .expect("Valid relation value in Task");
    match task_prop_val {
        PropertyValue::Relation {
            target_note_ids, ..
        } => {
            assert_eq!(target_note_ids, &[project_note_id.clone()]);
        }
        other => panic!("expected relation value, got {other:?}"),
    }

    // Check project note frontmatter was reciprocally updated!
    let project_content = fs::read_to_string(&project_note_path).unwrap();
    let project_mapping = frontmatter::frontmatter_yaml_mapping(&project_content)
        .unwrap()
        .unwrap();
    let project_rel_val = project_mapping
        .get(&serde_yaml::Value::String("Tasks".to_string()))
        .expect("Project frontmatter must contain Tasks reciprocal relation");
    let project_prop_def = &projects_manifest.value.properties[0];
    let project_prop_val = crate::database::format::frontmatter_value_to_property_value(
        project_rel_val,
        project_prop_def,
    )
    .expect("Valid relation value in Project");
    match project_prop_val {
        PropertyValue::Relation {
            target_note_ids, ..
        } => {
            assert_eq!(target_note_ids, &[task_note_id.clone()]);
        }
        other => panic!("expected inverse relation value on project, got {other:?}"),
    }

    // Now unlink
    update_database_relation_value(
        &vault,
        &watcher,
        &UpdateDatabaseRelationValueRequest {
            expected_generation: 1,
            operation_id: format!("relation-{}", ulid::Ulid::generate()),
            database_id: tasks_db.database_id.clone(),
            note_id: task_note_id.clone(),
            property_id: tasks_rel.property_id.clone(),
            expected_revision: raw_revision(&fs::read(&task_note_path).unwrap()),
            target_note_ids: vec![],
        },
        None,
    )
    .unwrap();

    let project_content_after = fs::read_to_string(&project_note_path).unwrap();
    let project_mapping_after = frontmatter::frontmatter_yaml_mapping(&project_content_after)
        .unwrap()
        .unwrap();
    if let Some(val) = project_mapping_after.get(&serde_yaml::Value::String("Tasks".to_string())) {
        let prop_val =
            crate::database::format::frontmatter_value_to_property_value(val, project_prop_def)
                .unwrap_or(PropertyValue::Relation {
                    target_note_ids: vec![],
                    extra: Default::default(),
                });
        match prop_val {
            PropertyValue::Relation {
                target_note_ids, ..
            } => {
                assert!(target_note_ids.is_empty());
            }
            other => panic!("expected empty inverse relation, got {other:?}"),
        }
    }

    let _ = fs::remove_dir_all(vault);
}

#[test]
fn creates_standalone_database_with_named_json_file() {
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
            name: "My Tasks".to_owned(),
        },
    )
    .unwrap();

    assert_eq!(created.title, "My Tasks");
    let db_dir = vault.join("My Tasks");
    assert!(db_dir.is_dir());

    // The manifest MUST be named "My Tasks.json"
    let manifest_path = db_dir.join("My Tasks.json");
    assert!(manifest_path.is_file());
    assert!(!db_dir.join("ambd.json").exists());

    // Verify content
    let parsed = parse_manifest(&fs::read(&manifest_path).unwrap()).unwrap();
    assert_eq!(parsed.value.name, "My Tasks");
    assert_eq!(parsed.value.database_id, created.database_id);

    // Add a property
    let prop = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            expected_manifest_revision: parsed.revision.clone(),
            database_id: created.database_id.clone(),
            name: "Priority".to_owned(),
            property_type: "select".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();

    // Verify property was written to "My Tasks.json"
    let parsed_after = parse_manifest(&fs::read(&manifest_path).unwrap()).unwrap();
    assert_eq!(parsed_after.revision, prop.manifest_revision);
    assert_eq!(parsed_after.value.properties.len(), 1);

    // Rename the database item via crate::bundle::rename_item_impl
    crate::bundle::rename_item_impl(&db_dir, "All Tasks").unwrap();

    let new_db_dir = vault.join("All Tasks");
    assert!(new_db_dir.is_dir());
    assert!(!db_dir.exists());

    // The manifest file should have been renamed to "All Tasks.json"
    let new_manifest_path = new_db_dir.join("All Tasks.json");
    assert!(new_manifest_path.is_file());
    assert!(!new_db_dir.join("My Tasks.json").exists());

    // The internal "name" should be updated to "All Tasks"
    let parsed_renamed = parse_manifest(&fs::read(&new_manifest_path).unwrap()).unwrap();
    assert_eq!(parsed_renamed.value.name, "All Tasks");

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
fn st04_two_way_relation_target_locked_or_missing_fails_cleanly() {
    let vault = temp_vault();
    let watcher = WatcherState::new();

    let db_a = create_database(
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

    let db_b = create_database(
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

    let projects_manifest_path = vault.join("Projects").join("Projects.json");
    let projects_bytes = fs::read(&projects_manifest_path).unwrap();
    let projects_manifest = parse_manifest(&projects_bytes).unwrap();

    let a_prop = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            expected_manifest_revision: projects_manifest.revision.clone(),
            database_id: db_a.database_id.clone(),
            name: "Tasks".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(db_b.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Project".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(raw_revision(
                &fs::read(&db_b.manifest_path).unwrap(),
            )),
            ..Default::default()
        },
    )
    .unwrap();

    let proj_note_id = ulid::Ulid::generate().to_string();
    let proj_note_path = vault.join("Projects").join("Project 1.md");
    let proj_orig = format!("---\namby-id: {proj_note_id}\n---\n\nProject content\n");
    fs::write(&proj_note_path, &proj_orig).unwrap();

    // 1. Target note is missing
    let missing_note_id = ulid::Ulid::generate().to_string();
    let rel_req = UpdateDatabaseRelationValueRequest {
        expected_generation: 1,
        operation_id: format!("relation-{}", ulid::Ulid::generate()),
        database_id: db_a.database_id.clone(),
        note_id: proj_note_id.clone(),
        property_id: a_prop.property_id.clone(),
        expected_revision: raw_revision(&fs::read(&proj_note_path).unwrap()),
        target_note_ids: vec![missing_note_id.clone()],
    };
    let res = update_database_relation_value(&vault, &watcher, &rel_req, None);
    assert!(res.is_err(), "Must fail when target note is missing");
    assert_eq!(
        fs::read_to_string(&proj_note_path).unwrap(),
        proj_orig,
        "Source note must not be modified if target note is missing"
    );

    // 2. Target database is locked
    let task_note_id = ulid::Ulid::generate().to_string();
    let task_note_path = vault.join("Tasks").join("Task 1.md");
    let task_orig = format!("---\namby-id: {task_note_id}\n---\n\nTask content\n");
    fs::write(&task_note_path, &task_orig).unwrap();

    // Lock target database
    let tasks_manifest_path = vault.join("Tasks").join("Tasks.json");
    let mut target_m = parse_manifest(&fs::read(&tasks_manifest_path).unwrap()).unwrap();
    target_m.value.locked = true;
    fs::write(
        &tasks_manifest_path,
        serde_json::to_vec_pretty(&target_m.value).unwrap(),
    )
    .unwrap();

    let rel_req2 = UpdateDatabaseRelationValueRequest {
        expected_generation: 1,
        operation_id: format!("relation-{}", ulid::Ulid::generate()),
        database_id: db_a.database_id.clone(),
        note_id: proj_note_id.clone(),
        property_id: a_prop.property_id.clone(),
        expected_revision: raw_revision(&fs::read(&proj_note_path).unwrap()),
        target_note_ids: vec![task_note_id.clone()],
    };
    let res2 = update_database_relation_value(&vault, &watcher, &rel_req2, None);
    assert!(res2.is_err(), "Must fail when target database is locked");
    assert_eq!(
        fs::read_to_string(&proj_note_path).unwrap(),
        proj_orig,
        "Source note must not be modified if target database is locked"
    );

    let _ = fs::remove_dir_all(vault);
}

#[test]
fn st04_self_relation_updates_single_file_without_conflict() {
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

    let manifest_path = vault.join("Tasks").join("Tasks.json");
    let manifest = parse_manifest(&fs::read(&manifest_path).unwrap()).unwrap();

    let subtask_prop = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            expected_manifest_revision: manifest.revision.clone(),
            database_id: db.database_id.clone(),
            name: "Subtasks".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(db.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Parent".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            ..Default::default()
        },
    )
    .unwrap();

    let note_id = ulid::Ulid::generate().to_string();
    let note_path = vault.join("Tasks").join("RecursiveTask.md");
    let note_orig = format!("---\namby-id: {note_id}\n---\n\nSelf-referencing task\n");
    fs::write(&note_path, &note_orig).unwrap();

    let rel_req = UpdateDatabaseRelationValueRequest {
        expected_generation: 1,
        operation_id: format!("relation-{}", ulid::Ulid::generate()),
        database_id: db.database_id.clone(),
        note_id: note_id.clone(),
        property_id: subtask_prop.property_id.clone(),
        expected_revision: raw_revision(&fs::read(&note_path).unwrap()),
        target_note_ids: vec![note_id.clone()],
    };

    let res = update_database_relation_value(&vault, &watcher, &rel_req, None);
    assert!(
        res.is_ok(),
        "Self-relation update must succeed: {:?}",
        res.err()
    );

    let content_after = fs::read_to_string(&note_path).unwrap();
    let mapping = frontmatter::frontmatter_yaml_mapping(&content_after)
        .unwrap()
        .unwrap();

    let sub_val = mapping
        .get(&serde_yaml::Value::String("Subtasks".to_string()))
        .unwrap();
    let par_val = mapping
        .get(&serde_yaml::Value::String("Parent".to_string()))
        .unwrap();

    assert_eq!(
        sub_val,
        &serde_yaml::Value::Sequence(vec![serde_yaml::Value::String(note_id.clone())])
    );
    assert_eq!(
        par_val,
        &serde_yaml::Value::Sequence(vec![serde_yaml::Value::String(note_id.clone())])
    );

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

#[test]
fn two_way_relation_rejects_inverse_yaml_binding_alias_without_writing() {
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
    let existing = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: target.database_id.clone(),
            expected_manifest_revision: target.manifest_revision,
            name: "Legacy".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let target_manifest_path = Path::new(&target.manifest_path);
    let mut target_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(target_manifest_path).unwrap()).unwrap();
    let existing_json = target_manifest["properties"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|property| property["id"] == existing.property_id)
        .unwrap();
    existing_json["yamlBinding"] = json!({"key": "Sources", "direction": "twoWay"});
    fs::write(target_manifest_path, json_bytes(&target_manifest).unwrap()).unwrap();

    let source_manifest_path = Path::new(&source.manifest_path);
    let source_before = fs::read(source_manifest_path).unwrap();
    let target_before = fs::read(target_manifest_path).unwrap();
    let error = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: raw_revision(&source_before),
            name: "Related".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Sources".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(raw_revision(&target_before)),
            ..Default::default()
        },
    )
    .unwrap_err();

    assert!(
        error.to_ascii_lowercase().contains("yaml")
            || error.to_ascii_lowercase().contains("binding")
            || error.to_ascii_lowercase().contains("name"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(source_manifest_path).unwrap(), source_before);
    assert_eq!(fs::read(target_manifest_path).unwrap(), target_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn two_way_relation_rejects_bom_target_manifest_without_writing() {
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
    let source_manifest_path = Path::new(&source.manifest_path);
    let target_manifest_path = Path::new(&target.manifest_path);
    let source_before = fs::read(source_manifest_path).unwrap();
    let mut target_before = fs::read(target_manifest_path).unwrap();
    let mut bom_target = vec![0xef, 0xbb, 0xbf];
    bom_target.append(&mut target_before);
    fs::write(target_manifest_path, &bom_target).unwrap();

    let error = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: raw_revision(&source_before),
            name: "Related".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Sources".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(raw_revision(&bom_target)),
            ..Default::default()
        },
    )
    .unwrap_err();

    assert!(!error.is_empty());
    assert_eq!(fs::read(source_manifest_path).unwrap(), source_before);
    assert_eq!(fs::read(target_manifest_path).unwrap(), bom_target);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn two_way_relation_invalid_source_insert_does_not_write_inverse_manifest() {
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
    let source_path = Path::new(&source.manifest_path);
    let target_path = Path::new(&target.manifest_path);
    let source_before = fs::read(source_path).unwrap();
    let target_before = fs::read(target_path).unwrap();

    let error = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: raw_revision(&source_before),
            name: "Related".to_owned(),
            property_type: "relation".to_owned(),
            before_property_id: Some(ulid::Ulid::generate().to_string()),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Sources".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(raw_revision(&target_before)),
            ..Default::default()
        },
    )
    .unwrap_err();

    assert!(
        error.contains("Insert position property"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(source_path).unwrap(), source_before);
    assert_eq!(fs::read(target_path).unwrap(), target_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn two_way_relation_source_property_limit_does_not_write_inverse_manifest() {
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
    let source_path = Path::new(&source.manifest_path);
    let target_path = Path::new(&target.manifest_path);
    let mut source_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(source_path).unwrap()).unwrap();
    let properties = source_manifest["properties"].as_array_mut().unwrap();
    for index in 0..crate::database::validation::MAX_PROPERTIES {
        properties.push(json!({
            "type": "text",
            "id": ulid::Ulid::generate().to_string(),
            "name": format!("Filler {index}"),
            "pageVisibility": "alwaysShow",
            "yamlBinding": null,
            "config": {"multiline": false}
        }));
    }
    fs::write(source_path, json_bytes(&source_manifest).unwrap()).unwrap();
    let source_before = fs::read(source_path).unwrap();
    let target_before = fs::read(target_path).unwrap();

    let error = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: raw_revision(&source_before),
            name: "Related".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Sources".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(raw_revision(&target_before)),
            ..Default::default()
        },
    )
    .unwrap_err();

    assert!(
        error.contains("at most") || error.contains("invalid"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(source_path).unwrap(), source_before);
    assert_eq!(fs::read(target_path).unwrap(), target_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn two_way_relation_stale_or_missing_target_revision_does_not_write() {
    for expected_target_manifest_revision in [Some("0".repeat(64)), None] {
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
        let source_path = Path::new(&source.manifest_path);
        let target_path = Path::new(&target.manifest_path);
        let source_before = fs::read(source_path).unwrap();
        let target_before = fs::read(target_path).unwrap();
        let error = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: source.database_id.clone(),
                expected_manifest_revision: raw_revision(&source_before),
                name: "Related".to_owned(),
                property_type: "relation".to_owned(),
                relation_target_database_id: Some(target.database_id.clone()),
                relation_two_way: Some(true),
                relation_inverse_property_name: Some("Sources".to_owned()),
                operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
                expected_target_manifest_revision,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(
            error.to_ascii_lowercase().contains("revision"),
            "unexpected error: {error}"
        );
        assert_eq!(fs::read(source_path).unwrap(), source_before);
        assert_eq!(fs::read(target_path).unwrap(), target_before);
        let _ = fs::remove_dir_all(vault);
    }
}

#[test]
fn self_two_way_relation_rejects_forward_and_existing_inverse_names() {
    for (forward_name, inverse_name, add_existing) in
        [("Parent", "Parent", false), ("Forward", "Existing", true)]
    {
        let vault = temp_vault();
        let watcher = WatcherState::new();
        let database = create_database(
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
        let manifest_path = Path::new(&database.manifest_path);
        if add_existing {
            create_database_property(
                &vault,
                &watcher,
                &CreateDatabasePropertyRequest {
                    expected_generation: 1,
                    database_id: database.database_id.clone(),
                    expected_manifest_revision: database.manifest_revision.clone(),
                    name: "Existing".to_owned(),
                    property_type: "text".to_owned(),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let before = fs::read(manifest_path).unwrap();
        let error = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: database.database_id.clone(),
                expected_manifest_revision: raw_revision(&before),
                name: forward_name.to_owned(),
                property_type: "relation".to_owned(),
                relation_target_database_id: Some(database.database_id.clone()),
                relation_two_way: Some(true),
                relation_inverse_property_name: Some(inverse_name.to_owned()),
                operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(
            error.contains("already") || error.contains("name") || error.contains("YAML"),
            "unexpected error: {error}"
        );
        assert_eq!(fs::read(manifest_path).unwrap(), before);
        let _ = fs::remove_dir_all(vault);
    }
}

#[test]
fn self_two_way_relation_persists_one_step_and_replays_completed_result() {
    let vault = temp_vault();
    let watcher = WatcherState::new();
    let database = create_database(
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
    let manifest_path = Path::new(&database.manifest_path);
    let operation_id = format!("relation-schema-{}", ulid::Ulid::generate());
    let request = CreateDatabasePropertyRequest {
        expected_generation: 1,
        database_id: database.database_id.clone(),
        expected_manifest_revision: raw_revision(&fs::read(manifest_path).unwrap()),
        name: "Subtasks".to_owned(),
        property_type: "relation".to_owned(),
        relation_target_database_id: Some(database.database_id.clone()),
        relation_two_way: Some(true),
        relation_inverse_property_name: Some("Parent".to_owned()),
        operation_id: Some(operation_id.clone()),
        ..Default::default()
    };
    let created = create_database_property(&vault, &watcher, &request).unwrap();
    let after_create = fs::read(manifest_path).unwrap();
    assert_eq!(created.manifest_revisions.len(), 1);
    assert_eq!(created.operation_id.as_deref(), Some(operation_id.as_str()));
    let manifest = parse_manifest(&after_create).unwrap();
    assert_eq!(manifest.value.properties.len(), 2);
    let forward = serde_json::to_value(&manifest.value.properties[0]).unwrap();
    let inverse = serde_json::to_value(&manifest.value.properties[1]).unwrap();
    assert_eq!(forward["name"], "Subtasks");
    assert_eq!(inverse["name"], "Parent");
    assert_eq!(forward["config"]["inversePropertyId"], inverse["id"]);
    assert_eq!(inverse["config"]["inversePropertyId"], forward["id"]);
    assert_eq!(
        created.inverse_property_id.as_deref(),
        inverse["id"].as_str()
    );

    let journal_path = vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{operation_id}.json"));
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(journal_path).unwrap()).unwrap();
    assert_eq!(journal["status"], "completed");
    assert_eq!(journal["steps"].as_array().unwrap().len(), 1);

    let replay_request = CreateDatabasePropertyRequest {
        expected_generation: 99,
        ..request.clone()
    };
    let replayed = create_database_property(&vault, &watcher, &replay_request).unwrap();
    assert_eq!(replayed, created);
    assert_eq!(fs::read(manifest_path).unwrap(), after_create);

    let mut mismatch = replay_request.clone();
    mismatch.name = "Different".to_owned();
    assert!(create_database_property(&vault, &watcher, &mismatch).is_err());
    assert_eq!(fs::read(manifest_path).unwrap(), after_create);
    let _ = fs::remove_dir_all(vault);
}

fn relation_schema_database_pair() -> (PathBuf, WatcherState, CreatedDatabase, CreatedDatabase) {
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
    (vault, watcher, source, target)
}

#[test]
fn relation_configuration_noop_does_not_claim_or_consume_a_durable_operation_id() {
    let (vault, watcher, source, _) = relation_schema_database_pair();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Related".to_owned(),
            property_type: "relation".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let before = fs::read(&source.manifest_path).unwrap();
    let operation_id = format!("schema-noop-{}", ulid::Ulid::generate());
    let mut request = ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: source.database_id.clone(),
        property_id: property.property_id,
        expected_manifest_revision: property.manifest_revision,
        property_type: "relation".to_owned(),
        operation_id: Some(operation_id.clone()),
        relation_two_way: Some(false),
        relation_max_items: Some(0),
        ..Default::default()
    };
    let unchanged = change_database_property_type(&vault, &watcher, &request).unwrap();
    assert!(unchanged.operation_id.is_none());
    assert_eq!(fs::read(&source.manifest_path).unwrap(), before);
    let journal_path = vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{operation_id}.json"));
    assert!(!journal_path.exists());

    request.relation_max_items = Some(1);
    let changed = change_database_property_type(&vault, &watcher, &request).unwrap();
    assert_eq!(changed.operation_id.as_deref(), Some(operation_id.as_str()));
    assert!(journal_path.exists());
    let _ = fs::remove_dir_all(vault);
}

fn current_manifest_revision(database: &CreatedDatabase) -> String {
    raw_revision(&fs::read(&database.manifest_path).unwrap())
}

#[test]
fn property_type_change_empty_text_to_two_way_cross_creates_inverse_and_replays() {
    let (vault, watcher, source, target) = relation_schema_database_pair();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Project".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let source_path = Path::new(&source.manifest_path);
    let target_path = Path::new(&target.manifest_path);
    let request = ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: source.database_id.clone(),
        property_id: property.property_id.clone(),
        expected_manifest_revision: property.manifest_revision.clone(),
        property_type: "relation".to_owned(),
        relation_target_database_id: Some(target.database_id.clone()),
        relation_two_way: Some(true),
        relation_inverse_property_name: Some("Tasks".to_owned()),
        operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
        expected_related_manifest_revisions: vec![DatabaseManifestRevision {
            database_id: target.database_id.clone(),
            revision: current_manifest_revision(&target),
        }],
        ..Default::default()
    };
    let changed = change_database_property_type(&vault, &watcher, &request).unwrap();
    let source_after = fs::read(source_path).unwrap();
    let target_after = fs::read(target_path).unwrap();
    assert_eq!(changed.property_id, property.property_id);
    assert_eq!(changed.operation_id, request.operation_id);
    assert!(changed.inverse_property_id.is_some());
    assert_eq!(changed.manifest_revisions.len(), 2);
    let source_manifest = parse_manifest(&source_after).unwrap();
    let target_manifest = parse_manifest(&target_after).unwrap();
    let source_property = source_manifest
        .value
        .properties
        .iter()
        .find(|candidate| candidate.id() == Some(property.property_id.as_str()))
        .unwrap();
    let source_json = serde_json::to_value(source_property).unwrap();
    let inverse_id = source_json["config"]["inversePropertyId"].as_str().unwrap();
    assert_eq!(source_json["type"], "relation");
    assert_eq!(
        source_json["config"]["targetDatabaseId"],
        target.database_id
    );
    let inverse = target_manifest
        .value
        .properties
        .iter()
        .find(|candidate| candidate.id() == Some(inverse_id))
        .unwrap();
    let inverse_json = serde_json::to_value(inverse).unwrap();
    assert_eq!(inverse_json["name"], "Tasks");
    assert_eq!(
        inverse_json["config"]["inversePropertyId"],
        property.property_id
    );

    let operation_id = request.operation_id.clone().unwrap();
    let journal_path = vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{operation_id}.json"));
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(journal_path).unwrap()).unwrap();
    assert_eq!(journal["status"], "completed");
    assert_eq!(journal["steps"].as_array().unwrap().len(), 2);

    let replay_request = ChangeDatabasePropertyTypeRequest {
        expected_generation: 99,
        ..request.clone()
    };
    let replayed = change_database_property_type(&vault, &watcher, &replay_request).unwrap();
    assert_eq!(replayed, changed);
    assert_eq!(fs::read(source_path).unwrap(), source_after);
    assert_eq!(fs::read(target_path).unwrap(), target_after);

    let mut mismatch = replay_request;
    mismatch.relation_inverse_property_name = Some("Different".to_owned());
    assert!(change_database_property_type(&vault, &watcher, &mismatch).is_err());
    assert_eq!(fs::read(source_path).unwrap(), source_after);
    assert_eq!(fs::read(target_path).unwrap(), target_after);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_empty_text_to_two_way_self_uses_one_manifest_and_reciprocal_ids() {
    let vault = temp_vault();
    let watcher = WatcherState::new();
    let database = create_database(
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
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: database.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&database),
            name: "Subtasks".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let manifest_path = Path::new(&database.manifest_path);
    let request = ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: database.database_id.clone(),
        property_id: property.property_id.clone(),
        expected_manifest_revision: property.manifest_revision,
        property_type: "relation".to_owned(),
        relation_target_database_id: Some(database.database_id.clone()),
        relation_two_way: Some(true),
        relation_inverse_property_name: Some("Parent".to_owned()),
        operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
        ..Default::default()
    };
    let changed = change_database_property_type(&vault, &watcher, &request).unwrap();
    assert_eq!(changed.manifest_revisions.len(), 1);
    assert!(changed.inverse_property_id.is_some());
    let manifest = parse_manifest(&fs::read(manifest_path).unwrap()).unwrap();
    assert_eq!(manifest.value.properties.len(), 2);
    let forward = serde_json::to_value(
        manifest
            .value
            .properties
            .iter()
            .find(|candidate| candidate.id() == Some(property.property_id.as_str()))
            .unwrap(),
    )
    .unwrap();
    let inverse_id = forward["config"]["inversePropertyId"].as_str().unwrap();
    let inverse = serde_json::to_value(
        manifest
            .value
            .properties
            .iter()
            .find(|candidate| candidate.id() == Some(inverse_id))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(inverse["config"]["inversePropertyId"], property.property_id);
    assert_eq!(changed.inverse_property_id.as_deref(), Some(inverse_id));
    let journal_path = vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{}.json", request.operation_id.clone().unwrap()));
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(journal_path).unwrap()).unwrap();
    assert_eq!(journal["steps"].as_array().unwrap().len(), 1);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_existing_one_way_relation_enables_cross_inverse() {
    let (vault, watcher, source, target) = relation_schema_database_pair();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Project".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    let request = ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: source.database_id.clone(),
        property_id: property.property_id.clone(),
        expected_manifest_revision: property.manifest_revision,
        property_type: "relation".to_owned(),
        relation_target_database_id: Some(target.database_id.clone()),
        relation_two_way: Some(true),
        relation_inverse_property_name: Some("Tasks".to_owned()),
        operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
        expected_related_manifest_revisions: vec![DatabaseManifestRevision {
            database_id: target.database_id.clone(),
            revision: current_manifest_revision(&target),
        }],
        ..Default::default()
    };
    let changed = change_database_property_type(&vault, &watcher, &request).unwrap();
    assert_eq!(changed.property_id, property.property_id);
    assert!(changed.inverse_property_id.is_some());
    assert_eq!(changed.manifest_revisions.len(), 2);
    let target_manifest = parse_manifest(&fs::read(&target.manifest_path).unwrap()).unwrap();
    assert_eq!(target_manifest.value.properties.len(), 1);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_disables_cross_inverse_but_preserves_property_and_unknown_metadata() {
    let (vault, watcher, source, target) = relation_schema_database_pair();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Project".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Tasks".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(current_manifest_revision(&target)),
            ..Default::default()
        },
    )
    .unwrap();
    let source_path = Path::new(&source.manifest_path);
    let target_path = Path::new(&target.manifest_path);
    for path in [source_path, target_path] {
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        value["vendorMetadata"] = json!({"preserve": true});
        fs::write(path, json_bytes(&value).unwrap()).unwrap();
    }
    let request = ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: source.database_id.clone(),
        property_id: property.property_id.clone(),
        expected_manifest_revision: current_manifest_revision(&source),
        property_type: "relation".to_owned(),
        relation_target_database_id: Some(target.database_id.clone()),
        relation_two_way: Some(false),
        operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
        expected_related_manifest_revisions: vec![DatabaseManifestRevision {
            database_id: target.database_id.clone(),
            revision: current_manifest_revision(&target),
        }],
        ..Default::default()
    };
    let changed = change_database_property_type(&vault, &watcher, &request).unwrap();
    assert_eq!(changed.property_id, property.property_id);
    assert_eq!(changed.inverse_property_id, None);
    assert_eq!(changed.manifest_revisions.len(), 2);
    let source_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(source_path).unwrap()).unwrap();
    let target_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(target_path).unwrap()).unwrap();
    assert_eq!(source_manifest["vendorMetadata"]["preserve"], true);
    assert_eq!(target_manifest["vendorMetadata"]["preserve"], true);
    let source_property = source_manifest["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|candidate| candidate["id"] == property.property_id)
        .unwrap();
    assert_eq!(source_property["id"], property.property_id);
    assert!(source_property["config"]["inversePropertyId"].is_null());
    let target_properties = target_manifest["properties"].as_array().unwrap();
    assert_eq!(target_properties.len(), 1);
    assert_eq!(
        target_properties[0]["id"],
        property.inverse_property_id.as_deref().unwrap()
    );
    assert_eq!(target_properties[0]["type"], "relation");
    assert_eq!(
        target_properties[0]["config"]["targetDatabaseId"],
        source.database_id
    );
    assert!(target_properties[0]["config"]["inversePropertyId"].is_null());
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_retargets_empty_pair_and_disconnects_old_inverse() {
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
    let old_target = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "Old".to_owned(),
        },
    )
    .unwrap();
    let new_target = create_database(
        &vault,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().to_string()),
            note_path: None,
            name: "New".to_owned(),
        },
    )
    .unwrap();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Project".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(old_target.database_id.clone()),
            relation_max_items: Some(1),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Sources".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(current_manifest_revision(&old_target)),
            ..Default::default()
        },
    )
    .unwrap();
    let source_path = Path::new(&source.manifest_path);
    let request = ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: source.database_id.clone(),
        property_id: property.property_id.clone(),
        expected_manifest_revision: current_manifest_revision(&source),
        property_type: "relation".to_owned(),
        relation_target_database_id: Some(new_target.database_id.clone()),
        relation_inverse_property_name: Some("Sources".to_owned()),
        operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
        expected_related_manifest_revisions: vec![
            DatabaseManifestRevision {
                database_id: old_target.database_id.clone(),
                revision: current_manifest_revision(&old_target),
            },
            DatabaseManifestRevision {
                database_id: new_target.database_id.clone(),
                revision: current_manifest_revision(&new_target),
            },
        ],
        ..Default::default()
    };
    let changed = change_database_property_type(&vault, &watcher, &request).unwrap();
    assert_eq!(changed.manifest_revisions.len(), 3);
    assert_eq!(changed.property_id, property.property_id);
    let source_manifest = parse_manifest(&fs::read(source_path).unwrap()).unwrap();
    let source_json = serde_json::to_value(
        source_manifest
            .value
            .properties
            .iter()
            .find(|candidate| candidate.id() == Some(property.property_id.as_str()))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        source_json["config"]["targetDatabaseId"],
        new_target.database_id
    );
    assert_eq!(source_json["config"]["maxItems"], 1);
    assert!(source_json["config"]["inversePropertyId"].is_string());
    let old_manifest = parse_manifest(&fs::read(&old_target.manifest_path).unwrap()).unwrap();
    let new_manifest = parse_manifest(&fs::read(&new_target.manifest_path).unwrap()).unwrap();
    assert_eq!(old_manifest.value.properties.len(), 1);
    let old_inverse = serde_json::to_value(&old_manifest.value.properties[0]).unwrap();
    assert_eq!(
        old_inverse["id"],
        property.inverse_property_id.as_deref().unwrap()
    );
    assert_eq!(old_inverse["type"], "relation");
    assert_eq!(
        old_inverse["config"]["targetDatabaseId"],
        source.database_id
    );
    assert!(old_inverse["config"]["inversePropertyId"].is_null());
    assert_eq!(new_manifest.value.properties.len(), 1);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_rejects_stale_or_missing_related_manifest_cas_without_writes() {
    for stale in [true, false] {
        let (vault, watcher, source, target) = relation_schema_database_pair();
        let property = create_database_property(
            &vault,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: 1,
                database_id: source.database_id.clone(),
                expected_manifest_revision: current_manifest_revision(&source),
                name: "Project".to_owned(),
                property_type: "relation".to_owned(),
                relation_target_database_id: Some(target.database_id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        let source_path = Path::new(&source.manifest_path);
        let target_path = Path::new(&target.manifest_path);
        let source_before = fs::read(source_path).unwrap();
        let target_before = fs::read(target_path).unwrap();
        let expected_related_manifest_revisions = if stale {
            vec![DatabaseManifestRevision {
                database_id: target.database_id.clone(),
                revision: "0".repeat(64),
            }]
        } else {
            Vec::new()
        };
        let error = change_database_property_type(
            &vault,
            &watcher,
            &ChangeDatabasePropertyTypeRequest {
                expected_generation: 1,
                database_id: source.database_id.clone(),
                property_id: property.property_id,
                expected_manifest_revision: raw_revision(&source_before),
                property_type: "relation".to_owned(),
                relation_target_database_id: Some(target.database_id.clone()),
                relation_two_way: Some(true),
                relation_inverse_property_name: Some("Tasks".to_owned()),
                operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
                expected_related_manifest_revisions,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(error.to_ascii_lowercase().contains("revision"));
        assert_eq!(fs::read(source_path).unwrap(), source_before);
        assert_eq!(fs::read(target_path).unwrap(), target_before);
        let _ = fs::remove_dir_all(vault);
    }
}

#[test]
fn property_type_change_source_yaml_binding_error_precedes_target_planning() {
    let (vault, watcher, source, target) = relation_schema_database_pair();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Status".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let source_path = Path::new(&source.manifest_path);
    let mut source_value: serde_json::Value =
        serde_json::from_slice(&fs::read(source_path).unwrap()).unwrap();
    source_value["properties"][0]["yamlBinding"] = json!({
        "key": "Status",
        "direction": "twoWay",
    });
    fs::write(source_path, json_bytes(&source_value).unwrap()).unwrap();
    let source_before = fs::read(source_path).unwrap();
    let target_path = Path::new(&target.manifest_path);
    let target_before = fs::read(target_path).unwrap();
    let error = change_database_property_type(
        &vault,
        &watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            property_id: property.property_id,
            expected_manifest_revision: raw_revision(&source_before),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Tasks".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: target.database_id,
                revision: raw_revision(&target_before),
            }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(error.to_ascii_lowercase().contains("yaml"));
    assert_eq!(fs::read(source_path).unwrap(), source_before);
    assert_eq!(fs::read(target_path).unwrap(), target_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_formula_dependency_error_precedes_target_planning() {
    let (vault, watcher, source, target) = relation_schema_database_pair();
    let base = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Base".to_owned(),
            property_type: "number".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let formula = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: base.manifest_revision,
            name: "Derived".to_owned(),
            property_type: "formula".to_owned(),
            formula_expression: Some("Base + 1".to_owned()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(formula.name, "Derived");
    let source_path = Path::new(&source.manifest_path);
    let target_path = Path::new(&target.manifest_path);
    let source_before = fs::read(source_path).unwrap();
    let target_before = fs::read(target_path).unwrap();
    let error = change_database_property_type(
        &vault,
        &watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            property_id: base.property_id,
            expected_manifest_revision: raw_revision(&source_before),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Tasks".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: target.database_id,
                revision: raw_revision(&target_before),
            }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(
        error.to_ascii_lowercase().contains("depend")
            || error.to_ascii_lowercase().contains("formula"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(source_path).unwrap(), source_before);
    assert_eq!(fs::read(target_path).unwrap(), target_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_durable_source_values_error_precedes_target_planning() {
    let (vault, watcher, source, target) = relation_schema_database_pair();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Status".to_owned(),
            property_type: "text".to_owned(),
            ..Default::default()
        },
    )
    .unwrap();
    let note_id = ulid::Ulid::generate().to_string();
    let record_path = Path::new(&source.manifest_path)
        .parent()
        .unwrap()
        .join(".ambd/records")
        .join(format!("{note_id}.json"));
    fs::create_dir_all(record_path.parent().unwrap()).unwrap();
    fs::write(
        &record_path,
        serde_json::to_vec_pretty(&json!({
            "format": "amby-database-record",
            "formatVersion": 1,
            "databaseId": source.database_id,
            "noteId": note_id,
            "values": {
                property.property_id.clone(): {"type": "text", "value": "keep"}
            },
            "yamlSyncBases": {}
        }))
        .unwrap(),
    )
    .unwrap();
    let source_path = Path::new(&source.manifest_path);
    let target_path = Path::new(&target.manifest_path);
    let source_before = fs::read(source_path).unwrap();
    let target_before = fs::read(target_path).unwrap();
    let error = change_database_property_type(
        &vault,
        &watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            property_id: property.property_id,
            expected_manifest_revision: raw_revision(&source_before),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Tasks".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: target.database_id,
                revision: raw_revision(&target_before),
            }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(error.to_ascii_lowercase().contains("existing values"));
    assert_eq!(fs::read(source_path).unwrap(), source_before);
    assert_eq!(fs::read(target_path).unwrap(), target_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_rejects_topology_change_with_durable_inverse_values() {
    let (vault, watcher, source, target) = relation_schema_database_pair();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Project".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(true),
            relation_inverse_property_name: Some("Tasks".to_owned()),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_target_manifest_revision: Some(current_manifest_revision(&target)),
            ..Default::default()
        },
    )
    .unwrap();
    let target_manifest = parse_manifest(&fs::read(&target.manifest_path).unwrap()).unwrap();
    let inverse_id = target_manifest.value.properties[0].id().unwrap().to_owned();
    let target_note_id = ulid::Ulid::generate().to_string();
    let record_path = Path::new(&target.manifest_path)
        .parent()
        .unwrap()
        .join(".ambd/records")
        .join(format!("{target_note_id}.json"));
    fs::create_dir_all(record_path.parent().unwrap()).unwrap();
    fs::write(
        &record_path,
        serde_json::to_vec_pretty(&json!({
            "format": "amby-database-record",
            "formatVersion": 1,
            "databaseId": target.database_id,
            "noteId": target_note_id,
            "values": {
                inverse_id: {"type": "relation", "value": [source.database_id]}
            },
            "yamlSyncBases": {}
        }))
        .unwrap(),
    )
    .unwrap();
    let source_path = Path::new(&source.manifest_path);
    let target_path = Path::new(&target.manifest_path);
    let source_before = fs::read(source_path).unwrap();
    let target_before = fs::read(target_path).unwrap();
    let error = change_database_property_type(
        &vault,
        &watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            property_id: property.property_id,
            expected_manifest_revision: raw_revision(&source_before),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_two_way: Some(false),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: target.database_id,
                revision: raw_revision(&target_before),
            }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(
        error.to_ascii_lowercase().contains("value")
            || error.to_ascii_lowercase().contains("durable"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(source_path).unwrap(), source_before);
    assert_eq!(fs::read(target_path).unwrap(), target_before);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_allows_cleared_relation_values_as_empty_sequences() {
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

    let unlinked = update_database_relation_value(
        &fixture.vault,
        &fixture.watcher,
        &relation_request(
            &fixture,
            raw_revision(&fs::read(&fixture.source_note_path).unwrap()),
            Vec::new(),
        ),
        None,
    )
    .unwrap();
    assert_relation_revisions(&unlinked, &fixture);

    // A cleared relation is represented by an empty sequence. Keep the
    // explicit empty form in this fixture even when the lossless value
    // splice removes an empty binding, so schema conversion exercises the
    // empty-value path for both sides of the reciprocal relation.
    for (path, key) in [
        (&fixture.source_note_path, "Related"),
        (&fixture.target_note_path, "Sources"),
    ] {
        let content = fs::read_to_string(path).unwrap();
        let mapping = frontmatter::frontmatter_yaml_mapping(&content)
            .unwrap()
            .unwrap();
        let value = mapping
            .get(&serde_yaml::Value::String(key.to_owned()))
            .cloned()
            .unwrap_or(serde_yaml::Value::Sequence(Vec::new()));
        assert!(matches!(
            value,
            serde_yaml::Value::Sequence(ref items) if items.is_empty()
        ));
        if !mapping.contains_key(&serde_yaml::Value::String(key.to_owned())) {
            let content = frontmatter::replace_yaml_binding_lossless(
                &content,
                key,
                &serde_yaml::Value::Sequence(Vec::new()),
            )
            .unwrap();
            fs::write(path, content).unwrap();
        }
    }

    let target_before_manifest = parse_manifest(&fixture.target_manifest_bytes).unwrap();
    let target_inverse_id = target_before_manifest.value.properties[0]
        .id()
        .unwrap()
        .to_owned();
    let source_manifest_path = fixture.source_manifest_path.clone();
    let target_manifest_path = fixture.target_manifest_path.clone();
    let changed = change_database_property_type(
        &fixture.vault,
        &fixture.watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: fixture.source_database_id.clone(),
            property_id: fixture.source_property_id.clone(),
            expected_manifest_revision: raw_revision(&fs::read(&source_manifest_path).unwrap()),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(
                parse_manifest(&fs::read(&target_manifest_path).unwrap())
                    .unwrap()
                    .value
                    .database_id,
            ),
            relation_two_way: Some(false),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: parse_manifest(&fs::read(&target_manifest_path).unwrap())
                    .unwrap()
                    .value
                    .database_id,
                revision: raw_revision(&fs::read(&target_manifest_path).unwrap()),
            }],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(changed.property_id, fixture.source_property_id);
    assert!(changed.inverse_property_id.is_none());
    let source_manifest = parse_manifest(&fs::read(source_manifest_path).unwrap()).unwrap();
    assert!(source_manifest
        .value
        .properties
        .iter()
        .any(|property| property.id() == Some(fixture.source_property_id.as_str())));
    let target_manifest = parse_manifest(&fs::read(target_manifest_path).unwrap()).unwrap();
    assert_eq!(target_manifest.value.properties.len(), 1);
    let target_inverse = serde_json::to_value(&target_manifest.value.properties[0]).unwrap();
    assert_eq!(target_inverse["id"], target_inverse_id);
    assert_eq!(target_inverse["type"], "relation");
    assert_eq!(
        target_inverse["config"]["targetDatabaseId"],
        fixture.source_database_id
    );
    assert!(target_inverse["config"]["inversePropertyId"].is_null());
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn property_type_change_rejects_nonempty_case_insensitive_trimmed_relation_key() {
    let fixture = relation_fixture();
    let source_content = format!(
        "---\namby-id: {}\n\" related \" : [\"[[{}]]\"]\n---\n# Source\n",
        fixture.source_note_id, fixture.target_note_id
    );
    fs::write(&fixture.source_note_path, &source_content).unwrap();

    let source_before = fs::read(&fixture.source_note_path).unwrap();
    let source_manifest_before = fs::read(&fixture.source_manifest_path).unwrap();
    let target_note_before = fs::read(&fixture.target_note_path).unwrap();
    let target_before = fs::read(&fixture.target_manifest_path).unwrap();
    let operation_id = format!("relation-schema-{}", ulid::Ulid::generate());
    let error = change_database_property_type(
        &fixture.vault,
        &fixture.watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: fixture.source_database_id.clone(),
            property_id: fixture.source_property_id.clone(),
            expected_manifest_revision: raw_revision(&fixture.source_manifest_bytes),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(
                parse_manifest(&fixture.target_manifest_bytes)
                    .unwrap()
                    .value
                    .database_id,
            ),
            relation_two_way: Some(false),
            operation_id: Some(operation_id.clone()),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: parse_manifest(&fixture.target_manifest_bytes)
                    .unwrap()
                    .value
                    .database_id,
                revision: raw_revision(&target_before),
            }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(
        error.to_ascii_lowercase().contains("value")
            || error.to_ascii_lowercase().contains("clear"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(&fixture.source_note_path).unwrap(), source_before);
    assert_eq!(
        fs::read(&fixture.source_manifest_path).unwrap(),
        source_manifest_before
    );
    assert_eq!(
        fs::read(&fixture.target_note_path).unwrap(),
        target_note_before
    );
    assert_eq!(
        fs::read(&fixture.target_manifest_path).unwrap(),
        target_before
    );
    assert!(!fixture
        .vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{operation_id}.json"))
        .exists());
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn property_type_change_rejects_legacy_nonempty_alias_next_to_empty_relation_key() {
    let fixture = relation_fixture();
    let source_content = format!(
        "---\namby-id: {}\nRelated: []\nrelated: [\"[[{}]]\"]\n---\n# Source\n",
        fixture.source_note_id, fixture.target_note_id
    );
    fs::write(&fixture.source_note_path, &source_content).unwrap();

    let source_before = fs::read(&fixture.source_note_path).unwrap();
    let source_manifest_before = fs::read(&fixture.source_manifest_path).unwrap();
    let target_note_before = fs::read(&fixture.target_note_path).unwrap();
    let target_before = fs::read(&fixture.target_manifest_path).unwrap();
    let operation_id = format!("relation-schema-{}", ulid::Ulid::generate());
    let error = change_database_property_type(
        &fixture.vault,
        &fixture.watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: fixture.source_database_id.clone(),
            property_id: fixture.source_property_id.clone(),
            expected_manifest_revision: raw_revision(&fixture.source_manifest_bytes),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(
                parse_manifest(&fixture.target_manifest_bytes)
                    .unwrap()
                    .value
                    .database_id,
            ),
            relation_two_way: Some(false),
            operation_id: Some(operation_id.clone()),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: parse_manifest(&fixture.target_manifest_bytes)
                    .unwrap()
                    .value
                    .database_id,
                revision: raw_revision(&target_before),
            }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(
        error.to_ascii_lowercase().contains("value")
            || error.to_ascii_lowercase().contains("clear"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read(&fixture.source_note_path).unwrap(), source_before);
    assert_eq!(
        fs::read(&fixture.source_manifest_path).unwrap(),
        source_manifest_before
    );
    assert_eq!(
        fs::read(&fixture.target_note_path).unwrap(),
        target_note_before
    );
    assert_eq!(
        fs::read(&fixture.target_manifest_path).unwrap(),
        target_before
    );
    assert!(!fixture
        .vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{operation_id}.json"))
        .exists());
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn property_type_change_blocks_malformed_outer_yaml_but_ignores_nested_values() {
    let fixture = relation_fixture();
    let source_container = Path::new(&fixture.source_manifest_path)
        .parent()
        .unwrap()
        .to_path_buf();
    let nested = create_database(
        &fixture.vault,
        &fixture.watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(source_container.to_string_lossy().to_string()),
            note_path: None,
            name: "Nested".to_owned(),
        },
    )
    .unwrap();
    let nested_note_id = ulid::Ulid::generate().to_string();
    let nested_note_path = Path::new(&nested.manifest_path)
        .parent()
        .unwrap()
        .join("Child.md");
    fs::write(
        &nested_note_path,
        format!(
            "---\namby-id: {nested_note_id}\nRelated: [\"[[{}]]\"]\n---\n# Nested\n",
            fixture.target_note_id
        ),
    )
    .unwrap();

    let target_database_id = parse_manifest(&fixture.target_manifest_bytes)
        .unwrap()
        .value
        .database_id;
    let source_manifest_before = fs::read(&fixture.source_manifest_path).unwrap();
    let target_manifest_before = fs::read(&fixture.target_manifest_path).unwrap();
    let source_revision = raw_revision(&source_manifest_before);
    let target_revision = raw_revision(&target_manifest_before);
    let make_request = |operation_id: String| ChangeDatabasePropertyTypeRequest {
        expected_generation: 1,
        database_id: fixture.source_database_id.clone(),
        property_id: fixture.source_property_id.clone(),
        expected_manifest_revision: source_revision.clone(),
        property_type: "relation".to_owned(),
        relation_target_database_id: Some(target_database_id.clone()),
        relation_two_way: Some(false),
        operation_id: Some(operation_id),
        expected_related_manifest_revisions: vec![DatabaseManifestRevision {
            database_id: target_database_id.clone(),
            revision: target_revision.clone(),
        }],
        ..Default::default()
    };

    let malformed = format!(
        "---\namby-id: {}\nRelated: [\n---\n# Source\n",
        fixture.source_note_id
    );
    fs::write(&fixture.source_note_path, &malformed).unwrap();
    let malformed_operation = format!("relation-schema-{}", ulid::Ulid::generate());
    let error = change_database_property_type(
        &fixture.vault,
        &fixture.watcher,
        &make_request(malformed_operation.clone()),
    )
    .unwrap_err();
    assert!(
        error.to_ascii_lowercase().contains("yaml")
            || error.to_ascii_lowercase().contains("inspect"),
        "unexpected error: {error}"
    );
    assert_eq!(
        fs::read(&fixture.source_manifest_path).unwrap(),
        source_manifest_before
    );
    assert_eq!(
        fs::read(&fixture.target_manifest_path).unwrap(),
        target_manifest_before
    );
    assert!(!fixture
        .vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{malformed_operation}.json"))
        .exists());

    // Once the owned note is safely empty, a nonempty value in the nested
    // database must not be treated as a value belonging to the outer DB.
    let empty = format!(
        "---\namby-id: {}\nRelated: []\n---\n# Source\n",
        fixture.source_note_id
    );
    fs::write(&fixture.source_note_path, empty).unwrap();
    let changed = change_database_property_type(
        &fixture.vault,
        &fixture.watcher,
        &make_request(format!("relation-schema-{}", ulid::Ulid::generate())),
    )
    .unwrap();
    assert_eq!(changed.manifest_revisions.len(), 2);
    let target_after = parse_manifest(&fs::read(&fixture.target_manifest_path).unwrap()).unwrap();
    assert_eq!(target_after.value.properties.len(), 1);
    let target_inverse = serde_json::to_value(&target_after.value.properties[0]).unwrap();
    assert!(target_inverse["config"]["inversePropertyId"].is_null());
    let _ = fs::remove_dir_all(fixture.vault);
}

#[test]
fn property_type_change_one_way_cross_relation_records_readonly_target_revision() {
    let (vault, watcher, source, target) = relation_schema_database_pair();
    let property = create_database_property(
        &vault,
        &watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            name: "Project".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    let target_path = Path::new(&target.manifest_path);
    let target_before = fs::read(target_path).unwrap();
    let operation_id = format!("relation-schema-{}", ulid::Ulid::generate());
    let changed = change_database_property_type(
        &vault,
        &watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: source.database_id.clone(),
            property_id: property.property_id.clone(),
            expected_manifest_revision: current_manifest_revision(&source),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(target.database_id.clone()),
            relation_max_items: Some(1),
            relation_two_way: Some(false),
            operation_id: Some(operation_id.clone()),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: target.database_id.clone(),
                revision: raw_revision(&target_before),
            }],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(changed.manifest_revisions.len(), 1);
    assert_eq!(fs::read(target_path).unwrap(), target_before);
    let journal_path = vault
        .join(".amby/recovery/database_relation_schemas")
        .join(format!("{operation_id}.json"));
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(journal_path).unwrap()).unwrap();
    assert_eq!(journal["steps"].as_array().unwrap().len(), 1);
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn property_type_change_empty_reciprocal_relation_to_text_preserves_inverse_and_unknown_config() {
    let fixture = relation_fixture();
    let source_manifest_path = fixture.source_manifest_path.clone();
    let target_manifest_path = fixture.target_manifest_path.clone();
    let mut source_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&source_manifest_path).unwrap()).unwrap();
    source_value["vendorRoot"] = json!({"keep": "source"});
    let unknown_property_id = ulid::Ulid::generate().to_string();
    source_value["properties"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "type": "futureProperty",
            "id": unknown_property_id,
            "payload": {"keep": [1, 2, 3]}
        }));
    let source_property = source_value["properties"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|property| property["id"] == fixture.source_property_id)
        .unwrap();
    source_property["config"]["vendorMetadata"] = json!({"keep": "relation"});
    fs::write(&source_manifest_path, json_bytes(&source_value).unwrap()).unwrap();

    let mut target_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&target_manifest_path).unwrap()).unwrap();
    let inverse_id = target_value["properties"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    target_value["vendorRoot"] = json!({"keep": "target"});
    target_value["properties"][0]["config"]["vendorMetadata"] = json!({"keep": "inverse"});
    fs::write(&target_manifest_path, json_bytes(&target_value).unwrap()).unwrap();

    let changed = change_database_property_type(
        &fixture.vault,
        &fixture.watcher,
        &ChangeDatabasePropertyTypeRequest {
            expected_generation: 1,
            database_id: fixture.source_database_id.clone(),
            property_id: fixture.source_property_id.clone(),
            expected_manifest_revision: raw_revision(&fs::read(&source_manifest_path).unwrap()),
            property_type: "text".to_owned(),
            relation_target_database_id: Some(
                parse_manifest(&fs::read(&target_manifest_path).unwrap())
                    .unwrap()
                    .value
                    .database_id,
            ),
            relation_two_way: Some(false),
            operation_id: Some(format!("relation-schema-{}", ulid::Ulid::generate())),
            expected_related_manifest_revisions: vec![DatabaseManifestRevision {
                database_id: parse_manifest(&fs::read(&target_manifest_path).unwrap())
                    .unwrap()
                    .value
                    .database_id,
                revision: raw_revision(&fs::read(&target_manifest_path).unwrap()),
            }],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(changed.property_id, fixture.source_property_id);
    assert!(changed.inverse_property_id.is_none());

    let source_after =
        serde_json::from_slice::<serde_json::Value>(&fs::read(&source_manifest_path).unwrap())
            .unwrap();
    assert_eq!(source_after["vendorRoot"], json!({"keep": "source"}));
    let source_property_after = source_after["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|property| property["id"] == fixture.source_property_id)
        .unwrap();
    assert_eq!(source_property_after["type"], "text");
    assert_eq!(
        source_property_after["config"]["vendorMetadata"],
        json!({"keep": "relation"})
    );
    let unknown_property_after = source_after["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|property| property["id"] == unknown_property_id)
        .unwrap();
    assert_eq!(
        unknown_property_after["payload"],
        json!({"keep": [1, 2, 3]})
    );

    let target_after =
        serde_json::from_slice::<serde_json::Value>(&fs::read(&target_manifest_path).unwrap())
            .unwrap();
    assert_eq!(target_after["vendorRoot"], json!({"keep": "target"}));
    let inverse_after = target_after["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|property| property["id"] == inverse_id)
        .unwrap();
    assert_eq!(inverse_after["type"], "relation");
    assert_eq!(
        inverse_after["config"]["targetDatabaseId"],
        fixture.source_database_id
    );
    assert!(inverse_after["config"]["inversePropertyId"].is_null());
    assert_eq!(
        inverse_after["config"]["vendorMetadata"],
        json!({"keep": "inverse"})
    );
    let _ = fs::remove_dir_all(fixture.vault);
}
