//! Tests of the real write path: every call creates real folders, manifests and
//! structure files in a temporary vault, and faults are injected at each durable
//! boundary of the operation.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::create::{
    clear_step_hook, create_project, create_project_section, set_step_hook, Env, Fault, Step,
};
use super::discovery::discover_projects;
use super::format::parse_project_file;
use super::journal::{journal_dir, read_journal, STATUS_COMPLETED, STATUS_IN_PROGRESS};
use super::model::{
    CreateProjectRequest, CreateProjectSectionRequest, CreatedProject, CreatedSection,
    ProjectError, ProjectKind, PROJECT_FILE_NAME,
};
use super::recovery::recover_pending_projects;
use crate::database::discovery::discover_vault;
use crate::database::format::{parse_manifest, raw_revision};
use crate::watcher::WatcherState;

pub(super) struct Fixture {
    pub(super) vault: PathBuf,
    pub(super) watcher: WatcherState,
}

impl Fixture {
    pub(super) fn new() -> Self {
        let path = std::env::temp_dir().join(format!("amby-project-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&path).unwrap();
        Self {
            vault: path.canonicalize().unwrap(),
            watcher: WatcherState::new(),
        }
    }

    pub(super) fn env(&self) -> Env<'_> {
        Env {
            vault: &self.vault,
            watcher: &self.watcher,
        }
    }

    pub(super) fn create(
        &self,
        request: &CreateProjectRequest,
    ) -> Result<CreatedProject, ProjectError> {
        create_project(&self.env(), request)
    }

    pub(super) fn add_section(
        &self,
        request: &CreateProjectSectionRequest,
    ) -> Result<CreatedSection, ProjectError> {
        create_project_section(&self.env(), request)
    }

    /// Every file and folder outside `.amby`, with file bytes.
    pub(super) fn tree(&self) -> BTreeMap<String, Option<Vec<u8>>> {
        let mut tree = BTreeMap::new();
        for entry in walkdir::WalkDir::new(&self.vault).min_depth(1) {
            let entry = entry.unwrap();
            let relative = entry
                .path()
                .strip_prefix(&self.vault)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if relative == ".amby" || relative.starts_with(".amby/") {
                continue;
            }
            tree.insert(
                relative,
                entry
                    .file_type()
                    .is_file()
                    .then(|| fs::read(entry.path()).unwrap()),
            );
        }
        tree
    }

    pub(super) fn journal_files(&self) -> Vec<String> {
        match fs::read_dir(journal_dir(&self.vault)) {
            Ok(entries) => entries
                .flatten()
                .filter(|entry| entry.path().is_file())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    pub(super) fn project_bytes(&self, folder: &str) -> Vec<u8> {
        fs::read(self.vault.join(folder).join(PROJECT_FILE_NAME)).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        clear_step_hook();
        crate::frontmatter::clear_atomic_write_failure();
        fs::remove_dir_all(&self.vault).ok();
    }
}

pub(super) fn op(label: &str) -> String {
    format!("{label}-{}", ulid::Ulid::generate())
}

pub(super) fn story(name: &str) -> CreateProjectRequest {
    CreateProjectRequest {
        expected_generation: 1,
        operation_id: op("create"),
        kind: ProjectKind::Story,
        name: name.to_owned(),
        parent_path: None,
        icon: None,
        tags: Vec::new(),
        base_sections: true,
        labels: BTreeMap::new(),
        text_levels: None,
    }
}

pub(super) fn section_request(created: &CreatedProject, name: &str) -> CreateProjectSectionRequest {
    CreateProjectSectionRequest {
        expected_generation: 1,
        operation_id: op("section"),
        project_id: created.project_id.clone(),
        expected_project_revision: created.file_revision.clone(),
        name: name.to_owned(),
        role: None,
        group_id: None,
        labels: BTreeMap::new(),
        text_levels: None,
        preset: None,
    }
}

const BASE_NAMES: [&str; 4] = ["Текст", "Заметки", "Персонажи", "Локации"];

fn manifest_id(path: &Path) -> (String, String) {
    let parsed = parse_manifest(&fs::read(path).unwrap()).unwrap();
    (parsed.value.database_id, parsed.value.name)
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

#[test]
fn a_story_gets_its_base_sections_and_the_structure_file_comes_last() {
    let fixture = Fixture::new();
    let vault = fixture.vault.clone();
    let observed = std::rc::Rc::new(std::cell::RefCell::new(Vec::<(String, bool, usize)>::new()));
    let seen = observed.clone();
    set_step_hook(move |step| {
        let file = vault.join("MoleHills").join(PROJECT_FILE_NAME);
        let manifests = BASE_NAMES
            .iter()
            .filter(|name| {
                vault
                    .join("MoleHills")
                    .join(name)
                    .join(format!("{name}.json"))
                    .exists()
            })
            .count();
        seen.borrow_mut()
            .push((format!("{step:?}"), file.exists(), manifests));
        None
    });

    let created = fixture.create(&story("MoleHills")).unwrap();
    clear_step_hook();

    let steps = observed.borrow();
    let before_file = steps
        .iter()
        .find(|(step, _, _)| step == "BeforeProjectFile")
        .unwrap();
    assert_eq!(
        (before_file.1, before_file.2),
        (false, 4),
        "all databases exist, the file does not"
    );
    assert!(steps
        .iter()
        .take_while(|(step, _, _)| step != "ProjectFileWritten")
        .all(|(_, exists, _)| !exists));
    assert!(
        steps
            .iter()
            .find(|(step, _, _)| step == "ProjectFileWritten")
            .unwrap()
            .1
    );

    assert!(!created.replayed);
    assert_eq!(created.path, "MoleHills");
    assert_eq!(created.file_path, "MoleHills/amby-project.json");
    let bytes = fixture.project_bytes("MoleHills");
    assert_eq!(created.file_revision, raw_revision(&bytes));
    let doc = parse_project_file(&bytes).unwrap();
    assert_eq!((doc.format_version, doc.kind), (2, ProjectKind::Story));
    assert_eq!(doc.project_id, created.project_id);
    assert_eq!(
        doc.groups
            .iter()
            .map(|group| group.name.as_str())
            .collect::<Vec<_>>(),
        ["Произведение", "Мир"]
    );
    assert_eq!(
        doc.sections
            .iter()
            .map(|section| (section.id.as_str(), section.group_id.as_deref().unwrap()))
            .collect::<Vec<_>>(),
        [
            ("text", "work"),
            ("notes", "work"),
            ("characters", "world"),
            ("locations", "world")
        ]
    );

    // The sections are real databases the existing discovery finds.
    let databases = discover_vault(&fixture.vault).unwrap();
    assert!(
        databases.diagnostics.is_empty(),
        "{:?}",
        databases.diagnostics
    );
    for (section, name) in created.sections.iter().zip(BASE_NAMES) {
        let manifest = fixture
            .vault
            .join(&section.container_path)
            .join(format!("{name}.json"));
        let (id, title) = manifest_id(&manifest);
        assert_eq!(
            (id.as_str(), title.as_str()),
            (section.database_id.as_str(), name)
        );
        assert_eq!(
            section.manifest_revision,
            raw_revision(&fs::read(&manifest).unwrap())
        );
        assert!(databases
            .databases
            .iter()
            .any(|database| database.database_id == id));
    }
    let discovered = discover_projects(&fixture.vault).unwrap();
    assert_eq!(discovered.projects.len(), 1);
    assert!(discovered.diagnostics.is_empty());
    assert_eq!(fixture.journal_files().len(), 1);
    let journal = read_journal(&fixture.vault, &created.operation_id)
        .unwrap()
        .unwrap();
    assert_eq!(journal.status, STATUS_COMPLETED);
}

#[test]
fn a_universe_gets_characters_and_locations_and_a_plain_collection_none() {
    let fixture = Fixture::new();
    let mut universe = story("Palooverse");
    universe.kind = ProjectKind::Collection;
    let universe = fixture.create(&universe).unwrap();
    assert_eq!(
        universe
            .sections
            .iter()
            .map(|section| section.name.as_str())
            .collect::<Vec<_>>(),
        ["Персонажи", "Локации"]
    );

    let mut plain = story("Одиночные");
    plain.kind = ProjectKind::Collection;
    plain.base_sections = false;
    let plain = fixture.create(&plain).unwrap();
    assert!(plain.sections.is_empty());
    let doc = parse_project_file(&fixture.project_bytes("Одиночные")).unwrap();
    assert!(doc.sections.is_empty() && doc.groups.is_empty());
    assert_eq!(discover_projects(&fixture.vault).unwrap().projects.len(), 2);
}

#[test]
fn labels_rename_base_sections_and_unknown_labels_are_rejected() {
    let fixture = Fixture::new();
    let mut request = story("Saga");
    request.labels = BTreeMap::from([
        ("section:text".to_owned(), "Manuscript".to_owned()),
        ("group:world".to_owned(), "World".to_owned()),
    ]);
    let created = fixture.create(&request).unwrap();
    assert_eq!(created.sections[0].name, "Manuscript");
    assert!(fixture
        .vault
        .join("Saga/Manuscript/Manuscript.json")
        .is_file());
    let doc = parse_project_file(&fixture.project_bytes("Saga")).unwrap();
    assert_eq!(doc.groups[1].name, "World");

    let mut typo = story("Other");
    typo.labels = BTreeMap::from([("section:textt".to_owned(), "x".to_owned())]);
    assert!(matches!(
        fixture.create(&typo),
        Err(ProjectError::InvalidName { .. })
    ));
    assert!(!fixture.vault.join("Other").exists());
}

#[test]
fn a_story_inside_a_collection_belongs_to_it_by_folder_nesting() {
    let fixture = Fixture::new();
    let mut universe = story("Palooverse");
    universe.kind = ProjectKind::Collection;
    let universe = fixture.create(&universe).unwrap();
    let mut inner = story("История первая");
    inner.parent_path = Some(
        fixture
            .vault
            .join("Palooverse")
            .to_string_lossy()
            .to_string(),
    );
    let inner = fixture.create(&inner).unwrap();
    assert_eq!(inner.path, "Palooverse/История первая");

    let discovered = discover_projects(&fixture.vault).unwrap();
    let story_project = discovered
        .projects
        .iter()
        .find(|project| project.doc.project_id == inner.project_id)
        .unwrap();
    assert_eq!(
        story_project.collection_id.as_deref(),
        Some(universe.project_id.as_str())
    );

    // A collection inside a collection is refused before anything is written.
    let before = fixture.tree();
    let mut nested = story("Вложенный");
    nested.kind = ProjectKind::Collection;
    nested.parent_path = Some("Palooverse".to_owned());
    assert!(matches!(
        fixture.create(&nested),
        Err(ProjectError::NestedCollectionUnsupported { ancestor_path }) if ancestor_path == "Palooverse"
    ));
    assert_eq!(fixture.tree(), before);
}

// ---------------------------------------------------------------------------
// Collisions, validation, repeats
// ---------------------------------------------------------------------------

#[test]
fn a_collision_writes_nothing_and_leaves_no_journal() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.vault.join("MoleHills")).unwrap();
    fs::write(fixture.vault.join("MoleHills/keep.txt"), b"mine").unwrap();
    fs::write(fixture.vault.join("File"), b"file").unwrap();
    let before = fixture.tree();
    for name in ["MoleHills", "molehills", "File"] {
        assert!(
            matches!(
                fixture.create(&story(name)),
                Err(ProjectError::PathCollision { .. })
            ),
            "{name}"
        );
    }
    assert_eq!(fixture.tree(), before);
    assert!(fixture.journal_files().is_empty());
}

#[test]
fn invalid_names_parents_and_operation_ids_are_rejected_before_any_write() {
    let fixture = Fixture::new();
    let before = fixture.tree();
    for name in ["", "a/b", ".hidden", "assets", "CON"] {
        assert!(
            matches!(
                fixture.create(&story(name)),
                Err(ProjectError::InvalidName { .. })
            ),
            "{name}"
        );
    }
    let mut parent = story("Ok");
    parent.parent_path = Some(".amby".to_owned());
    assert!(matches!(
        fixture.create(&parent),
        Err(ProjectError::InvalidParent { .. })
    ));
    parent.parent_path = Some("/definitely/elsewhere".to_owned());
    assert!(matches!(
        fixture.create(&parent),
        Err(ProjectError::InvalidParent { .. })
    ));
    parent.parent_path = Some("missing-folder".to_owned());
    assert!(matches!(
        fixture.create(&parent),
        Err(ProjectError::InvalidParent { .. })
    ));
    let mut bad_op = story("Ok");
    bad_op.operation_id = "../escape".to_owned();
    assert_eq!(
        fixture.create(&bad_op),
        Err(ProjectError::InvalidOperationId)
    );
    assert_eq!(fixture.tree(), before);
    assert!(fixture.journal_files().is_empty());
}

#[test]
fn repeating_a_call_returns_the_recorded_answer_and_never_a_second_set() {
    let fixture = Fixture::new();
    let request = story("MoleHills");
    let first = fixture.create(&request).unwrap();
    let before = fixture.tree();

    let again = fixture.create(&request).unwrap();
    assert!(again.replayed);
    assert_eq!(
        CreatedProject {
            replayed: false,
            ..again
        },
        first,
        "same IDs, same revisions"
    );
    assert_eq!(fixture.tree(), before, "a repeat writes nothing");

    // Same ID with another payload is refused, not merged.
    let mut different = request.clone();
    different.tags = vec!["Комикс".to_owned()];
    assert!(matches!(
        fixture.create(&different),
        Err(ProjectError::OperationIdReused { .. })
    ));

    // A fresh intent with the same name is a collision, not a second set.
    assert!(matches!(
        fixture.create(&story("MoleHills")),
        Err(ProjectError::PathCollision { .. })
    ));
    assert_eq!(fixture.tree(), before);
    assert_eq!(discover_projects(&fixture.vault).unwrap().projects.len(), 1);
}

// ---------------------------------------------------------------------------
// Failure and crash at every boundary
// ---------------------------------------------------------------------------

fn all_steps() -> Vec<Step> {
    let mut steps = vec![Step::JournalWritten, Step::FolderCreated];
    for index in 0..4 {
        steps.push(Step::BeforeDatabase(index));
        steps.push(Step::DatabaseCreated(index));
    }
    steps.push(Step::BeforeProjectFile);
    steps.push(Step::ProjectFileWritten);
    steps
}

fn fail_at(target: Step) {
    set_step_hook(move |step| (*step == target).then(|| Fault::Fail("injected".to_owned())));
}

fn crash_at(target: Step) {
    set_step_hook(move |step| (*step == target).then_some(Fault::Crash));
}

fn assert_one_complete_project(fixture: &Fixture, created: &CreatedProject) {
    let discovered = discover_projects(&fixture.vault).unwrap();
    assert_eq!(discovered.projects.len(), 1, "exactly one project");
    assert!(
        discovered.diagnostics.is_empty(),
        "{:?}",
        discovered.diagnostics
    );
    let databases = discover_vault(&fixture.vault).unwrap();
    assert_eq!(databases.databases.len(), 4, "exactly one set of databases");
    assert!(databases.diagnostics.is_empty());
    for section in &created.sections {
        assert!(databases
            .databases
            .iter()
            .any(|database| database.database_id == section.database_id));
    }
}

#[test]
fn a_failure_at_any_step_removes_everything_and_the_retry_creates_one_set() {
    for target in all_steps() {
        let fixture = Fixture::new();
        fs::write(fixture.vault.join("Existing.md"), b"# keep\n").unwrap();
        let before = fixture.tree();
        let request = story("MoleHills");

        fail_at(target.clone());
        let outcome = fixture.create(&request);
        clear_step_hook();

        if target == Step::ProjectFileWritten {
            // The error arrived after the structure file was published: the
            // operation is committed and reported as a success.
            let created = outcome.unwrap_or_else(|error| panic!("{target:?}: {error}"));
            assert_one_complete_project(&fixture, &created);
            continue;
        }
        match outcome {
            Err(ProjectError::RolledBack {
                operation_id,
                message,
            }) => {
                assert_eq!(operation_id, request.operation_id, "{target:?}");
                assert_eq!(message, "injected");
            }
            other => panic!("{target:?}: expected RolledBack, got {other:?}"),
        }
        assert_eq!(fixture.tree(), before, "{target:?}: the vault is as before");
        assert!(
            fixture.journal_files().is_empty(),
            "{target:?}: no stale journal"
        );

        let created = fixture
            .create(&request)
            .unwrap_or_else(|error| panic!("{target:?}: {error}"));
        assert!(!created.replayed);
        assert_one_complete_project(&fixture, &created);
    }
}

#[test]
fn a_crash_at_any_step_is_cleaned_at_activation_and_a_repeat_completes() {
    for target in all_steps() {
        let fixture = Fixture::new();
        fs::write(fixture.vault.join("Existing.md"), b"# keep\n").unwrap();
        let before = fixture.tree();
        let request = story("MoleHills");

        crash_at(target.clone());
        let outcome = fixture.create(&request);
        clear_step_hook();
        assert!(
            matches!(&outcome, Err(ProjectError::Failed { code, .. }) if code == "interrupted"),
            "{target:?}: {outcome:?}"
        );
        // The process died: the journal is still unfinished.
        let journal = read_journal(&fixture.vault, &request.operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(journal.status, STATUS_IN_PROGRESS);

        let report = recover_pending_projects(&fixture.vault).unwrap();
        assert!(report.quarantined.is_empty(), "{target:?}: {report:?}");
        if target == Step::ProjectFileWritten {
            assert_eq!((report.rolled_back, report.completed), (0, 1), "{target:?}");
            assert_eq!(discover_projects(&fixture.vault).unwrap().projects.len(), 1);
        } else {
            assert_eq!((report.rolled_back, report.completed), (1, 0), "{target:?}");
            assert_eq!(
                fixture.tree(),
                before,
                "{target:?}: activation removed our leftovers"
            );
            assert!(fixture.journal_files().is_empty());
        }

        // The same intent repeated: committed work is returned, otherwise it is created once.
        let created = fixture
            .create(&request)
            .unwrap_or_else(|error| panic!("{target:?}: {error}"));
        assert_eq!(
            created.replayed,
            target == Step::ProjectFileWritten,
            "{target:?}"
        );
        assert_one_complete_project(&fixture, &created);
        assert_eq!(
            recover_pending_projects(&fixture.vault).unwrap(),
            Default::default()
        );
    }
}

#[test]
fn a_repeat_after_an_unrecovered_crash_cleans_up_itself_and_reuses_the_ids() {
    let fixture = Fixture::new();
    let request = story("MoleHills");
    crash_at(Step::DatabaseCreated(1));
    assert!(fixture.create(&request).is_err());
    clear_step_hook();
    let planned = read_journal(&fixture.vault, &request.operation_id)
        .unwrap()
        .unwrap();
    assert!(fixture.vault.join("MoleHills/Текст/Текст.json").exists());

    // No activation ran in between.
    let created = fixture.create(&request).unwrap();
    assert!(!created.replayed);
    assert_eq!(created.project_id, planned.plan.project_id);
    assert_eq!(
        created
            .sections
            .iter()
            .map(|section| section.database_id.clone())
            .collect::<Vec<_>>(),
        planned
            .plan
            .sections
            .iter()
            .map(|section| section.database_id.clone())
            .collect::<Vec<_>>()
    );
    assert_one_complete_project(&fixture, &created);
}

#[test]
fn interference_during_the_operation_surfaces_and_the_leftover_is_never_deleted() {
    let fixture = Fixture::new();
    let request = story("MoleHills");
    let blocker = fixture.vault.join("MoleHills/Персонажи");
    let blocker_path = blocker.clone();
    // Another process drops a file where the third database must go.
    set_step_hook(move |step| {
        if *step == Step::BeforeDatabase(2) {
            fs::write(&blocker_path, b"not yours to delete").unwrap();
        }
        None
    });
    let outcome = fixture.create(&request);
    clear_step_hook();

    match outcome {
        Err(ProjectError::RecoveryRequired {
            operation_id,
            message,
        }) => {
            assert_eq!(operation_id, request.operation_id);
            assert!(message.contains("Персонажи"), "{message}");
        }
        other => panic!("expected RecoveryRequired, got {other:?}"),
    }
    assert_eq!(fs::read(&blocker).unwrap(), b"not yours to delete");
    assert!(!fixture
        .vault
        .join("MoleHills")
        .join(PROJECT_FILE_NAME)
        .exists());
    assert!(
        !fixture.vault.join("MoleHills/Текст").exists(),
        "our own databases were removed"
    );
    assert_eq!(
        fixture.journal_files().len(),
        1,
        "the journal is kept as evidence"
    );

    // Once the user clears the way, the same intent finishes.
    fs::remove_file(&blocker).unwrap();
    let created = fixture.create(&request).unwrap();
    assert_one_complete_project(&fixture, &created);
}

#[test]
fn recovery_leaves_databases_the_user_has_changed_and_quarantines_the_journal() {
    let fixture = Fixture::new();
    let request = story("MoleHills");
    crash_at(Step::BeforeProjectFile);
    assert!(fixture.create(&request).is_err());
    clear_step_hook();

    // The user edits one of the new databases before the next activation.
    let manifest = fixture.vault.join("MoleHills/Заметки/Заметки.json");
    let mut edited = fs::read(&manifest).unwrap();
    edited.extend_from_slice(b"\n");
    fs::write(&manifest, &edited).unwrap();

    let report = recover_pending_projects(&fixture.vault).unwrap();
    assert_eq!(report.quarantined.len(), 1, "{report:?}");
    assert_eq!(
        fs::read(&manifest).unwrap(),
        edited,
        "user bytes are untouched"
    );
    assert!(
        !fixture.vault.join("MoleHills/Текст").exists(),
        "untouched ours are removed"
    );
    assert!(
        journal_dir(&fixture.vault)
            .join("quarantine")
            .read_dir()
            .unwrap()
            .count()
            == 1
    );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

fn add_unknown_fields(fixture: &Fixture, folder: &str, with_bom: bool) -> String {
    let path = fixture.vault.join(folder).join(PROJECT_FILE_NAME);
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    value["x-other-app"] = serde_json::json!({"keep": [1, 2, 3]});
    value["sections"][0]["x-note"] = serde_json::json!("hand written");
    let mut bytes = Vec::new();
    if with_bom {
        bytes.extend_from_slice(b"\xEF\xBB\xBF");
    }
    bytes.extend(serde_json::to_vec_pretty(&value).unwrap());
    bytes.push(b'\n');
    fs::write(&path, &bytes).unwrap();
    raw_revision(&bytes)
}

#[test]
fn a_section_is_added_through_a_snapshot_keeping_unknown_fields_and_the_bom() {
    let fixture = Fixture::new();
    let created = fixture.create(&story("MoleHills")).unwrap();
    let revision = add_unknown_fields(&fixture, "MoleHills", true);
    let mut request = section_request(&created, "Организации");
    request.expected_project_revision = revision;
    request.group_id = Some("world".to_owned());

    let added = fixture.add_section(&request).unwrap();
    assert_eq!(added.section.name, "Организации");
    assert!(added.section.section_id.starts_with("sec_"));
    assert_eq!(added.section.container_path, "MoleHills/Организации");

    let bytes = fixture.project_bytes("MoleHills");
    assert!(bytes.starts_with(b"\xEF\xBB\xBF"), "the BOM stays");
    assert_eq!(added.project_revision, raw_revision(&bytes));
    let document: serde_json::Value = serde_json::from_slice(&bytes[3..]).unwrap();
    assert_eq!(
        document["x-other-app"]["keep"],
        serde_json::json!([1, 2, 3])
    );
    assert_eq!(document["sections"][0]["x-note"], "hand written");
    assert_eq!(document["sections"].as_array().unwrap().len(), 5);
    let doc = parse_project_file(&bytes).unwrap();
    let section = doc.sections.last().unwrap();
    assert_eq!(
        (
            section.id.as_str(),
            section.group_id.as_deref(),
            section.role.as_deref(),
            section.path_hint.as_str()
        ),
        (
            added.section.section_id.as_str(),
            Some("world"),
            None,
            "Организации"
        )
    );
    assert_eq!(
        manifest_id(&fixture.vault.join("MoleHills/Организации/Организации.json")).0,
        added.section.database_id
    );
    // The previous structure file was snapshotted before the replacement.
    let history = fixture.vault.join(".amby");
    assert!(
        walkdir::WalkDir::new(history)
            .into_iter()
            .flatten()
            .any(|entry| entry.path().to_string_lossy().contains("history")),
        "a history snapshot exists"
    );

    // A repeat of the same call is a replay and changes nothing.
    let before = fixture.tree();
    let again = fixture.add_section(&request).unwrap();
    assert!(again.replayed);
    assert_eq!(
        CreatedSection {
            replayed: false,
            ..again
        },
        added
    );
    assert_eq!(fixture.tree(), before);
}

#[test]
fn a_section_request_is_checked_before_anything_is_created() {
    let fixture = Fixture::new();
    let created = fixture.create(&story("MoleHills")).unwrap();
    let before = fixture.tree();

    let mut stale = section_request(&created, "Организации");
    stale.expected_project_revision = "0".repeat(64);
    assert!(matches!(
        fixture.add_section(&stale),
        Err(ProjectError::RevisionConflict { .. })
    ));

    for name in ["Текст", "текст", "Заметки"] {
        assert!(
            matches!(
                fixture.add_section(&section_request(&created, name)),
                Err(ProjectError::PathCollision { .. })
            ),
            "{name}"
        );
    }
    let mut group = section_request(&created, "Организации");
    group.group_id = Some("nowhere".to_owned());
    assert!(matches!(
        fixture.add_section(&group),
        Err(ProjectError::UnknownGroup { .. })
    ));
    let mut role = section_request(&created, "Организации");
    role.role = Some("galaxy".to_owned());
    assert!(matches!(
        fixture.add_section(&role),
        Err(ProjectError::UnsupportedRole { .. })
    ));
    role.role = Some("text".to_owned());
    assert!(
        matches!(
            fixture.add_section(&role),
            Err(ProjectError::UnsupportedRole { .. })
        ),
        "one text section"
    );
    let mut missing = section_request(&created, "Организации");
    missing.project_id = "no-such-project".to_owned();
    assert!(matches!(
        fixture.add_section(&missing),
        Err(ProjectError::ProjectNotFound { .. })
    ));
    assert!(matches!(
        fixture.add_section(&section_request(&created, "a/b")),
        Err(ProjectError::InvalidName { .. })
    ));

    assert_eq!(fixture.tree(), before);
    assert_eq!(
        fixture.journal_files().len(),
        1,
        "only the project's own journal"
    );
}

#[test]
fn an_anchors_section_is_a_known_role_and_is_kept_in_the_structure_file() {
    let fixture = Fixture::new();
    let created = fixture.create(&story("MoleHills")).unwrap();
    let mut request = section_request(&created, "Якоря");
    request.role = Some("anchors".to_owned());

    let added = fixture.add_section(&request).unwrap();
    let doc = parse_project_file(&fixture.project_bytes("MoleHills")).unwrap();
    let section = doc.sections.last().unwrap();
    assert_eq!(section.id, added.section.section_id);
    assert_eq!(section.role.as_deref(), Some("anchors"));
    assert_eq!(section.path_hint, "Якоря");
}

#[test]
fn a_failure_or_crash_while_adding_a_section_keeps_the_structure_file_intact() {
    let steps = [
        Step::JournalWritten,
        Step::BeforeDatabase(0),
        Step::DatabaseCreated(0),
        Step::BeforeProjectFile,
        Step::ProjectFileWritten,
    ];
    for crash in [false, true] {
        for target in &steps {
            let fixture = Fixture::new();
            let created = fixture.create(&story("MoleHills")).unwrap();
            let original = fixture.project_bytes("MoleHills");
            let before = fixture.tree();
            let request = section_request(&created, "Организации");

            if crash {
                crash_at(target.clone());
            } else {
                fail_at(target.clone());
            }
            let outcome = fixture.add_section(&request);
            clear_step_hook();
            if crash {
                assert!(outcome.is_err());
                recover_pending_projects(&fixture.vault).unwrap();
            }
            let committed = *target == Step::ProjectFileWritten;
            if committed {
                assert!(crash || outcome.is_ok(), "{target:?}: {outcome:?}");
                let doc = parse_project_file(&fixture.project_bytes("MoleHills")).unwrap();
                assert_eq!(doc.sections.len(), 5);
            } else {
                assert!(
                    crash || matches!(outcome, Err(ProjectError::RolledBack { .. })),
                    "{target:?}: {outcome:?}"
                );
                assert_eq!(fixture.project_bytes("MoleHills"), original, "{target:?}");
                assert_eq!(
                    fixture.tree(),
                    before,
                    "{target:?}: no database left behind"
                );
            }
            // Repeating the intent ends in exactly one new section.
            let done = fixture.add_section(&request).unwrap();
            assert_eq!(done.replayed, committed, "{target:?} crash={crash}");
            let doc = parse_project_file(&fixture.project_bytes("MoleHills")).unwrap();
            assert_eq!(doc.sections.len(), 5, "{target:?}");
            assert_eq!(
                doc.sections
                    .iter()
                    .filter(|section| section.path_hint == "Организации")
                    .count(),
                1
            );
        }
    }
}

#[test]
fn failing_the_real_atomic_replacement_either_rolls_back_or_commits_never_halves() {
    for nth in 1..=4 {
        for after_publish in [false, true] {
            let fixture = Fixture::new();
            let created = fixture.create(&story("MoleHills")).unwrap();
            let original = fixture.project_bytes("MoleHills");
            let request = section_request(&created, "Организации");

            crate::frontmatter::inject_nth_atomic_write_failure(nth, after_publish);
            let outcome = fixture.add_section(&request);
            crate::frontmatter::clear_atomic_write_failure();

            let doc = parse_project_file(&fixture.project_bytes("MoleHills")).unwrap();
            let container = fixture.vault.join("MoleHills/Организации");
            match outcome {
                Ok(added) => {
                    assert_eq!(doc.sections.len(), 5, "nth={nth} after={after_publish}");
                    assert_eq!(added.project_revision, doc.revision);
                    assert!(container.join("Организации.json").is_file());
                }
                Err(ProjectError::RolledBack { .. }) => {
                    assert_eq!(
                        fixture.project_bytes("MoleHills"),
                        original,
                        "nth={nth} after={after_publish}"
                    );
                    assert!(!container.exists(), "nth={nth} after={after_publish}");
                }
                Err(other) => panic!("nth={nth} after={after_publish}: {other:?}"),
            }
        }
    }
}

#[test]
fn a_concurrent_edit_of_the_structure_file_wins_over_the_section_write() {
    let fixture = Fixture::new();
    let created = fixture.create(&story("MoleHills")).unwrap();
    let path = fixture.vault.join("MoleHills").join(PROJECT_FILE_NAME);
    let edited = {
        let mut bytes = fs::read(&path).unwrap();
        bytes.extend_from_slice(b"\n");
        bytes
    };
    let edit_path = path.clone();
    let edit_bytes = edited.clone();
    // The user saves the file between the preflight and the write.
    set_step_hook(move |step| {
        if *step == Step::BeforeProjectFile {
            fs::write(&edit_path, &edit_bytes).unwrap();
        }
        None
    });
    let outcome = fixture.add_section(&section_request(&created, "Организации"));
    clear_step_hook();

    assert!(
        matches!(&outcome, Err(ProjectError::RevisionConflict { actual_revision }) if *actual_revision == raw_revision(&edited)),
        "{outcome:?}"
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        edited,
        "the user's edit is untouched"
    );
    assert!(!fixture.vault.join("MoleHills/Организации").exists());
}

// ---------------------------------------------------------------------------
// Unknown format version: read-only
// ---------------------------------------------------------------------------

fn write_future_project(fixture: &Fixture, folder: &str, kind: &str) -> Vec<u8> {
    let directory = fixture.vault.join(folder);
    fs::create_dir_all(&directory).unwrap();
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "formatVersion": 3,
        "kind": kind,
        "projectId": format!("future-{folder}"),
        "name": folder,
        "sections": [{"id": "x", "databaseId": "db_x", "path": "X", "newField": true}],
        "somethingNew": {"a": 1},
    }))
    .unwrap();
    fs::write(directory.join(PROJECT_FILE_NAME), &bytes).unwrap();
    bytes
}

#[test]
fn a_project_of_an_unknown_format_version_is_listed_read_only_and_never_rewritten() {
    let fixture = Fixture::new();
    let original = write_future_project(&fixture, "Future", "story");
    let discovered = discover_projects(&fixture.vault).unwrap();
    assert_eq!(discovered.projects.len(), 1);
    assert!(!discovered.projects[0].doc.is_known_version());
    assert!(discovered
        .diagnostics
        .iter()
        .any(|entry| entry.code == "unsupportedFormatVersion"));

    let request = CreateProjectSectionRequest {
        expected_generation: 1,
        operation_id: op("section"),
        project_id: "future-Future".to_owned(),
        expected_project_revision: raw_revision(&original),
        name: "Новый".to_owned(),
        role: None,
        group_id: None,
        labels: BTreeMap::new(),
        text_levels: None,
        preset: None,
    };
    let before = fixture.tree();
    assert_eq!(
        fixture.add_section(&request),
        Err(ProjectError::ProjectReadOnly { format_version: 3 })
    );
    assert_eq!(fixture.tree(), before);
    assert_eq!(fixture.project_bytes("Future"), original);

    // Nothing new may be created inside it either.
    let mut inner = story("Inside");
    inner.parent_path = Some("Future".to_owned());
    assert!(matches!(
        fixture.create(&inner),
        Err(ProjectError::ParentProjectReadOnly { .. })
    ));
    assert_eq!(fixture.tree(), before);
}
