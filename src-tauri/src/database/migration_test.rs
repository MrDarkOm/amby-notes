use super::*;

fn temp_vault() -> PathBuf {
    let path = std::env::temp_dir().join(format!("amby-migration-test-{}", ulid::Ulid::generate()));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn st05_migration_preflight_detects_legacy_shards_and_conflicts() {
    let vault = temp_vault();
    let db_dir = vault.join("LegacyDB");
    fs::create_dir_all(&db_dir).unwrap();

    let db_id = ulid::Ulid::generate().to_string();
    let manifest_json = serde_json::json!({
        "format": "amby-database",
        "formatVersion": 1,
        "databaseId": db_id,
        "name": "LegacyDB",
        "containerKind": "standalone",
        "locked": false,
        "membership": { "kind": "filesystem-descendants", "recursive": true },
        "properties": [
            {
                "type": "text",
                "id": "01J00000000000000000000001",
                "name": "Status",
                "pageVisibility": "alwaysShow",
                "yamlBinding": { "key": "Status", "direction": "twoWay" },
                "config": { "multiline": false }
            }
        ],
        "views": [],
        "templateOrder": []
    });
    fs::write(
        db_dir.join("LegacyDB.json"),
        serde_json::to_vec_pretty(&manifest_json).unwrap(),
    )
    .unwrap();

    let ambd_dir = db_dir.join(".ambd");
    let records_dir = ambd_dir.join("records");
    let views_dir = ambd_dir.join("views");
    fs::create_dir_all(&records_dir).unwrap();
    fs::create_dir_all(&views_dir).unwrap();

    // Add a view shard
    let view_id = ulid::Ulid::generate().to_string();
    let view_json = serde_json::json!({
        "format": "amby-database-view",
        "formatVersion": 1,
        "databaseId": db_id,
        "viewId": view_id,
        "name": "Table View",
        "layout": "table",
        "fields": [],
        "filter": null,
        "sorts": [],
        "group": null
    });
    fs::write(
        views_dir.join(format!("{view_id}.json")),
        serde_json::to_vec_pretty(&view_json).unwrap(),
    )
    .unwrap();

    // Add a note and matching record shard
    let note_id = ulid::Ulid::generate().to_string();
    let note_path = db_dir.join("Task1.md");
    fs::write(
        &note_path,
        format!("---\namby-id: {note_id}\n---\n\nTask body\n"),
    )
    .unwrap();

    let record_json = serde_json::json!({
        "format": "amby-database-record",
        "formatVersion": 1,
        "databaseId": db_id,
        "noteId": note_id,
        "values": {
            "01J00000000000000000000001": {
                "type": "text",
                "value": "In Progress"
            }
        },
        "yamlSyncBases": {}
    });
    fs::write(
        records_dir.join(format!("{note_id}.json")),
        serde_json::to_vec_pretty(&record_json).unwrap(),
    )
    .unwrap();

    // 1. Detection
    let migrations = detect_migrations(&vault).unwrap();
    assert_eq!(migrations.len(), 1);
    assert!(migrations[0].needs_migration);
    assert_eq!(migrations[0].record_shards_count, 1);
    assert_eq!(migrations[0].view_shards_count, 1);

    // 2. Preflight
    let preflight = preflight_migration(&vault, &db_id).unwrap();
    assert!(preflight.can_auto_migrate);
    assert_eq!(preflight.record_shards_count, 1);
    assert_eq!(preflight.view_shards_count, 1);

    // 3. Execution
    let watcher = WatcherState::new();
    let result = execute_migration(&vault, &watcher, &db_id).unwrap();
    assert_eq!(result.migrated_records, 1);
    assert_eq!(result.migrated_views, 1);

    // Verify note frontmatter has Status: In Progress
    let note_after = fs::read_to_string(&note_path).unwrap();
    assert!(
        note_after.contains("Status: In Progress"),
        "Note frontmatter should contain migrated status: {note_after}"
    );

    // Verify manifest contains the view
    let manifest_after = parse_manifest(&fs::read(db_dir.join("LegacyDB.json")).unwrap()).unwrap();
    assert_eq!(manifest_after.value.views.len(), 1);
    assert_eq!(manifest_after.value.views[0].name, "Table View");

    // Verify backup exists
    assert!(Path::new(&result.backup_dir).is_dir());
    assert!(Path::new(&result.backup_dir).join("journal.json").is_file());

    // 4. Rollback
    rollback_migration(&vault, &watcher, &db_id, &result.migration_id).unwrap();
    let note_rolled_back = fs::read_to_string(&note_path).unwrap();
    assert!(
        !note_rolled_back.contains("Status: In Progress"),
        "Note should be rolled back"
    );

    let _ = fs::remove_dir_all(vault);
}
#[test]
fn review_rollback_preserves_newer_user_edit() {
    let vault = temp_vault();
    let db_dir = vault.join("LegacyDB");
    fs::create_dir_all(&db_dir).unwrap();

    let db_id = ulid::Ulid::generate().to_string();
    let manifest_json = serde_json::json!({
        "format": "amby-database",
        "formatVersion": 1,
        "databaseId": db_id,
        "name": "LegacyDB",
        "containerKind": "standalone",
        "locked": false,
        "membership": { "kind": "filesystem-descendants", "recursive": true },
        "properties": [
            {
                "type": "text",
                "id": "01J00000000000000000000001",
                "name": "Status",
                "pageVisibility": "alwaysShow",
                "yamlBinding": { "key": "Status", "direction": "twoWay" },
                "config": { "multiline": false }
            }
        ],
        "views": [],
        "templateOrder": []
    });
    fs::write(
        db_dir.join("LegacyDB.json"),
        serde_json::to_vec_pretty(&manifest_json).unwrap(),
    )
    .unwrap();

    let ambd_dir = db_dir.join(".ambd");
    let records_dir = ambd_dir.join("records");
    let views_dir = ambd_dir.join("views");
    fs::create_dir_all(&records_dir).unwrap();
    fs::create_dir_all(&views_dir).unwrap();

    // Add a view shard
    let view_id = ulid::Ulid::generate().to_string();
    let view_json = serde_json::json!({
        "format": "amby-database-view",
        "formatVersion": 1,
        "databaseId": db_id,
        "viewId": view_id,
        "name": "Table View",
        "layout": "table",
        "fields": [],
        "filter": null,
        "sorts": [],
        "group": null
    });
    fs::write(
        views_dir.join(format!("{view_id}.json")),
        serde_json::to_vec_pretty(&view_json).unwrap(),
    )
    .unwrap();

    // Add a note and matching record shard
    let note_id = ulid::Ulid::generate().to_string();
    let note_path = db_dir.join("Task1.md");
    fs::write(
        &note_path,
        format!("---\namby-id: {note_id}\n---\n\nTask body\n"),
    )
    .unwrap();

    let record_json = serde_json::json!({
        "format": "amby-database-record",
        "formatVersion": 1,
        "databaseId": db_id,
        "noteId": note_id,
        "values": {
            "01J00000000000000000000001": {
                "type": "text",
                "value": "In Progress"
            }
        },
        "yamlSyncBases": {}
    });
    fs::write(
        records_dir.join(format!("{note_id}.json")),
        serde_json::to_vec_pretty(&record_json).unwrap(),
    )
    .unwrap();

    // 1. Detection
    let migrations = detect_migrations(&vault).unwrap();
    assert_eq!(migrations.len(), 1);
    assert!(migrations[0].needs_migration);
    assert_eq!(migrations[0].record_shards_count, 1);
    assert_eq!(migrations[0].view_shards_count, 1);

    // 2. Preflight
    let preflight = preflight_migration(&vault, &db_id).unwrap();
    assert!(preflight.can_auto_migrate);
    assert_eq!(preflight.record_shards_count, 1);
    assert_eq!(preflight.view_shards_count, 1);

    // 3. Execution
    let watcher = WatcherState::new();
    let result = execute_migration(&vault, &watcher, &db_id).unwrap();
    assert_eq!(result.migrated_records, 1);
    assert_eq!(result.migrated_views, 1);

    // Verify note frontmatter has Status: In Progress
    let note_after = fs::read_to_string(&note_path).unwrap();
    assert!(
        note_after.contains("Status: In Progress"),
        "Note frontmatter should contain migrated status: {note_after}"
    );

    // Verify manifest contains the view
    let manifest_after = parse_manifest(&fs::read(db_dir.join("LegacyDB.json")).unwrap()).unwrap();
    assert_eq!(manifest_after.value.views.len(), 1);
    assert_eq!(manifest_after.value.views[0].name, "Table View");

    // Verify backup exists
    assert!(Path::new(&result.backup_dir).is_dir());
    assert!(Path::new(&result.backup_dir).join("journal.json").is_file());

    let newer = format!("{note_after}\nNEW USER CONTENT\n");
    fs::write(&note_path, &newer).unwrap();
    let rollback = rollback_migration(&vault, &watcher, &db_id, &result.migration_id);
    assert_eq!(
        fs::read_to_string(&note_path).unwrap(),
        newer,
        "rollback must preserve post-migration edits (result: {rollback:?})"
    );
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn review_completed_migration_is_not_pending_again() {
    let vault = temp_vault();
    let db_dir = vault.join("LegacyDB");
    fs::create_dir_all(&db_dir).unwrap();

    let db_id = ulid::Ulid::generate().to_string();
    let manifest_json = serde_json::json!({
        "format": "amby-database",
        "formatVersion": 1,
        "databaseId": db_id,
        "name": "LegacyDB",
        "containerKind": "standalone",
        "locked": false,
        "membership": { "kind": "filesystem-descendants", "recursive": true },
        "properties": [
            {
                "type": "text",
                "id": "01J00000000000000000000001",
                "name": "Status",
                "pageVisibility": "alwaysShow",
                "yamlBinding": { "key": "Status", "direction": "twoWay" },
                "config": { "multiline": false }
            }
        ],
        "views": [],
        "templateOrder": []
    });
    fs::write(
        db_dir.join("LegacyDB.json"),
        serde_json::to_vec_pretty(&manifest_json).unwrap(),
    )
    .unwrap();

    let ambd_dir = db_dir.join(".ambd");
    let records_dir = ambd_dir.join("records");
    let views_dir = ambd_dir.join("views");
    fs::create_dir_all(&records_dir).unwrap();
    fs::create_dir_all(&views_dir).unwrap();

    // Add a view shard
    let view_id = ulid::Ulid::generate().to_string();
    let view_json = serde_json::json!({
        "format": "amby-database-view",
        "formatVersion": 1,
        "databaseId": db_id,
        "viewId": view_id,
        "name": "Table View",
        "layout": "table",
        "fields": [],
        "filter": null,
        "sorts": [],
        "group": null
    });
    fs::write(
        views_dir.join(format!("{view_id}.json")),
        serde_json::to_vec_pretty(&view_json).unwrap(),
    )
    .unwrap();

    // Add a note and matching record shard
    let note_id = ulid::Ulid::generate().to_string();
    let note_path = db_dir.join("Task1.md");
    fs::write(
        &note_path,
        format!("---\namby-id: {note_id}\n---\n\nTask body\n"),
    )
    .unwrap();

    let record_json = serde_json::json!({
        "format": "amby-database-record",
        "formatVersion": 1,
        "databaseId": db_id,
        "noteId": note_id,
        "values": {
            "01J00000000000000000000001": {
                "type": "text",
                "value": "In Progress"
            }
        },
        "yamlSyncBases": {}
    });
    fs::write(
        records_dir.join(format!("{note_id}.json")),
        serde_json::to_vec_pretty(&record_json).unwrap(),
    )
    .unwrap();

    // 1. Detection
    let migrations = detect_migrations(&vault).unwrap();
    assert_eq!(migrations.len(), 1);
    assert!(migrations[0].needs_migration);
    assert_eq!(migrations[0].record_shards_count, 1);
    assert_eq!(migrations[0].view_shards_count, 1);

    // 2. Preflight
    let preflight = preflight_migration(&vault, &db_id).unwrap();
    assert!(preflight.can_auto_migrate);
    assert_eq!(preflight.record_shards_count, 1);
    assert_eq!(preflight.view_shards_count, 1);

    // 3. Execution
    let watcher = WatcherState::new();
    let result = execute_migration(&vault, &watcher, &db_id).unwrap();
    assert_eq!(result.migrated_records, 1);
    assert_eq!(result.migrated_views, 1);

    // Verify note frontmatter has Status: In Progress
    let note_after = fs::read_to_string(&note_path).unwrap();
    assert!(
        note_after.contains("Status: In Progress"),
        "Note frontmatter should contain migrated status: {note_after}"
    );

    // Verify manifest contains the view
    let manifest_after = parse_manifest(&fs::read(db_dir.join("LegacyDB.json")).unwrap()).unwrap();
    assert_eq!(manifest_after.value.views.len(), 1);
    assert_eq!(manifest_after.value.views[0].name, "Table View");

    // Verify backup exists
    assert!(Path::new(&result.backup_dir).is_dir());
    assert!(Path::new(&result.backup_dir).join("journal.json").is_file());

    let pending = detect_migrations(&vault).unwrap();
    assert!(
        !pending.iter().any(|m| m.needs_migration),
        "successful migration is still pending: {pending:?}"
    );
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn review2_rollback_preserves_unmigrated_note_edit() {
    let vault = temp_vault();
    let db_dir = vault.join("LegacyDB");
    fs::create_dir_all(&db_dir).unwrap();

    let db_id = ulid::Ulid::generate().to_string();
    let manifest_json = serde_json::json!({
        "format": "amby-database",
        "formatVersion": 1,
        "databaseId": db_id,
        "name": "LegacyDB",
        "containerKind": "standalone",
        "locked": false,
        "membership": { "kind": "filesystem-descendants", "recursive": true },
        "properties": [
            {
                "type": "text",
                "id": "01J00000000000000000000001",
                "name": "Status",
                "pageVisibility": "alwaysShow",
                "yamlBinding": { "key": "Status", "direction": "twoWay" },
                "config": { "multiline": false }
            }
        ],
        "views": [],
        "templateOrder": []
    });
    fs::write(
        db_dir.join("LegacyDB.json"),
        serde_json::to_vec_pretty(&manifest_json).unwrap(),
    )
    .unwrap();

    let ambd_dir = db_dir.join(".ambd");
    let records_dir = ambd_dir.join("records");
    let views_dir = ambd_dir.join("views");
    fs::create_dir_all(&records_dir).unwrap();
    fs::create_dir_all(&views_dir).unwrap();

    // Add a view shard
    let view_id = ulid::Ulid::generate().to_string();
    let view_json = serde_json::json!({
        "format": "amby-database-view",
        "formatVersion": 1,
        "databaseId": db_id,
        "viewId": view_id,
        "name": "Table View",
        "layout": "table",
        "fields": [],
        "filter": null,
        "sorts": [],
        "group": null
    });
    fs::write(
        views_dir.join(format!("{view_id}.json")),
        serde_json::to_vec_pretty(&view_json).unwrap(),
    )
    .unwrap();

    // Add a note and matching record shard
    let note_id = ulid::Ulid::generate().to_string();
    let note_path = db_dir.join("Task1.md");
    fs::write(
        &note_path,
        format!("---\namby-id: {note_id}\n---\n\nTask body\n"),
    )
    .unwrap();

    let record_json = serde_json::json!({
        "format": "amby-database-record",
        "formatVersion": 1,
        "databaseId": db_id,
        "noteId": note_id,
        "values": {
            "01J00000000000000000000001": {
                "type": "text",
                "value": "In Progress"
            }
        },
        "yamlSyncBases": {}
    });
    fs::write(
        records_dir.join(format!("{note_id}.json")),
        serde_json::to_vec_pretty(&record_json).unwrap(),
    )
    .unwrap();

    // 1. Detection
    let migrations = detect_migrations(&vault).unwrap();
    assert_eq!(migrations.len(), 1);
    assert!(migrations[0].needs_migration);
    assert_eq!(migrations[0].record_shards_count, 1);
    assert_eq!(migrations[0].view_shards_count, 1);

    // 2. Preflight
    let preflight = preflight_migration(&vault, &db_id).unwrap();
    assert!(preflight.can_auto_migrate);
    assert_eq!(preflight.record_shards_count, 1);
    assert_eq!(preflight.view_shards_count, 1);

    fs::write(
        &note_path,
        format!("---\namby-id: {note_id}\nStatus: In Progress\n---\n\nTask body\n"),
    )
    .unwrap();
    // 3. Execution
    let watcher = WatcherState::new();
    let result = execute_migration(&vault, &watcher, &db_id).unwrap();
    assert_eq!(result.migrated_records, 0);
    assert_eq!(result.migrated_views, 1);

    // Verify note frontmatter has Status: In Progress
    let note_after = fs::read_to_string(&note_path).unwrap();
    assert!(
        note_after.contains("Status: In Progress"),
        "Note frontmatter should contain migrated status: {note_after}"
    );

    // Verify manifest contains the view
    let manifest_after = parse_manifest(&fs::read(db_dir.join("LegacyDB.json")).unwrap()).unwrap();
    assert_eq!(manifest_after.value.views.len(), 1);
    assert_eq!(manifest_after.value.views[0].name, "Table View");

    // Verify backup exists
    assert!(Path::new(&result.backup_dir).is_dir());
    assert!(Path::new(&result.backup_dir).join("journal.json").is_file());

    let newer = format!("{note_after}\nNEW USER CONTENT\n");
    fs::write(&note_path, &newer).unwrap();
    let rollback = rollback_migration(&vault, &watcher, &db_id, &result.migration_id);
    assert_eq!(
        fs::read_to_string(&note_path).unwrap(),
        newer,
        "rollback must preserve post-migration edits (result: {rollback:?})"
    );
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn review2_legacy_manifest_migration_finishes() {
    let vault = temp_vault();
    let db_dir = vault.join("LegacyDB");
    fs::create_dir_all(&db_dir).unwrap();

    let db_id = ulid::Ulid::generate().to_string();
    let manifest_json = serde_json::json!({
        "format": "amby-database",
        "formatVersion": 1,
        "databaseId": db_id,
        "name": "LegacyDB",
        "containerKind": "standalone",
        "locked": false,
        "membership": { "kind": "filesystem-descendants", "recursive": true },
        "properties": [
            {
                "type": "text",
                "id": "01J00000000000000000000001",
                "name": "Status",
                "pageVisibility": "alwaysShow",
                "yamlBinding": { "key": "Status", "direction": "twoWay" },
                "config": { "multiline": false }
            }
        ],
        "views": [],
        "templateOrder": []
    });
    fs::write(
        db_dir.join("ambd.json"),
        serde_json::to_vec_pretty(&manifest_json).unwrap(),
    )
    .unwrap();

    let ambd_dir = db_dir.join(".ambd");
    let records_dir = ambd_dir.join("records");
    let views_dir = ambd_dir.join("views");
    fs::create_dir_all(&records_dir).unwrap();
    fs::create_dir_all(&views_dir).unwrap();

    // Add a view shard
    let view_id = ulid::Ulid::generate().to_string();
    let view_json = serde_json::json!({
        "format": "amby-database-view",
        "formatVersion": 1,
        "databaseId": db_id,
        "viewId": view_id,
        "name": "Table View",
        "layout": "table",
        "fields": [],
        "filter": null,
        "sorts": [],
        "group": null
    });
    fs::write(
        views_dir.join(format!("{view_id}.json")),
        serde_json::to_vec_pretty(&view_json).unwrap(),
    )
    .unwrap();

    // Add a note and matching record shard
    let note_id = ulid::Ulid::generate().to_string();
    let note_path = db_dir.join("Task1.md");
    fs::write(
        &note_path,
        format!("---\namby-id: {note_id}\n---\n\nTask body\n"),
    )
    .unwrap();

    let record_json = serde_json::json!({
        "format": "amby-database-record",
        "formatVersion": 1,
        "databaseId": db_id,
        "noteId": note_id,
        "values": {
            "01J00000000000000000000001": {
                "type": "text",
                "value": "In Progress"
            }
        },
        "yamlSyncBases": {}
    });
    fs::write(
        records_dir.join(format!("{note_id}.json")),
        serde_json::to_vec_pretty(&record_json).unwrap(),
    )
    .unwrap();

    // 1. Detection
    let migrations = detect_migrations(&vault).unwrap();
    assert_eq!(migrations.len(), 1);
    assert!(migrations[0].needs_migration);
    assert_eq!(migrations[0].record_shards_count, 1);
    assert_eq!(migrations[0].view_shards_count, 1);

    // 2. Preflight
    let preflight = preflight_migration(&vault, &db_id).unwrap();
    assert!(preflight.can_auto_migrate);
    assert_eq!(preflight.record_shards_count, 1);
    assert_eq!(preflight.view_shards_count, 1);

    // 3. Execution
    let watcher = WatcherState::new();
    let result = execute_migration(&vault, &watcher, &db_id).unwrap();
    assert_eq!(result.migrated_records, 1);
    assert_eq!(result.migrated_views, 1);

    // Verify note frontmatter has Status: In Progress
    let note_after = fs::read_to_string(&note_path).unwrap();
    assert!(
        note_after.contains("Status: In Progress"),
        "Note frontmatter should contain migrated status: {note_after}"
    );

    // Verify manifest contains the view
    let manifest_after = parse_manifest(&fs::read(db_dir.join("LegacyDB.json")).unwrap()).unwrap();
    assert_eq!(manifest_after.value.views.len(), 1);
    assert_eq!(manifest_after.value.views[0].name, "Table View");

    // Verify backup exists
    assert!(Path::new(&result.backup_dir).is_dir());
    assert!(Path::new(&result.backup_dir).join("journal.json").is_file());

    let pending = detect_migrations(&vault).unwrap();
    assert!(
        !pending.iter().any(|m| m.needs_migration),
        "successful migration is still pending: {pending:?}"
    );
    let _ = fs::remove_dir_all(vault);
}

#[test]
fn review2_cleanup_preserves_unbacked_files() {
    let vault = temp_vault();
    let db_dir = vault.join("LegacyDB");
    fs::create_dir_all(&db_dir).unwrap();

    let db_id = ulid::Ulid::generate().to_string();
    let manifest_json = serde_json::json!({
        "format": "amby-database",
        "formatVersion": 1,
        "databaseId": db_id,
        "name": "LegacyDB",
        "containerKind": "standalone",
        "locked": false,
        "membership": { "kind": "filesystem-descendants", "recursive": true },
        "properties": [
            {
                "type": "text",
                "id": "01J00000000000000000000001",
                "name": "Status",
                "pageVisibility": "alwaysShow",
                "yamlBinding": { "key": "Status", "direction": "twoWay" },
                "config": { "multiline": false }
            }
        ],
        "views": [],
        "templateOrder": []
    });
    fs::write(
        db_dir.join("LegacyDB.json"),
        serde_json::to_vec_pretty(&manifest_json).unwrap(),
    )
    .unwrap();

    let ambd_dir = db_dir.join(".ambd");
    let records_dir = ambd_dir.join("records");
    let views_dir = ambd_dir.join("views");
    fs::create_dir_all(&records_dir).unwrap();
    fs::create_dir_all(&views_dir).unwrap();

    // Add a view shard
    let view_id = ulid::Ulid::generate().to_string();
    let view_json = serde_json::json!({
        "format": "amby-database-view",
        "formatVersion": 1,
        "databaseId": db_id,
        "viewId": view_id,
        "name": "Table View",
        "layout": "table",
        "fields": [],
        "filter": null,
        "sorts": [],
        "group": null
    });
    fs::write(
        views_dir.join(format!("{view_id}.json")),
        serde_json::to_vec_pretty(&view_json).unwrap(),
    )
    .unwrap();

    // Add a note and matching record shard
    let note_id = ulid::Ulid::generate().to_string();
    let note_path = db_dir.join("Task1.md");
    fs::write(
        &note_path,
        format!("---\namby-id: {note_id}\n---\n\nTask body\n"),
    )
    .unwrap();

    let record_json = serde_json::json!({
        "format": "amby-database-record",
        "formatVersion": 1,
        "databaseId": db_id,
        "noteId": note_id,
        "values": {
            "01J00000000000000000000001": {
                "type": "text",
                "value": "In Progress"
            }
        },
        "yamlSyncBases": {}
    });
    fs::write(
        records_dir.join(format!("{note_id}.json")),
        serde_json::to_vec_pretty(&record_json).unwrap(),
    )
    .unwrap();

    // 1. Detection
    let migrations = detect_migrations(&vault).unwrap();
    assert_eq!(migrations.len(), 1);
    assert!(migrations[0].needs_migration);
    assert_eq!(migrations[0].record_shards_count, 1);
    assert_eq!(migrations[0].view_shards_count, 1);

    // 2. Preflight
    let preflight = preflight_migration(&vault, &db_id).unwrap();
    assert!(preflight.can_auto_migrate);
    assert_eq!(preflight.record_shards_count, 1);
    assert_eq!(preflight.view_shards_count, 1);

    let extra_path = records_dir.join("future-metadata.bin");
    let extra_bytes = b"unknown durable data";
    fs::write(&extra_path, extra_bytes).unwrap();
    // 3. Execution
    let watcher = WatcherState::new();
    let result = execute_migration(&vault, &watcher, &db_id).unwrap();
    assert_eq!(result.migrated_records, 1);
    assert_eq!(result.migrated_views, 1);

    // Verify note frontmatter has Status: In Progress
    let note_after = fs::read_to_string(&note_path).unwrap();
    assert!(
        note_after.contains("Status: In Progress"),
        "Note frontmatter should contain migrated status: {note_after}"
    );

    // Verify manifest contains the view
    let manifest_after = parse_manifest(&fs::read(db_dir.join("LegacyDB.json")).unwrap()).unwrap();
    assert_eq!(manifest_after.value.views.len(), 1);
    assert_eq!(manifest_after.value.views[0].name, "Table View");

    // Verify backup exists
    assert!(Path::new(&result.backup_dir).is_dir());
    assert!(Path::new(&result.backup_dir).join("journal.json").is_file());

    let backup = Path::new(&result.backup_dir).join(".ambd/records/future-metadata.bin");
    let retained = fs::read(&extra_path)
        .ok()
        .or_else(|| fs::read(&backup).ok());
    assert_eq!(
        retained.as_deref(),
        Some(extra_bytes.as_slice()),
        "cleanup deleted a file without backing it up"
    );
    let _ = fs::remove_dir_all(vault);
}
