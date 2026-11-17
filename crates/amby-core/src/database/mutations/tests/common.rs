use super::*;

pub(super) fn temp_vault() -> PathBuf {
    let path = std::env::temp_dir().join(format!("amby-db-create-{}", ulid::Ulid::generate()));
    fs::create_dir_all(&path).unwrap();
    path
}

pub(super) fn relation_schema_database_pair(
) -> (PathBuf, WatcherState, CreatedDatabase, CreatedDatabase) {
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

pub(super) fn current_manifest_revision(database: &CreatedDatabase) -> String {
    raw_revision(&fs::read(&database.manifest_path).unwrap())
}

pub(super) struct RelationFixture {
    pub(super) vault: PathBuf,
    pub(super) watcher: WatcherState,
    pub(super) source_database_id: String,
    pub(super) source_note_id: String,
    pub(super) source_property_id: String,
    pub(super) source_note_path: PathBuf,
    pub(super) source_bytes: Vec<u8>,
    pub(super) source_manifest_path: PathBuf,
    pub(super) source_manifest_bytes: Vec<u8>,
    pub(super) target_note_id: String,
    pub(super) target_note_path: PathBuf,
    pub(super) target_bytes: Vec<u8>,
    pub(super) target_manifest_path: PathBuf,
    pub(super) target_manifest_bytes: Vec<u8>,
}

pub(super) fn relation_fixture() -> RelationFixture {
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

pub(super) fn relation_request(
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

pub(super) fn assert_relation_revisions(
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

pub(super) fn option_fixture(
    property_type: &str,
    names: &[&str],
) -> (
    PathBuf,
    WatcherState,
    CreatedDatabase,
    CreatedDatabaseProperty,
) {
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
            name: "Tasks".to_owned(),
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
            name: "Stage".to_owned(),
            property_type: property_type.to_owned(),
            options: names.iter().map(|name| (*name).to_owned()).collect(),
            ..Default::default()
        },
    )
    .unwrap();
    (vault, watcher, created, property)
}

pub(super) fn stored_config(created: &CreatedDatabase, property_id: &str) -> serde_json::Value {
    let parsed = parse_manifest(&fs::read(&created.manifest_path).unwrap()).unwrap();
    let property = parsed
        .value
        .properties
        .iter()
        .find(|property| property.id() == Some(property_id))
        .unwrap();
    serde_json::to_value(property).unwrap()["config"].clone()
}
