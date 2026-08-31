use super::*;
use crate::{frontmatter, vault::*};
use std::{fs, path::PathBuf};
use ulid::Ulid;

fn vault() -> PathBuf {
    let path = std::env::temp_dir().join(format!("amby-identity-{}", Ulid::generate()));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn namespaced_identity_preserves_external_ids_and_indexes_the_body() {
    let root = vault();
    for (name, value) in [
        ("Jira", "jira-123"),
        ("Uuid", "550e8400-e29b-41d4-a716-446655440000"),
        ("Number", "42"),
        ("Null", "null"),
    ] {
        fs::write(
            root.join(format!("{name}.md")),
            format!("---\n# external\nid: {value}\n---\nsearchable #tag"),
        )
        .unwrap();
    }
    let conn = open_connection(&root).unwrap();
    let loaded = load_vault(&conn, &root).unwrap();
    assert_eq!(loaded.notes.len(), 4);
    assert!(loaded.sync.warnings.is_empty());
    for note in loaded.notes {
        let source = fs::read_to_string(&note.path).unwrap();
        assert!(source.starts_with(&format!("---\namby-id: {}\n# external\nid: ", note.id)));
        assert_eq!(
            read_note(&conn, &root, &note.id).unwrap().content,
            "searchable #tag"
        );
    }
    drop(conn);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn namespaced_identity_wins_without_touching_the_external_id() {
    let root = vault();
    let id = Ulid::generate().to_string();
    let original = format!("---\nid: foo\namby-id: {id}\n---\nBody");
    let path = root.join("Note.md");
    fs::write(&path, &original).unwrap();
    let conn = open_connection(&root).unwrap();
    let loaded = load_vault(&conn, &root).unwrap();
    assert_eq!(loaded.notes.len(), 1);
    assert_eq!(loaded.notes[0].id, id);
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    drop(conn);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn namespaced_identity_keeps_invalid_and_duplicate_notes_readable() {
    let root = vault();
    let id = Ulid::generate().to_string();
    let sources = [
        ("A.md", format!("---\namby-id: {id}\n---\nFirst searchable")),
        (
            "B.md",
            format!("---\namby-id: {id}\n---\nSecond searchable"),
        ),
        (
            "Broken.md",
            "---\namby-id: broken\n---\nBroken searchable".into(),
        ),
        ("Null.md", "---\namby-id: null\n---\nNull searchable".into()),
    ];
    for (name, source) in &sources {
        fs::write(root.join(name), source).unwrap();
    }
    let conn = open_connection(&root).unwrap();
    for _ in 0..2 {
        let loaded = load_vault(&conn, &root).unwrap();
        assert_eq!(loaded.notes.len(), 4);
        assert_eq!(loaded.tree.len(), 4);
        assert!(!loaded.sync.warnings.is_empty());
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM notes_fts WHERE notes_fts MATCH 'searchable'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 4);
        for note in &loaded.notes {
            let read = read_note(&conn, &root, &note.id).unwrap();
            assert!(read.content.contains("searchable"));
            assert!(prepare_note_write(&conn, &root, &note.id, "unsafe", &read.revision).is_err());
        }
        for (name, source) in &sources {
            assert_eq!(fs::read_to_string(root.join(name)).unwrap(), *source);
        }
    }
    // Resolving a duplicate must remove its temporary row without a UNIQUE(path)
    // failure, and the other note must regain normal stable-ID behavior.
    let next_id = Ulid::generate().to_string();
    fs::write(
        root.join("B.md"),
        format!("---\namby-id: {next_id}\n---\nResolved searchable"),
    )
    .unwrap();
    let loaded = load_vault(&conn, &root).unwrap();
    assert!(loaded.notes.iter().any(|note| note.id == next_id));
    let read = read_note(&conn, &root, &id).unwrap();
    assert!(prepare_note_write(&conn, &root, &id, "safe", &read.revision).is_ok());
    drop(conn);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn namespaced_identity_migrates_legacy_with_backup_and_exact_rollback() {
    let root = vault();
    let id = Ulid::generate().to_string();
    let original = format!("\u{feff}---\r\n# keep\r\nid: '{id}'\r\n---\r\nBody\n");
    let path = root.join("Legacy.md");
    fs::write(&path, &original).unwrap();
    let conn = open_connection(&root).unwrap();
    let loaded = load_vault(&conn, &root).unwrap();
    assert_ne!(loaded.notes[0].id, id);
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    let preflight = preflight_vault(&root).unwrap();
    assert_eq!(preflight.planned_id_writes, vec!["Legacy.md"]);
    let migration = apply_id_migration(&root).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        original.replacen("---\r\n", &format!("---\r\namby-id: {id}\r\n"), 1)
    );
    assert_eq!(
        frontmatter::read_markdown(&path).unwrap().id.as_deref(),
        Some(id.as_str())
    );
    recover_id_migration(
        &root,
        &migration.journal_path,
        IdMigrationRecoveryAction::Rollback,
    )
    .unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    drop(conn);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn external_canonical_ulid_is_only_a_candidate_in_full_and_incremental_scans() {
    let root = vault();
    let id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    let original = format!("---\n# external system\nid: '{id}'\n---\nsearchable external body");
    let path = root.join("External.md");
    fs::write(&path, &original).unwrap();
    assert_eq!(frontmatter::parse_markdown(&original).note_id(), None);
    let conn = open_connection(&root).unwrap();
    for _ in 0..2 {
        let loaded = load_vault(&conn, &root).unwrap();
        assert_eq!(loaded.notes.len(), 1);
        assert_ne!(loaded.notes[0].id, id);
        assert!(read_note(&conn, &root, &loaded.notes[0].id)
            .unwrap()
            .content
            .contains("external body"));
        assert_eq!(search_notes(&conn, &root, "searchable").unwrap().len(), 1);
        assert_ne!(
            super::note_index::prepare_note_at_path(&conn, &root, &path)
                .unwrap()
                .note_id,
            id
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }
    apply_id_migration(&root).unwrap();
    assert_eq!(load_vault(&conn, &root).unwrap().notes[0].id, id);
    drop(conn);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn namespaced_identity_rollback_refuses_later_body_edits() {
    let root = vault();
    let path = root.join("Note.md");
    fs::write(&path, "original").unwrap();
    let migration = apply_id_migration(&root).unwrap();
    let edited = fs::read_to_string(&path)
        .unwrap()
        .replace("original", "user edited body");
    fs::write(&path, &edited).unwrap();
    assert!(recover_id_migration(
        &root,
        &migration.journal_path,
        IdMigrationRecoveryAction::Rollback
    )
    .is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), edited);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn namespaced_identity_recovers_both_historical_v1_formats_and_pending_files() {
    for format in 0..3 {
        let root = vault();
        let path = root.join("Note.md");
        let id = "01ARZ3NDEKTSV4RRFFQ69G5FAV".to_string();
        let original = "\u{feff}---\r\n# keep\r\ntitle: 'Quoted'\r\n---\r\nBody\n";
        // Independent golden bytes from the two historical writers, not the
        // recovery reconstruction helper being tested.
        let legacy = [
            format!("\u{feff}---\r\nid: {id}\r\n# keep\r\ntitle: 'Quoted'\r\n---\r\nBody\n")
                .into_bytes(),
            format!("\u{feff}---\r\ntitle: Quoted\r\nid: {id}\r\n---\r\nBody\r\n").into_bytes(),
        ];
        let current = legacy
            .get(format)
            .cloned()
            .unwrap_or_else(|| original.as_bytes().to_vec());
        fs::write(&path, &current).unwrap();
        let backup_root = root.join(".amby/backups/legacy");
        fs::create_dir_all(&backup_root).unwrap();
        fs::write(backup_root.join("Note.md"), original).unwrap();
        let journal_path = migration_directory(&root).join("legacy.json");
        let journal = IdMigrationJournal {
            version: 1,
            kind: ID_MIGRATION_KIND.into(),
            created_at_ms: 1,
            backup_path: ".amby/backups/legacy".into(),
            status: IdMigrationStatus::InProgress,
            files: vec![IdMigrationFile {
                path: "Note.md".into(),
                backup_path: "Note.md".into(),
                id: id.clone(),
                status: IdMigrationFileStatus::BackupCreated,
            }],
        };
        write_migration_journal(&journal_path, &journal).unwrap();
        let resumed = recover_id_migration(
            &root,
            journal_path.to_str().unwrap(),
            IdMigrationRecoveryAction::Resume,
        )
        .unwrap();
        assert_eq!(resumed.status, IdMigrationStatus::Completed);
        let persisted = fs::read_to_string(&path).unwrap();
        assert_eq!(
            frontmatter::parse_markdown(&persisted).migration_id(),
            Some(id.as_str())
        );
        if format < 2 {
            assert_eq!(persisted.as_bytes(), current);
        } else {
            assert!(persisted.contains("amby-id:"));
        }
        recover_id_migration(
            &root,
            journal_path.to_str().unwrap(),
            IdMigrationRecoveryAction::Rollback,
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), original.as_bytes());
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn namespaced_identity_incremental_duplicates_do_not_replace_each_other() {
    let root = vault();
    let id = Ulid::generate().to_string();
    let a = root.join("A.md");
    let b = root.join("B.md");
    fs::write(&a, format!("---\namby-id: {id}\n---\nFirst")).unwrap();
    fs::write(&b, format!("---\namby-id: {id}\n---\nSecond")).unwrap();
    let conn = open_connection(&root).unwrap();
    let changes = [&a, &b]
        .into_iter()
        .map(|path| crate::model::PathChange {
            old_path: String::new(),
            new_path: path_string(path),
        })
        .collect::<Vec<_>>();
    index_apply_path_changes(&conn, &root, &changes).unwrap();
    let notes = list_notes(&conn, &root).unwrap();
    assert_eq!(notes.len(), 2);
    assert_ne!(notes[0].id, notes[1].id);
    assert_eq!(
        read_note(&conn, &root, &notes[0].id).unwrap().content,
        "First"
    );
    assert_eq!(
        read_note(&conn, &root, &notes[1].id).unwrap().content,
        "Second"
    );
    assert!(super::identity::ensure_unique_identity(&conn, &id).is_err());
    assert_eq!(load_vault(&conn, &root).unwrap().notes.len(), 2);
    drop(conn);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn namespaced_identity_migration_retains_custom_properties_after_index_rebuild() {
    let root = vault();
    let id = Ulid::generate().to_string();
    let path = root.join("Legacy.md");
    // Seed durable properties from a trusted identity, then simulate an old
    // source file. Generic IDs must not authorize new property writes.
    fs::write(&path, format!("---\namby-id: {id}\n---\nBody")).unwrap();
    let conn = open_connection(&root).unwrap();
    load_vault(&conn, &root).unwrap();
    let saved = crate::property_store::upsert(
        &conn,
        &root,
        &id,
        crate::model::CustomProperty {
            id: String::new(),
            name: "Status".into(),
            icon: String::new(),
            property_type: "text".into(),
            value: "Keep".into(),
            settings: String::new(),
        },
    )
    .unwrap();
    fs::write(&path, format!("---\nid: {id}\n---\nBody")).unwrap();
    apply_id_migration(&root).unwrap();
    drop(conn);
    fs::remove_file(db_path(&root)).unwrap();
    let conn = open_connection(&root).unwrap();
    let loaded = load_vault(&conn, &root).unwrap();
    assert_eq!(loaded.notes[0].id, id);
    crate::property_store::restore_cache(&conn, &root).unwrap();
    assert_eq!(
        note_properties(&conn, &root, &id)
            .unwrap()
            .custom_properties,
        vec![saved]
    );
    drop(conn);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn namespaced_identity_resume_refuses_changes_after_backup() {
    let root = vault();
    let path = root.join("Note.md");
    fs::write(&path, "Original").unwrap();
    fail_next_migration_stage(1);
    assert!(apply_id_migration(&root).is_err());
    let pending = unfinished_id_migrations(&root).unwrap().pop().unwrap();
    fs::write(&path, "External edit after backup").unwrap();
    assert!(recover_id_migration(
        &root,
        &pending.journal_path,
        IdMigrationRecoveryAction::Resume
    )
    .is_err());
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "External edit after backup"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn namespaced_identity_migrated_legacy_body_save_keeps_user_yaml_unchanged() {
    let root = vault();
    let id = Ulid::generate().to_string();
    let path = root.join("Legacy.md");
    let envelope = format!("\u{feff}---\r\n# legacy\r\nid: '{id}'\r\n---\r\n");
    fs::write(&path, format!("{envelope}Original\r\n")).unwrap();
    apply_id_migration(&root).unwrap();
    let envelope = envelope.replacen("---\r\n", &format!("---\r\namby-id: {id}\r\n"), 1);
    let conn = open_connection(&root).unwrap();
    load_vault(&conn, &root).unwrap();
    let read = read_note(&conn, &root, &id).unwrap();
    write_note_filesystem(&conn, &root, &id, "Edited\n", &read.revision).unwrap();
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        format!("{envelope}Edited\r\n")
    );
    drop(conn);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn namespaced_identity_primary_duplicate_repair_rechecks_unchanged_metadata() {
    let root = vault();
    let id = Ulid::generate().to_string();
    let a = root.join("A.md");
    let b = root.join("B.md");
    let source = format!("---\namby-id: {id}\n---\nBody");
    fs::write(&a, &source).unwrap();
    fs::write(&b, &source).unwrap();
    let conn = open_connection(&root).unwrap();
    load_vault(&conn, &root).unwrap();
    let mtime = fs::metadata(&a).unwrap().modified().unwrap();
    let new_id = Ulid::generate().to_string();
    fs::write(&a, source.replace(&id, &new_id)).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&a)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(mtime))
        .unwrap();
    let loaded = load_vault(&conn, &root).unwrap();
    assert_eq!(loaded.notes.len(), 2);
    assert!(loaded.sync.warnings.is_empty());
    assert!(loaded.notes.iter().any(|note| note.id == new_id));
    assert!(loaded.notes.iter().any(|note| note.id == id));
    for note in loaded.notes {
        assert!(super::identity::ensure_unique_identity(&conn, &note.id).is_ok());
    }
    drop(conn);
    fs::remove_dir_all(root).unwrap();
}
