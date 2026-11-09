//! The whole path of "a note with properties is moved into a database and the person agrees to carry them
//! over": the real commands' bodies one after another, as the interface calls them, then the rows and the
//! fields the database lists. A failure anywhere on this path leaves the properties in the note.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use crate::commands::database::database_note_context_inner;
use crate::commands::mutations::move_item_inner;
use crate::database::format::raw_revision;
use crate::database::model::{
    DatabasePageRequest, DatabaseQueryRequest, DatabaseQuerySource, DatabaseQuerySpec,
};
use crate::database::mutations::{
    apply_value_batch, create_database, create_database_property, CreateDatabasePropertyRequest,
    CreateDatabaseRequest, DatabaseCreateMode, DatabaseValueBatchRequest, DatabaseValueMutation,
};
use crate::database::projection::{rebuild_database_projection, update_database_values_incremental};
use crate::database::query::query_database;
use crate::database::runtime_state::DatabaseRuntimeState;
use crate::vault_context::VaultContext;
use crate::watcher::WatcherState;
use std::fs;

#[test]
fn a_moved_note_with_properties_is_carried_over_and_listed_by_the_database() {
    let root = std::env::temp_dir().join(format!("amby-migration-flow-{}", ulid::Ulid::generate()));
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let note_id = ulid::Ulid::generate().to_string();
    let original = format!(
        "---\namby-id: {note_id}\nrating: 5\nstatus: draft\nkinds: [one, two]\n---\n\nBody\n"
    );
    fs::write(root.join("Prop note.md"), &original).unwrap();

    let context = VaultContext::new();
    context
        .activate(root.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    let generation = context.generation().unwrap();
    let runtime = DatabaseRuntimeState::default();
    runtime.set_enabled(generation, true);
    let watcher = WatcherState::new();

    // "New database" from the start screen.
    let created = create_database(
        &root,
        &watcher,
        &CreateDatabaseRequest {
            expected_generation: generation,
            mode: DatabaseCreateMode::Standalone,
            parent_path: Some(root.to_string_lossy().to_string()),
            note_path: None,
            name: "Без названия".to_owned(),
        },
    )
    .unwrap();
    context
        .with_active(|active| rebuild_database_projection(&active.connection, &active.root).map(|_| ()))
        .unwrap();

    // The drag of the note into the database folder.
    move_item_inner(
        &context,
        &runtime,
        &watcher,
        &|_, _| {},
        root.join("Prop note.md").to_string_lossy().to_string(),
        root.join("Без названия").to_string_lossy().to_string(),
    )
    .unwrap();
    let before = database_note_context_inner(&context, &runtime, note_id.clone())
        .unwrap()
        .expect("the moved note is a member");

    // The fields, one by one, with the projection rebuilt after each as the command does.
    let mut revision = before.manifest_revision.clone();
    let mut ids = Vec::new();
    for (name, kind, options) in [
        ("status", "select", vec!["draft".to_owned()]),
        ("kinds", "multiSelect", vec!["one".to_owned(), "two".to_owned()]),
        ("rating", "number", Vec::new()),
    ] {
        let property = create_database_property(
            &root,
            &watcher,
            &CreateDatabasePropertyRequest {
                expected_generation: generation,
                database_id: before.database_id.clone(),
                expected_manifest_revision: revision.clone(),
                name: name.to_owned(),
                property_type: kind.to_owned(),
                options,
                ..Default::default()
            },
        )
        .unwrap();
        revision = property.manifest_revision.clone();
        ids.push(property.property_id);
        context
            .with_active(|active| {
                rebuild_database_projection(&active.connection, &active.root).map(|_| ())
            })
            .unwrap();
    }
    let after = database_note_context_inner(&context, &runtime, note_id.clone())
        .unwrap()
        .expect("still a member after the fields were made");
    assert_eq!(after.properties.len(), 3, "the context sees the new fields");

    // The values, with the revision the interface sends (the row revision of the context).
    let status = after.properties.iter().find(|p| p.name == "status").unwrap();
    let option = status.options.iter().find(|o| o.name == "draft").unwrap();
    let batch = DatabaseValueBatchRequest {
        expected_generation: generation,
        database_id: before.database_id.clone(),
        operation_id: format!("property-migration-{}", ulid::Ulid::generate()),
        cells: vec![
            DatabaseValueMutation {
                note_id: note_id.clone(),
                property_id: status.property_id.clone(),
                value_json: Some(format!(r#"{{"type":"select","optionId":"{}"}}"#, option.option_id)),
                expected_revision: before.row.row_revision.clone(),
            },
            DatabaseValueMutation {
                note_id: note_id.clone(),
                property_id: ids[2].clone(),
                value_json: Some(r#"{"type":"number","decimal":"5"}"#.to_owned()),
                expected_revision: before.row.row_revision.clone(),
            },
        ],
    };
    apply_value_batch(&root, &watcher, &batch, None).expect("the value batch is accepted");
    context
        .with_active(|active| {
            update_database_values_incremental(
                &active.connection,
                &active.root,
                &before.database_id,
                std::slice::from_ref(&note_id),
            )
            .map(|_| ())
        })
        .expect("the incremental projection accepts the batch");

    // The note is unchanged (apart from where it lies) and the database lists its row and its fields.
    let moved = fs::read_to_string(root.join("Без названия").join("Prop note.md")).unwrap();
    assert_eq!(moved, original, "the header is byte for byte what it was");
    let listed = context
        .with_active(|active| {
            Ok(query_database(
                &active.connection,
                &DatabaseQueryRequest {
                    expected_generation: generation,
                    database_id: before.database_id.clone(),
                    search: None,
                    sorts: None,
                    filter: None,
                    source: DatabaseQuerySource::Inline {
                        spec: DatabaseQuerySpec {
                            filter: None,
                            sorts: Vec::new(),
                        },
                    },
                    page: DatabasePageRequest {
                        limit: 50,
                        cursor: None,
                    },
                    context_page_id: None,
                    manual_order: None,
                },
            )
            .map_err(|failure| format!("{failure:?}")))
        })
        .unwrap()
        .expect("the database can be queried");
    assert_eq!(listed.rows.len(), 1, "the row is listed");
    // Plain header keys have no recorded look: there is nothing to back up, and that is not a failure.
    context
        .with_active(|active| {
            crate::property_groups::backup_if_any(&active.connection, &active.root, &note_id)
        })
        .expect("a note with no recorded properties has nothing to back up, without an error");
    let _ = (created, raw_revision(b""));
    let _ = fs::remove_dir_all(root);
}
