use std::fs;

use super::workshop_import::{publish, read_registry, ImportEntry, Registry};

#[test]
fn registry_commit_is_atomic_and_rejects_a_stale_base() {
    let vault = super::create_test::Fixture::new();
    let path = vault.vault.join("amby-imports.json");
    let first = read_registry(&path).unwrap();
    let mut next = Registry::default();
    next.entries.push(ImportEntry {
        operation_id: "batch".into(),
        section_id: "characters".into(),
        note_id: "note".into(),
        title: "Original".into(),
        database_id: None,
        mappings: vec![],
    });
    publish(&path, &first.revision, &next).unwrap();
    let bytes = fs::read(&path).unwrap();
    assert!(publish(&path, &first.revision, &Registry::default()).is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(read_registry(&path).unwrap().value.entries.len(), 1);
}

#[test]
fn failed_publication_keeps_the_previous_bytes() {
    let vault = super::create_test::Fixture::new();
    let path = vault.vault.join("amby-imports.json");
    publish(&path, "", &Registry::default()).unwrap();
    let before = read_registry(&path).unwrap();
    let bytes = fs::read(&path).unwrap();
    crate::atomic_fs::inject_nth_atomic_write_failure(1, false);
    let mut next = before.value;
    next.receipts.insert("new".into(), "receipt".into());
    let result = publish(&path, &before.revision, &next);
    crate::atomic_fs::clear_atomic_write_failure();
    assert!(result.is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[test]
fn previews_both_sources_links_originals_and_undo_keeps_a_later_batch() {
    use std::collections::BTreeMap;

    use super::create::init_workshop;
    use super::index::rebuild_project_index;
    use super::model::InitWorkshopRequest;
    use super::workshop_import::{
        run, ImportAction, ImportSelection, ImportSource, ImportSourceKind, WorkshopImportRequest,
    };
    use crate::database::mutations::{create_database, CreateDatabaseRequest, DatabaseCreateMode};
    use crate::database::projection::rebuild_database_projection;
    use crate::database::rows::{
        create_database_row, CreateDatabaseRowRequest, DatabaseRowTemplate,
    };

    let fixture = super::create_test::Fixture::new();
    let vault = &fixture.vault;
    let workshop = init_workshop(
        &fixture.env(),
        &InitWorkshopRequest {
            expected_generation: 1,
            operation_id: "create-workshop".into(),
            path: "Workshop".into(),
            labels: BTreeMap::from([("preset:role".into(), "Role".into())]),
        },
    )
    .unwrap();
    let database = create_database(
        vault,
        &fixture.watcher,
        &CreateDatabaseRequest {
            expected_generation: 1,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(vault.to_string_lossy().into_owned()),
            note_path: None,
            name: "Entities".into(),
        },
    )
    .unwrap();
    let row = create_database_row(
        vault,
        &fixture.watcher,
        &CreateDatabaseRowRequest {
            expected_generation: 1,
            database_id: database.database_id.clone(),
            title: "Database character".into(),
            template: DatabaseRowTemplate::Empty,
        },
    )
    .unwrap();
    let note_id = ulid::Ulid::generate().to_string();
    let note_bytes =
        format!("\u{feff}---\r\namby-id: {note_id}\r\nRole: Pilot\r\n---\r\nOriginal\r\n");
    fs::create_dir(vault.join("Source")).unwrap();
    let note = vault.join("Source/Character.md");
    fs::write(&note, &note_bytes).unwrap();
    let conn = crate::index::open_connection(vault).unwrap();
    let rebuild = || {
        crate::index::load_vault_read_only(&conn, vault).unwrap();
        rebuild_database_projection(&conn, vault).unwrap();
        rebuild_project_index(&conn, vault).unwrap();
    };
    rebuild();
    let request = |action| WorkshopImportRequest {
        expected_generation: 1,
        workshop_id: workshop.workshop_id.clone(),
        action,
    };
    let folder = ImportSource {
        kind: ImportSourceKind::Folder,
        source_id: "Source".into(),
        section_id: "characters".into(),
    };
    let db = ImportSource {
        kind: ImportSourceKind::Database,
        source_id: database.database_id,
        section_id: "characters".into(),
    };
    let sources = vec![folder.clone(), db];
    let before = fixture.tree();
    let preview = || {
        run(
            &conn,
            vault,
            &request(ImportAction::Preview {
                sources: sources.clone(),
            }),
        )
        .unwrap()
        .preview
        .unwrap()
    };
    let first = preview();
    assert_eq!(fixture.tree(), before, "preview is read only");
    assert_eq!(first.sources[0].suggested.len(), 1);
    assert_eq!(
        first.sources[1].candidates[0].note_id.as_deref(),
        Some(row.note_id.as_str())
    );
    let apply = |revision: String| {
        request(ImportAction::Apply {
            sources: sources.clone(),
            expected_preview: revision,
            operation_id: "combined".into(),
            selection: vec![
                ImportSelection {
                    source_index: 0,
                    note_ids: vec![note_id.clone()],
                    mappings: first.sources[0].suggested.clone(),
                },
                ImportSelection {
                    source_index: 1,
                    note_ids: vec![row.note_id.clone()],
                    mappings: vec![],
                },
            ],
        })
    };
    fs::write(&note, note_bytes.replace("Original", "Edited")).unwrap();
    assert!(matches!(
        run(&conn, vault, &apply(first.revision)),
        Err(super::model::ProjectError::RevisionConflict { .. })
    ));
    assert!(!vault.join("Workshop/amby-imports.json").exists());
    fs::write(&note, &note_bytes).unwrap();
    let apply = apply(preview().revision);
    let result = run(&conn, vault, &apply).unwrap();
    assert_eq!(result.added, 2);
    assert_eq!(result.entries[0].fields[0].value, "Pilot");
    assert_eq!(run(&conn, vault, &apply).unwrap().entries.len(), 2);
    let after = fixture.tree();
    for (path, bytes) in &before {
        assert_eq!(after.get(path), Some(bytes), "{path}");
    }

    let later_source = ImportSource {
        section_id: "locations".into(),
        ..folder
    };
    let later = run(
        &conn,
        vault,
        &request(ImportAction::Preview {
            sources: vec![later_source.clone()],
        }),
    )
    .unwrap()
    .preview
    .unwrap();
    run(
        &conn,
        vault,
        &request(ImportAction::Apply {
            sources: vec![later_source],
            expected_preview: later.revision,
            operation_id: "later".into(),
            selection: vec![ImportSelection {
                source_index: 0,
                note_ids: vec![note_id.clone()],
                mappings: vec![],
            }],
        }),
    )
    .unwrap();

    let renamed = vault.join("Source/Renamed.md");
    fs::rename(&note, &renamed).unwrap();
    rebuild();
    let listed = run(&conn, vault, &request(ImportAction::List)).unwrap();
    assert_eq!(
        listed
            .entries
            .iter()
            .filter(|entry| entry.available && entry.note_id == note_id)
            .count(),
        2
    );
    let undone = run(
        &conn,
        vault,
        &request(ImportAction::Undo {
            operation_id: "combined".into(),
        }),
    )
    .unwrap();
    assert_eq!(undone.entries.len(), 1);
    assert_eq!(undone.entries[0].section_id, "locations");
    assert!(undone.entries[0].available);
    assert_eq!(fs::read(&renamed).unwrap(), note_bytes.as_bytes());
    assert_eq!(
        run(&conn, vault, &apply).unwrap().entries.len(),
        1,
        "retry after undo cannot replay"
    );
}
