use super::*;

/// Two databases with a two-way Relation and one note each, ready for a
/// `Task -> Project` value update.
struct TwoWayRelationFixture {
    vault: PathBuf,
    watcher: WatcherState,
    task_path: PathBuf,
    project_path: PathBuf,
    task_id: String,
    project_id: String,
    request: UpdateDatabaseRelationValueRequest,
    original_task: Vec<u8>,
    original_project: Vec<u8>,
}

fn two_way_relation_fixture() -> TwoWayRelationFixture {
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
    TwoWayRelationFixture {
        vault,
        watcher,
        task_path,
        project_path,
        task_id,
        project_id,
        request,
        original_task,
        original_project,
    }
}

/// Post-recovery invariants shared by the in-process matrix and the real
/// process-kill test: the notes agree (both linked or both untouched), no temp
/// files remain, and running recovery again changes nothing.
fn assert_relation_notes_consistent(fixture: &TwoWayRelationFixture, context: &str) {
    crate::database::relation_recovery::recover_pending_relations(&fixture.vault)
        .unwrap_or_else(|error| panic!("recovery failed ({context}): {error}"));
    let task = fs::read(&fixture.task_path).unwrap();
    let project = fs::read(&fixture.project_path).unwrap();
    let task_linked = String::from_utf8_lossy(&task).contains(&fixture.project_id);
    let project_linked = String::from_utf8_lossy(&project).contains(&fixture.task_id);
    assert_eq!(task_linked, project_linked, "notes diverged ({context})");
    if !task_linked {
        assert_eq!(task, fixture.original_task, "{context}");
        assert_eq!(project, fixture.original_project, "{context}");
    }
    for dir in [
        fixture.task_path.parent().unwrap(),
        fixture.project_path.parent().unwrap(),
    ] {
        for entry in fs::read_dir(dir).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            assert!(
                !name.contains(".amby-tmp-"),
                "temp leftover {name} ({context})"
            );
        }
    }
    crate::database::relation_recovery::recover_pending_relations(&fixture.vault).unwrap();
    assert_eq!(
        fs::read(&fixture.task_path).unwrap(),
        task,
        "not idempotent ({context})"
    );
    assert_eq!(
        fs::read(&fixture.project_path).unwrap(),
        project,
        "not idempotent ({context})"
    );
}

/// Failure matrix over the real publish boundaries of a two-way Relation value
/// update (journal create, backups, source write, inverse write, journal
/// progress, completion). For every n-th atomic write, failing either before
/// or right after publication, activation recovery must leave the two notes
/// consistent.
#[test]
fn relation_value_update_failure_matrix_keeps_both_notes_consistent() {
    let mut exercised = 0;
    for after_publish in [false, true] {
        for nth in 1..=40u64 {
            let fixture = two_way_relation_fixture();
            frontmatter::inject_nth_atomic_write_failure(nth, after_publish);
            let result = update_database_relation_value(
                &fixture.vault,
                &fixture.watcher,
                &fixture.request,
                None,
            );
            let calls = frontmatter::clear_atomic_write_failure();
            if calls < nth {
                // The operation finished before reaching this write: matrix complete.
                assert!(result.is_ok(), "no fault injected, operation must succeed");
                let _ = fs::remove_dir_all(&fixture.vault);
                break;
            }
            exercised += 1;
            assert_relation_notes_consistent(
                &fixture,
                &format!("nth={nth}, after_publish={after_publish}"),
            );
            let _ = fs::remove_dir_all(&fixture.vault);
        }
    }
    eprintln!("failure matrix exercised {exercised} boundaries");
    assert!(
        exercised >= 8,
        "matrix exercised only {exercised} boundaries"
    );
}

/// Child half of the process-kill test. It does nothing unless the parent test
/// started it with the crash environment, and then aborts the whole process at
/// the requested write instead of returning an error.
#[test]
fn relation_crash_child() {
    let Ok(request_path) = std::env::var("AMBY_CRASH_REQUEST") else {
        return;
    };
    let vault = PathBuf::from(std::env::var("AMBY_CRASH_VAULT").unwrap());
    let nth: u64 = std::env::var("AMBY_CRASH_NTH").unwrap().parse().unwrap();
    let after = std::env::var("AMBY_CRASH_AFTER").unwrap() == "1";
    let request: UpdateDatabaseRelationValueRequest =
        serde_json::from_slice(&fs::read(request_path).unwrap()).unwrap();
    frontmatter::inject_nth_atomic_write_abort(nth, after);
    let _ = update_database_relation_value(&vault, &WatcherState::new(), &request, None);
}

/// Real process kill: the child aborts mid-operation (no destructors, no
/// error return), then a fresh "activation" must recover consistent notes.
#[test]
fn relation_value_update_survives_real_process_abort_at_each_write() {
    let exe = std::env::current_exe().unwrap();
    let mut killed = 0;
    for after_publish in [false, true] {
        for nth in [1u64, 3, 5, 7, 9, 11] {
            let fixture = two_way_relation_fixture();
            let request_file = fixture.vault.join(".crash-request.json");
            fs::write(&request_file, serde_json::to_vec(&fixture.request).unwrap()).unwrap();
            let status = std::process::Command::new(&exe)
                .args([
                    "--exact",
                    "database::mutations::tests::relation_value_two_way::relation_crash_child",
                    "--test-threads=1",
                    "--nocapture",
                ])
                .env("AMBY_CRASH_REQUEST", &request_file)
                .env("AMBY_CRASH_VAULT", &fixture.vault)
                .env("AMBY_CRASH_NTH", nth.to_string())
                .env("AMBY_CRASH_AFTER", if after_publish { "1" } else { "0" })
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            if !status.success() {
                killed += 1;
            }
            let _ = fs::remove_file(&request_file);
            assert_relation_notes_consistent(
                &fixture,
                &format!("process abort nth={nth}, after_publish={after_publish}"),
            );
            let _ = fs::remove_dir_all(&fixture.vault);
        }
    }
    assert!(killed >= 6, "only {killed} child runs were actually killed");
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
        .get(serde_yaml::Value::String("Subtasks".to_string()))
        .unwrap();
    let par_val = mapping
        .get(serde_yaml::Value::String("Parent".to_string()))
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
