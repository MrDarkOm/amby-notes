use super::*;
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

const OUTER_ID: &str = "01J00000000000000000000000";
const INNER_ID: &str = "01J00000000000000000000001";
const FIRST_NOTE_ID: &str = "01J00000000000000000000002";
const SECOND_NOTE_ID: &str = "01J00000000000000000000003";

fn temp_vault(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("amby-discovery-{name}-{nanos}"));
    fs::create_dir_all(&path).unwrap();
    path
}

fn write_manifest(root: &Path, id: &str, name: &str) {
    fs::create_dir_all(root).unwrap();
    fs::write(
        root.join(DATABASE_MANIFEST),
        serde_json::to_vec_pretty(&json!({
            "format": "amby-database",
            "formatVersion": 1,
            "databaseId": id,
            "name": name,
            "locked": false,
            "membership": {"kind": "filesystem-descendants", "recursive": true},
            "properties": [],
            "viewOrder": [],
            "defaultViewId": null,
            "templateOrder": [],
            "defaultTemplateId": null
        }))
        .unwrap(),
    )
    .unwrap();
}

fn write_note(path: &Path, id: &str, title: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, format!("---\namby-id: {id}\n---\n# {title}\n")).unwrap();
}

fn note<'a>(result: &'a DiscoveryResult, path: &str) -> &'a DiscoveredNote {
    result
        .notes
        .iter()
        .find(|note| note.relative_path == path)
        .unwrap()
}

fn has_code(result: &DiscoveryResult, code: DiagnosticCode) -> bool {
    result
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == code)
}

#[test]
fn discovers_attached_and_standalone_ownership_and_categories() {
    let vault = temp_vault("ownership");
    let attached = vault.join("Characters");
    let standalone = vault.join("Tasks");
    write_manifest(&attached, OUTER_ID, "Characters");
    write_manifest(&standalone, INNER_ID, "Tasks");
    write_note(
        &attached.join("Characters.md"),
        FIRST_NOTE_ID,
        "Database page",
    );
    write_note(&attached.join("Alice.md"), SECOND_NOTE_ID, "Alice");
    write_note(&attached.join("Category/Bob.md"), OUTER_ID, "Bob");
    write_note(&standalone.join("Task.md"), FIRST_NOTE_ID, "Task");

    let result = discover_vault(&vault).unwrap();
    assert_eq!(result.databases.len(), 2);
    assert_eq!(result.databases[0].kind, ContainerKind::Attached);
    assert_eq!(result.databases[1].kind, ContainerKind::Standalone);
    assert_eq!(
        note(&result, "Characters/Characters.md").owner_database_id,
        None
    );
    assert_eq!(
        note(&result, "Characters/Alice.md")
            .owner_database_id
            .as_deref(),
        Some(OUTER_ID)
    );
    assert_eq!(
        note(&result, "Characters/Category/Bob.md").category_path,
        vec!["Category"]
    );
    assert_eq!(
        note(&result, "Tasks/Task.md").owner_database_id.as_deref(),
        Some(INNER_ID)
    );
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn nearest_nested_database_owns_subtree_but_attached_main_stays_outer() {
    let vault = temp_vault("nested");
    let outer = vault.join("Outer");
    let inner = outer.join("Inner");
    write_manifest(&outer, OUTER_ID, "Outer");
    write_manifest(&inner, INNER_ID, "Inner");
    write_note(&inner.join("Inner.md"), FIRST_NOTE_ID, "Inner database");
    write_note(&inner.join("Child.md"), SECOND_NOTE_ID, "Child");

    let result = discover_vault(&vault).unwrap();
    assert_eq!(
        note(&result, "Outer/Inner/Inner.md")
            .owner_database_id
            .as_deref(),
        Some(OUTER_ID)
    );
    assert_eq!(
        note(&result, "Outer/Inner/Child.md")
            .owner_database_id
            .as_deref(),
        Some(INNER_ID)
    );
    assert_eq!(
        note(&result, "Outer/Inner/Child.md")
            .parent_note_id
            .as_deref(),
        Some(FIRST_NOTE_ID)
    );
    assert_eq!(note(&result, "Outer/Inner/Child.md").depth, 1);
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn corrupt_nested_manifest_is_a_hard_boundary() {
    let vault = temp_vault("broken-nested");
    let outer = vault.join("Outer");
    let inner = outer.join("Inner");
    write_manifest(&outer, OUTER_ID, "Outer");
    fs::create_dir_all(&inner).unwrap();
    fs::write(inner.join(DATABASE_MANIFEST), b"{not-json").unwrap();
    write_note(&inner.join("Child.md"), FIRST_NOTE_ID, "Child");

    let result = discover_vault(&vault).unwrap();
    assert_eq!(result.databases.len(), 1);
    assert_eq!(
        note(&result, "Outer/Inner/Child.md").owner_database_id,
        None
    );
    assert!(has_code(&result, DiagnosticCode::BrokenManifest));
    assert!(has_code(&result, DiagnosticCode::NestedBoundary));
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn duplicate_ids_titles_and_excluded_service_directories_are_visible() {
    let vault = temp_vault("diagnostics");
    write_manifest(&vault.join("One"), OUTER_ID, "Same");
    write_manifest(&vault.join("Two"), OUTER_ID, "Same");
    write_note(&vault.join("One/A.md"), FIRST_NOTE_ID, "Same note");
    write_note(&vault.join("One/B.md"), FIRST_NOTE_ID, "Same note");
    for directory in SERVICE_DIRECTORIES {
        let hidden = vault.join(directory).join("Hidden.md");
        if let Some(parent) = hidden.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(hidden, "# Hidden").unwrap();
    }

    let result = discover_vault(&vault).unwrap();
    assert_eq!(
        result
            .notes
            .iter()
            .filter(|note| note.relative_path.contains("Hidden"))
            .count(),
        0
    );
    assert!(has_code(&result, DiagnosticCode::DuplicateDatabaseId));
    assert!(has_code(&result, DiagnosticCode::DuplicateDatabaseTitle));
    assert!(has_code(&result, DiagnosticCode::DuplicateNoteId));
    assert!(has_code(&result, DiagnosticCode::DuplicateNoteTitle));
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn orphan_record_shard_and_missing_view_are_diagnosed() {
    let vault = temp_vault("shards");
    let database = vault.join("Database");
    write_manifest(&database, OUTER_ID, "Database");
    write_note(&database.join("Known.md"), FIRST_NOTE_ID, "Known");
    let records = database.join(".ambd/records");
    fs::create_dir_all(&records).unwrap();
    fs::write(
        records.join(format!("{SECOND_NOTE_ID}.json")),
        serde_json::to_vec_pretty(&json!({
            "format": "amby-database-record",
            "formatVersion": 1,
            "databaseId": OUTER_ID,
            "noteId": SECOND_NOTE_ID,
            "values": {}
        }))
        .unwrap(),
    )
    .unwrap();
    let manifest_path = database.join(DATABASE_MANIFEST);
    let mut manifest =
        serde_json::from_slice::<serde_json::Value>(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["viewOrder"] = json!([INNER_ID]);
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();

    let result = discover_vault(&vault).unwrap();
    assert!(has_code(&result, DiagnosticCode::OrphanShard));
    assert!(has_code(&result, DiagnosticCode::MissingShard));
    fs::remove_dir_all(vault).unwrap();
}

#[cfg(unix)]
#[test]
fn symlink_escape_is_diagnosed_without_following_the_link() {
    use std::os::unix::fs::symlink;

    let vault = temp_vault("symlink");
    let outside = temp_vault("symlink-outside");
    write_manifest(&vault.join("Database"), OUTER_ID, "Database");
    write_note(&outside.join("Secret.md"), FIRST_NOTE_ID, "Secret");
    symlink(&outside, vault.join("Database/.ambd")).unwrap();
    let result = discover_vault(&vault).unwrap();
    assert!(has_code(&result, DiagnosticCode::SymlinkEscape));
    assert!(result
        .notes
        .iter()
        .all(|note| !note.relative_path.contains("Secret")));
    fs::remove_dir_all(vault).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

#[test]
fn named_manifest_database_is_discovered_and_preferred_over_legacy() {
    let vault = temp_vault("named-manifest");
    let db_dir = vault.join("Projects");
    fs::create_dir_all(&db_dir).unwrap();

    // 1. Named manifest
    let manifest = json!({
        "format": "amby-database",
        "formatVersion": 1,
        "databaseId": OUTER_ID,
        "name": "Projects",
        "locked": false,
        "membership": {"kind": "filesystem-descendants", "recursive": true},
        "properties": [],
        "viewOrder": [],
        "defaultViewId": null,
        "templateOrder": [],
        "defaultTemplateId": null,
    });
    fs::write(
        db_dir.join("Projects.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();

    // 2. An unrelated JSON file in another folder
    let config_dir = vault.join("Config");
    fs::create_dir_all(&config_dir).unwrap();
    fs::write(config_dir.join("Config.json"), b"{\"unrelated\": true}").unwrap();

    let result = discover_vault(&vault).unwrap();
    assert_eq!(result.databases.len(), 1);
    let db = &result.databases[0];
    assert_eq!(db.database_id, OUTER_ID);
    assert_eq!(db.name, "Projects");
    assert_eq!(
        db.manifest_path,
        vault.canonicalize().unwrap().join("Projects/Projects.json")
    );
    assert!(result.diagnostics.is_empty());

    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn migrates_and_repairs_legacy_database_manifest() {
    let vault = temp_vault("migrate-legacy-db");
    let db_dir = vault.join("Tasks");
    fs::create_dir_all(&db_dir).unwrap();
    let legacy_manifest = json!({
        "format": "amby-database",
        "databaseId": "invalid-non-ulid",
        "name": "Tasks",
        "properties": "not-an-array",
    });
    fs::write(
        db_dir.join("Tasks.json"),
        serde_json::to_vec_pretty(&legacy_manifest).unwrap(),
    )
    .unwrap();

    let migrated = migrate_legacy_database_manifests(&vault).unwrap();
    assert_eq!(migrated, 1);
    assert!(db_dir.join("Tasks.json").exists());

    let content: serde_json::Value =
        serde_json::from_slice(&fs::read(db_dir.join("Tasks.json")).unwrap()).unwrap();
    assert_eq!(content["containerKind"], "standalone");
    assert_eq!(content["name"], "Tasks");
    assert_eq!(content["formatVersion"], 1);
    assert!(content["properties"].is_array());
    assert!(ulid::Ulid::from_string(content["databaseId"].as_str().unwrap()).is_ok());

    let migrated_again = migrate_legacy_database_manifests(&vault).unwrap();
    assert_eq!(migrated_again, 0);

    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn migrate_legacy_database_manifests_reconciles_shard_database_ids() {
    let vault = temp_vault("shard_reconcile");
    let db_dir = vault.join("PaLooVerse");
    fs::create_dir_all(db_dir.join(".ambd/views")).unwrap();
    fs::create_dir_all(db_dir.join(".ambd/records")).unwrap();

    let manifest_id = "01M2NKEGMJY9YHDNTV6HNWDFE6";
    let view_id = "01M1PTZSVFN6EZA2H7ENZ1CSB9";
    let note_id = "01M1Q23EBJDZNPWBC01W513DS0";
    let old_db_id = "01M1PTZSVFTGA864YBJP7TJKXN";

    let manifest = serde_json::json!({
        "format": "amby-database",
        "formatVersion": 1,
        "databaseId": manifest_id,
        "name": "PaLooVerse",
        "containerKind": "standalone",
        "locked": false,
        "membership": {
            "kind": "filesystem-descendants",
            "recursive": true
        },
        "properties": [],
        "viewOrder": [view_id],
        "defaultViewId": view_id,
        "templateOrder": []
    });
    fs::write(
        db_dir.join("PaLooVerse.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();

    let old_view = serde_json::json!({
        "format": "amby-database-view",
        "formatVersion": 1,
        "databaseId": old_db_id,
        "viewId": view_id,
        "name": "Table",
        "layout": "table",
        "openMode": "sidePeek",
        "subitemsMode": "nested",
        "density": "default",
        "fields": [{"field": {"kind": "system", "field": "title"}, "visible": true, "width": null, "frozen": true}],
        "filter": null,
        "sorts": [],
        "group": null,
        "aggregates": []
    });
    fs::write(
        db_dir.join(".ambd/views").join(format!("{view_id}.json")),
        serde_json::to_vec_pretty(&old_view).unwrap(),
    )
    .unwrap();

    let old_record = serde_json::json!({
        "format": "amby-database-record",
        "formatVersion": 1,
        "databaseId": old_db_id,
        "noteId": note_id,
        "values": {}
    });
    fs::write(
        db_dir.join(".ambd/records").join(format!("{note_id}.json")),
        serde_json::to_vec_pretty(&old_record).unwrap(),
    )
    .unwrap();

    // Create the note file so record is owned
    fs::write(
        db_dir.join("Row.md"),
        format!("---\namby-id: {note_id}\n---\n# Row\n"),
    )
    .unwrap();

    migrate_legacy_database_manifests(&vault).unwrap();

    // Check view is now inside PaLooVerse.json with reconciled databaseId
    let manifest_val: serde_json::Value =
        serde_json::from_slice(&fs::read(db_dir.join("PaLooVerse.json")).unwrap()).unwrap();
    let views = manifest_val["views"].as_array().expect("views array");
    assert_eq!(views.len(), 1);
    assert_eq!(views[0]["viewId"], view_id);
    assert_eq!(views[0]["databaseId"], manifest_id);

    // Check view and record shard dirs are deleted
    assert!(!db_dir.join(".ambd/views").exists());
    assert!(!db_dir.join(".ambd/records").exists());

    // Check note frontmatter has note_id
    let note_content = fs::read_to_string(db_dir.join("Row.md")).unwrap();
    assert!(note_content.contains(note_id));

    // Second migration run should be a no-op
    let second_run = migrate_legacy_database_manifests(&vault).unwrap();
    assert_eq!(second_run, 0);

    // Discovery should find zero errors
    let discovery = discover_vault(&vault).unwrap();
    let errors = discovery
        .diagnostics
        .iter()
        .filter(|d| d.severity == DiagnosticSeverity::Error)
        .collect::<Vec<_>>();
    assert!(errors.is_empty(), "Expected 0 errors, got: {:?}", errors);
    assert_eq!(discovery.databases.len(), 1);
    assert_eq!(discovery.databases[0].database_id, manifest_id);

    fs::remove_dir_all(vault).unwrap();
}
