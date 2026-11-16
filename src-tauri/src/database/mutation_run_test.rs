//! The sequence every database command shares (gate, generation, module switch, lock, refresh,
//! notification) and the warnings it produces. The command bodies are covered by the tests of the
//! operations they call; these pin what only the sequence decides.

use crate::database::model::{DatabaseError, ProjectionVersion};
use crate::database::mutation_run::{
    run_database_exclusive, run_database_mutation, run_database_read, ProjectionOutcome,
    ProjectionWarning,
};
use crate::database::mutations::{create_database, CreateDatabaseRequest, DatabaseCreateMode};
use crate::database::runtime_state::DatabaseRuntimeState;
use crate::database::summary;
use crate::vault_context::VaultContext;
use crate::watcher::WatcherState;
use std::cell::{Cell, RefCell};
use std::fs;

fn open_vault() -> (VaultContext, DatabaseRuntimeState, u64, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("amby-mutation-run-{}", ulid::Ulid::generate()));
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let context = VaultContext::new();
    context
        .activate(root.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    let generation = context.generation().unwrap();
    let runtime = DatabaseRuntimeState::default();
    runtime.set_enabled(generation, true);
    (context, runtime, generation, root)
}

#[test]
fn a_closed_vault_is_reported_and_nothing_runs_or_is_announced() {
    let context = VaultContext::new();
    let runtime = DatabaseRuntimeState::default();
    let ran = Cell::new(false);
    let announced = Cell::new(false);
    let outcome = run_database_mutation(
        &context,
        &runtime,
        Some(1),
        &|_, _: &u8| announced.set(true),
        |_| {
            ran.set(true);
            Ok(1u8)
        },
    );
    assert_eq!(outcome, Err(DatabaseError::VaultNotOpen));
    assert!(!ran.get() && !announced.get());
}

#[test]
fn a_stale_generation_is_a_conflict_that_names_the_actual_one() {
    let (context, runtime, generation, _root) = open_vault();
    let ran = Cell::new(false);
    let outcome = run_database_mutation(
        &context,
        &runtime,
        Some(generation + 1),
        &|_, _: &u8| ran.set(true),
        |_| Ok(1u8),
    );
    assert_eq!(
        outcome,
        Err(DatabaseError::VaultGenerationConflict {
            actual_generation: generation
        })
    );
    assert!(!ran.get());
}

#[test]
fn a_disabled_module_refuses_every_kind_of_run() {
    let (context, runtime, generation, _root) = open_vault();
    runtime.set_enabled(generation, false);
    let mutation = run_database_mutation(
        &context,
        &runtime,
        Some(generation),
        &|_, _: &u8| {},
        |_| Ok(1u8),
    );
    let exclusive = run_database_exclusive(&context, &runtime, None, |_| Ok(1u8));
    let read = run_database_read(&context, &runtime, Some(generation), |_| Ok(1u8));
    assert_eq!(mutation, Err(DatabaseError::ModuleDisabled));
    assert_eq!(exclusive, Err(DatabaseError::ModuleDisabled));
    assert_eq!(read, Err(DatabaseError::ModuleDisabled));
}

#[test]
fn a_success_is_announced_once_with_the_generation_and_the_result_after_the_locks_are_free() {
    let (context, runtime, generation, _root) = open_vault();
    let announced: RefCell<Vec<(u64, String, bool, bool)>> = RefCell::new(Vec::new());
    let outcome = run_database_mutation(
        &context,
        &runtime,
        Some(generation),
        &|seen, result: &String| {
            announced.borrow_mut().push((
                seen,
                result.clone(),
                context.mutation_gate.try_lock().is_ok(),
                context.conn.try_lock().is_ok(),
            ));
        },
        |scope| {
            assert_eq!(scope.generation, generation);
            // Inside the body the gate is held; the vault lock is held by the scope.
            assert!(context.mutation_gate.try_lock().is_err());
            Ok("done".to_owned())
        },
    );
    assert_eq!(outcome.as_deref(), Ok("done"));
    assert_eq!(
        *announced.borrow(),
        vec![(generation, "done".to_owned(), true, true)]
    );
}

#[test]
fn a_failed_body_returns_its_error_unchanged_and_announces_nothing() {
    let (context, runtime, generation, _root) = open_vault();
    let announced = Cell::new(false);
    let outcome: Result<u8, _> = run_database_mutation(
        &context,
        &runtime,
        Some(generation),
        &|_, _| announced.set(true),
        |_| {
            Err(DatabaseError::failed(
                "someFailed",
                "disk is full".to_owned(),
            ))
        },
    );
    assert!(matches!(
        outcome,
        Err(DatabaseError::Failed { ref code, ref message, .. })
            if code == "someFailed" && message == "disk is full"
    ));
    assert!(!announced.get());
}

#[test]
fn undo_and_redo_pass_no_expected_generation() {
    let (context, runtime, generation, _root) = open_vault();
    let result = run_database_mutation(&context, &runtime, None, &|_, _: &u8| {}, |scope| {
        Ok(scope.generation as u8)
    });
    assert_eq!(result, Ok(generation as u8));
}

#[test]
fn a_read_takes_no_mutation_gate_and_an_exclusive_run_does() {
    let (context, runtime, generation, _root) = open_vault();
    run_database_read(&context, &runtime, Some(generation), |_| {
        assert!(context.mutation_gate.try_lock().is_ok());
        Ok(())
    })
    .unwrap();
    run_database_exclusive(&context, &runtime, Some(generation), |_| {
        assert!(context.mutation_gate.try_lock().is_err());
        Ok(())
    })
    .unwrap();
}

#[test]
fn a_published_refresh_sets_the_runtime_version_and_a_failed_one_leaves_it_and_warns() {
    let (context, runtime, generation, root) = open_vault();
    let mut warnings = Vec::new();
    let outcome = run_database_mutation(
        &context,
        &runtime,
        Some(generation),
        &|_, _: &()| {},
        |scope| {
            let before = scope.state().projection;
            assert!(before.is_none());
            scope.rebuild_or_warn(&mut warnings);
            assert!(scope.state().projection.is_some());
            let published = scope.state().projection;
            let failed = scope.publish(Err("boom".to_owned()));
            assert_eq!(failed, ProjectionOutcome::Failed("boom".to_owned()));
            assert_eq!(scope.state().projection, published);
            Ok(())
        },
    );
    assert_eq!(outcome, Ok(()));
    assert!(warnings.is_empty());
    assert!(matches!(
        runtime.state(Some(generation)).projection,
        Some(ProjectionVersion { .. })
    ));
    drop(root);
}

#[test]
fn a_command_body_writes_then_refreshes_through_the_scope() {
    let (context, runtime, generation, root) = open_vault();
    let watcher = WatcherState::new();
    let announced = RefCell::new(Vec::new());
    let created = run_database_mutation(
        &context,
        &runtime,
        Some(generation),
        &|seen, result: &crate::database::mutations::CreatedDatabase| {
            announced
                .borrow_mut()
                .push((seen, result.database_id.clone()));
        },
        |scope| {
            let mut created = create_database(
                &scope.active.root,
                &watcher,
                &CreateDatabaseRequest {
                    expected_generation: generation,
                    mode: DatabaseCreateMode::Standalone,
                    parent_path: Some(root.to_string_lossy().to_string()),
                    note_path: None,
                    name: "Tasks".to_owned(),
                },
            )
            .map_err(|message| DatabaseError::failed("databaseCreateFailed", message))?;
            scope.rebuild_or_warn(&mut created.warnings);
            Ok(created)
        },
    )
    .unwrap();
    assert!(created.warnings.is_empty());
    assert_eq!(
        *announced.borrow(),
        vec![(generation, created.database_id.clone())]
    );
    assert!(runtime.state(Some(generation)).projection.is_some());
    // The summary reads what the refresh published.
    context
        .with_active(|active| {
            let container: String = active
                .connection
                .query_row(
                    "SELECT container_path FROM db_databases WHERE database_id = ?1",
                    [created.database_id.as_str()],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            assert_eq!(
                summary::database_id_for_container(&active.connection, &container)
                    .unwrap()
                    .as_deref(),
                Some(created.database_id.as_str())
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn warnings_keep_their_exact_texts_and_are_recognised_by_kind() {
    assert_eq!(
        ProjectionWarning::ProjectionRebuild.message(),
        "Projection rebuild required"
    );
    assert_eq!(
        ProjectionWarning::NoteIndexRebuild.message(),
        "Note index rebuild required"
    );
    assert_eq!(
        ProjectionWarning::IncrementalUpdate("disk".to_owned()).message(),
        "Incremental projection update required: disk"
    );
    assert!(ProjectionWarning::ProjectionRebuild.is("Projection rebuild required"));
    assert!(!ProjectionWarning::ProjectionRebuild.is("Note index rebuild required"));
    let mut warnings = vec!["other".to_owned()];
    ProjectionWarning::ProjectionRebuild.push_into(&mut warnings);
    assert_eq!(warnings, ["other", "Projection rebuild required"]);
}

#[test]
fn the_summary_lookups_are_empty_for_unknown_ids() {
    let (context, _runtime, _generation, _root) = open_vault();
    context
        .with_active(|active| {
            assert_eq!(
                summary::database_id_for_container(&active.connection, "nowhere").unwrap(),
                None
            );
            assert_eq!(summary::member_database_id(&active.connection, "x"), None);
            assert!(summary::database_properties(&active.connection, "x").is_empty());
            assert!(summary::database_note_context(&active.connection, 1, "x")
                .unwrap()
                .is_none());
            Ok(())
        })
        .unwrap();
}
