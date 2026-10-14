//! Tests of the real write path: every call creates real folders, manifests and
//! structure files in a temporary vault, and faults are injected at each durable
//! boundary of the operation.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::create::{
    clear_step_hook, create_story, create_workshop, create_workshop_section, set_step_hook, Env,
    Fault, Step,
};
use super::discovery::discover_projects;
use super::format::{parse_story_file, parse_workshop_file};
use super::journal::{journal_dir, read_journal, STATUS_COMPLETED};
use super::model::{
    CreateStoryRequest, CreateWorkshopRequest, CreateWorkshopSectionRequest, CreatedStory,
    CreatedWorkshop, CreatedWorkshopSectionResult, ProjectError, STORY_FILE_NAME,
    WORKSHOP_FILE_NAME,
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
        let path = std::env::temp_dir().join(format!("amby-workshop-{}", ulid::Ulid::generate()));
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

    pub(super) fn create_workshop(
        &self,
        request: &CreateWorkshopRequest,
    ) -> Result<CreatedWorkshop, ProjectError> {
        create_workshop(&self.env(), request)
    }

    pub(super) fn create_story(
        &self,
        request: &CreateStoryRequest,
    ) -> Result<CreatedStory, ProjectError> {
        create_story(&self.env(), request)
    }

    pub(super) fn add_section(
        &self,
        request: &CreateWorkshopSectionRequest,
    ) -> Result<CreatedWorkshopSectionResult, ProjectError> {
        create_workshop_section(&self.env(), request)
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

    pub(super) fn workshop_bytes(&self, folder: &str) -> Vec<u8> {
        fs::read(self.vault.join(folder).join(WORKSHOP_FILE_NAME)).unwrap()
    }

    pub(super) fn story_bytes(&self, story_folder: &str) -> Vec<u8> {
        fs::read(self.vault.join(story_folder).join(STORY_FILE_NAME)).unwrap()
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

pub(super) fn workshop(name: &str) -> CreateWorkshopRequest {
    CreateWorkshopRequest {
        expected_generation: 1,
        operation_id: op("workshop"),
        name: name.to_owned(),
        parent_path: None,
        icon: None,
        tags: Vec::new(),
        labels: BTreeMap::new(),
    }
}

pub(super) fn story(workshop_id: &str, name: &str) -> CreateStoryRequest {
    CreateStoryRequest {
        expected_generation: 1,
        operation_id: op("story"),
        workshop_id: workshop_id.to_owned(),
        title: name.to_owned(),
        labels: BTreeMap::new(),
        text_levels: None,
    }
}

pub(super) fn section_request(
    created: &CreatedWorkshop,
    name: &str,
) -> CreateWorkshopSectionRequest {
    CreateWorkshopSectionRequest {
        expected_generation: 1,
        operation_id: op("section"),
        workshop_id: created.workshop_id.clone(),
        expected_workshop_revision: created.file_revision.clone(),
        name: name.to_owned(),
        role: "notes".to_owned(),
        labels: BTreeMap::new(),
    }
}

const BASE_NAMES: [&str; 3] = ["Истории", "Персонажи", "Локации"];

fn manifest_id(path: &Path) -> (String, String) {
    let parsed = parse_manifest(&fs::read(path).unwrap()).unwrap();
    (parsed.value.database_id, parsed.value.name)
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

#[test]
fn a_workshop_gets_its_base_sections_and_the_structure_file_comes_last() {
    let fixture = Fixture::new();
    let vault = fixture.vault.clone();
    let observed = std::rc::Rc::new(std::cell::RefCell::new(Vec::<(String, bool, usize)>::new()));
    let seen = observed.clone();
    set_step_hook(move |step| {
        let file = vault.join("MoleHills").join(WORKSHOP_FILE_NAME);
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

    let created = fixture.create_workshop(&workshop("MoleHills")).unwrap();
    clear_step_hook();

    let steps = observed.borrow();
    let before_file = steps
        .iter()
        .find(|(step, _, _)| step == "BeforeWorkshopFile")
        .unwrap();
    assert_eq!(
        (before_file.1, before_file.2),
        (false, 3),
        "all databases exist, the file does not"
    );
    assert!(steps
        .iter()
        .take_while(|(step, _, _)| step != "WorkshopFileWritten")
        .all(|(_, exists, _)| !exists));
    assert!(
        steps
            .iter()
            .find(|(step, _, _)| step == "WorkshopFileWritten")
            .unwrap()
            .1
    );

    assert!(!created.replayed);
    assert_eq!(created.path, "MoleHills");
    assert_eq!(created.file_path, "MoleHills/amby-workshop.json");
    let bytes = fixture.workshop_bytes("MoleHills");
    assert_eq!(created.file_revision, raw_revision(&bytes));
    let doc = parse_workshop_file(&bytes).unwrap();
    assert_eq!(doc.format_version, 3);
    assert_eq!(doc.workshop_id, created.workshop_id);
    assert_eq!(
        doc.sections
            .iter()
            .map(|section| (section.id.as_str(), section.role.as_str()))
            .collect::<Vec<_>>(),
        [
            ("stories", "stories"),
            ("characters", "characters"),
            ("locations", "locations")
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
    assert_eq!(discovered.workshops.len(), 1);
    assert!(discovered.diagnostics.is_empty());
    assert_eq!(fixture.journal_files().len(), 1);
    let journal = read_journal(&fixture.vault, &created.operation_id)
        .unwrap()
        .unwrap();
    assert_eq!(journal.status, STATUS_COMPLETED);
}

#[test]
fn labels_rename_base_sections_and_unknown_labels_are_rejected() {
    let fixture = Fixture::new();
    let mut request = workshop("Saga");
    request.labels = BTreeMap::from([(
        "section:characters".to_owned(),
        "Действующие лица".to_owned(),
    )]);
    let created = fixture.create_workshop(&request).unwrap();
    assert_eq!(created.sections[1].name, "Действующие лица");
    assert!(fixture
        .vault
        .join("Saga/Действующие лица/Действующие лица.json")
        .is_file());

    let mut typo = workshop("Other");
    typo.labels = BTreeMap::from([("section:unknowwn".to_owned(), "x".to_owned())]);
    assert!(matches!(
        fixture.create_workshop(&typo),
        Err(ProjectError::InvalidName { .. })
    ));
    assert!(!fixture.vault.join("Other").exists());
}

#[test]
fn creating_a_story_inside_workshop_produces_card_note_and_inner_db() {
    let fixture = Fixture::new();
    let created_ws = fixture.create_workshop(&workshop("Epic")).unwrap();

    let story_request = story(&created_ws.workshop_id, "Глава 1");
    let created_story = fixture.create_story(&story_request).unwrap();

    assert_eq!(created_story.title, "Глава 1");
    assert_eq!(created_story.folder_path, "Epic/Истории/Глава 1");
    assert_eq!(created_story.card_path, "Epic/Истории/Глава 1/Глава 1.md");

    // Verify card note exists and has frontmatter
    let card_content = fs::read_to_string(fixture.vault.join(&created_story.card_path)).unwrap();
    assert!(card_content.contains(&created_story.card_note_id));
    assert!(card_content.contains("amby-id:"));

    // Verify story doc
    let story_bytes = fixture.story_bytes("Epic/Истории/Глава 1");
    let story_doc = parse_story_file(&story_bytes).unwrap();
    assert_eq!(story_doc.story_id, created_story.story_id);

    // Verify discovery finds the workshop and story
    let discovered = discover_projects(&fixture.vault).unwrap();
    assert_eq!(discovered.workshops.len(), 1);
    assert_eq!(discovered.workshops[0].stories.len(), 1);
    let disc_story = &discovered.workshops[0].stories[0];
    assert_eq!(disc_story.story_id, created_story.story_id);
    assert_eq!(disc_story.name, "Глава 1");
    assert!(discovered.diagnostics.is_empty());
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
                fixture.create_workshop(&workshop(name)),
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
                fixture.create_workshop(&workshop(name)),
                Err(ProjectError::InvalidName { .. })
            ),
            "{name}"
        );
    }
    let mut parent = workshop("Ok");
    parent.parent_path = Some(".amby".to_owned());
    assert!(matches!(
        fixture.create_workshop(&parent),
        Err(ProjectError::InvalidParent { .. })
    ));
    parent.parent_path = Some("/definitely/elsewhere".to_owned());
    assert!(matches!(
        fixture.create_workshop(&parent),
        Err(ProjectError::InvalidParent { .. })
    ));
    parent.parent_path = Some("missing-folder".to_owned());
    assert!(matches!(
        fixture.create_workshop(&parent),
        Err(ProjectError::InvalidParent { .. })
    ));
    let mut bad_op = workshop("Ok");
    bad_op.operation_id = "../escape".to_owned();
    assert_eq!(
        fixture.create_workshop(&bad_op),
        Err(ProjectError::InvalidOperationId)
    );
    assert_eq!(fixture.tree(), before);
    assert!(fixture.journal_files().is_empty());
}

#[test]
fn repeating_a_call_returns_the_recorded_answer_and_never_a_second_set() {
    let fixture = Fixture::new();
    let request = workshop("MoleHills");
    let first = fixture.create_workshop(&request).unwrap();
    let before = fixture.tree();

    let again = fixture.create_workshop(&request).unwrap();
    assert!(again.replayed);
    assert_eq!(
        CreatedWorkshop {
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
        fixture.create_workshop(&different),
        Err(ProjectError::OperationIdReused { .. })
    ));

    // A fresh intent with the same name is a collision, not a second set.
    assert!(matches!(
        fixture.create_workshop(&workshop("MoleHills")),
        Err(ProjectError::PathCollision { .. })
    ));
    assert_eq!(fixture.tree(), before);
    assert_eq!(
        discover_projects(&fixture.vault).unwrap().workshops.len(),
        1
    );
}

// ---------------------------------------------------------------------------
// Failure and crash at every boundary
// ---------------------------------------------------------------------------

fn all_steps() -> Vec<Step> {
    vec![
        Step::JournalWritten,
        Step::FolderCreated,
        Step::BeforeDatabase(0),
        Step::DatabaseCreated(0),
        Step::BeforeWorkshopFile,
        Step::WorkshopFileWritten,
        Step::BeforeCompletion,
    ]
}

fn fail_at(target: Step) {
    set_step_hook(move |step| (*step == target).then(|| Fault::Fail("injected".to_owned())));
}

fn crash_at(target: Step) {
    set_step_hook(move |step| (*step == target).then_some(Fault::Crash));
}

fn assert_one_complete_workshop(fixture: &Fixture, created: &CreatedWorkshop) {
    let discovered = discover_projects(&fixture.vault).unwrap();
    assert_eq!(discovered.workshops.len(), 1, "exactly one workshop");
    assert!(
        discovered.diagnostics.is_empty(),
        "{:?}",
        discovered.diagnostics
    );
    let databases = discover_vault(&fixture.vault).unwrap();
    assert_eq!(databases.databases.len(), 3, "exactly base databases");
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
        let request = workshop("MoleHills");

        fail_at(target.clone());
        let outcome = fixture.create_workshop(&request);
        clear_step_hook();

        if target == Step::WorkshopFileWritten || target == Step::BeforeCompletion {
            // Arrived after or at the structure file commit point:
            let created = outcome.unwrap_or_else(|error| panic!("{target:?}: {error}"));
            assert_one_complete_workshop(&fixture, &created);
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
            .create_workshop(&request)
            .unwrap_or_else(|error| panic!("{target:?}: {error}"));
        assert!(!created.replayed);
        assert_one_complete_workshop(&fixture, &created);
    }
}

#[test]
fn a_crash_at_any_step_is_cleaned_at_activation_and_a_repeat_completes() {
    for target in all_steps() {
        let fixture = Fixture::new();
        fs::write(fixture.vault.join("Existing.md"), b"# keep\n").unwrap();
        let before = fixture.tree();
        let request = workshop("MoleHills");

        crash_at(target.clone());
        let outcome = fixture.create_workshop(&request);
        clear_step_hook();
        assert!(
            matches!(&outcome, Err(ProjectError::Failed { code, .. }) if code == "interrupted"),
            "{target:?}: {outcome:?}"
        );

        let report = recover_pending_projects(&fixture.vault).unwrap();
        assert!(report.quarantined.is_empty(), "{target:?}: {report:?}");
        if target == Step::WorkshopFileWritten || target == Step::BeforeCompletion {
            assert_eq!((report.rolled_back, report.completed), (0, 1), "{target:?}");
            assert_eq!(
                discover_projects(&fixture.vault).unwrap().workshops.len(),
                1
            );
        } else {
            assert_eq!((report.rolled_back, report.completed), (1, 0), "{target:?}");
            assert_eq!(
                fixture.tree(),
                before,
                "{target:?}: activation removed our leftovers"
            );
            assert!(fixture.journal_files().is_empty());
        }

        // The same intent repeated
        let created = fixture
            .create_workshop(&request)
            .unwrap_or_else(|error| panic!("{target:?}: {error}"));
        assert_eq!(
            created.replayed,
            target == Step::WorkshopFileWritten || target == Step::BeforeCompletion,
            "{target:?}"
        );
        assert_one_complete_workshop(&fixture, &created);
        assert_eq!(
            recover_pending_projects(&fixture.vault).unwrap(),
            Default::default()
        );
    }
}

// ---------------------------------------------------------------------------
// Workshop Sections
// ---------------------------------------------------------------------------

fn add_unknown_fields(fixture: &Fixture, folder: &str, with_bom: bool) -> String {
    let path = fixture.vault.join(folder).join(WORKSHOP_FILE_NAME);
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
    let created = fixture.create_workshop(&workshop("MoleHills")).unwrap();
    let revision = add_unknown_fields(&fixture, "MoleHills", true);
    let mut request = section_request(&created, "Организации");
    request.expected_workshop_revision = revision;

    let added = fixture.add_section(&request).unwrap();
    assert_eq!(added.section.name, "Организации");
    assert_eq!(added.section.section_id, "notes");
    assert_eq!(added.section.container_path, "MoleHills/Организации");

    let bytes = fixture.workshop_bytes("MoleHills");
    assert!(bytes.starts_with(b"\xEF\xBB\xBF"), "the BOM stays");
    assert_eq!(added.workshop_revision, raw_revision(&bytes));
    let document: serde_json::Value = serde_json::from_slice(&bytes[3..]).unwrap();
    assert_eq!(
        document["x-other-app"]["keep"],
        serde_json::json!([1, 2, 3])
    );
    assert_eq!(document["sections"][0]["x-note"], "hand written");
}

// ---------------------------------------------------------------------------
// Names that become folders and files
// ---------------------------------------------------------------------------

/// Characters and shapes `normalize_entry_name` refuses: each would break a path component or be
/// skipped by the scanners. A trailing space is not among them, it is trimmed.
const UNFIT_NAMES: [&str; 11] = [
    "Дом \"Лис\"",
    "a\\b",
    "a/b",
    "Что: это",
    "..",
    "...",
    "Конец.",
    ".скрытая",
    "a*b",
    "tab\there",
    "   ",
];

#[test]
fn story_and_section_names_that_cannot_be_a_folder_are_refused_before_any_write() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let before = fixture.tree();
    let journals = fixture.journal_files();

    for bad in UNFIT_NAMES {
        match fixture.create_story(&story(&created.workshop_id, bad)) {
            Err(ProjectError::InvalidName { field, .. }) => assert_eq!(field, "title", "{bad:?}"),
            other => panic!("story {bad:?}: expected InvalidName, got {other:?}"),
        }
        let mut section = section_request(&created, bad);
        section.role = "custom".to_owned();
        match fixture.add_section(&section) {
            Err(ProjectError::InvalidName { field, .. }) => assert_eq!(field, "name", "{bad:?}"),
            other => panic!("section {bad:?}: expected InvalidName, got {other:?}"),
        }
        assert_eq!(fixture.tree(), before, "{bad:?}: the vault is as before");
        assert_eq!(fixture.journal_files(), journals, "{bad:?}: no journal");
    }

    // A trailing space is trimmed, as everywhere else, not refused.
    let trimmed = fixture
        .create_story(&story(&created.workshop_id, "Тихо "))
        .unwrap();
    assert_eq!(trimmed.title, "Тихо");
    assert_eq!(trimmed.folder_path, "Saga/Истории/Тихо");
}

#[test]
fn base_section_labels_that_cannot_be_a_folder_are_refused_before_any_write() {
    let fixture = Fixture::new();
    let before = fixture.tree();
    for key in ["section:stories", "section:characters", "section:locations"] {
        for bad in UNFIT_NAMES {
            let mut request = workshop("Saga");
            request.labels = BTreeMap::from([(key.to_owned(), bad.to_owned())]);
            assert!(
                matches!(
                    fixture.create_workshop(&request),
                    Err(ProjectError::InvalidName { .. })
                ),
                "{key} = {bad:?}"
            );
            assert_eq!(fixture.tree(), before, "{key} = {bad:?}");
            assert!(fixture.journal_files().is_empty(), "{key} = {bad:?}");
        }
    }
}

// ---------------------------------------------------------------------------
// The story card
// ---------------------------------------------------------------------------

fn card_mapping(content: &str) -> serde_yaml::Mapping {
    crate::frontmatter::frontmatter_yaml_mapping(content)
        .unwrap()
        .expect("the card has a frontmatter")
}

fn card_field(mapping: &serde_yaml::Mapping, key: &str) -> String {
    mapping
        .get(key)
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or_else(|| panic!("no string {key}"))
        .to_owned()
}

#[test]
fn a_story_with_an_apostrophe_and_cyrillic_gets_a_card_that_reads_back() {
    let fixture = Fixture::new();
    let created_ws = fixture.create_workshop(&workshop("Saga")).unwrap();
    let title = "Дом О'Брайена — ёлка #1";
    let created = fixture
        .create_story(&story(&created_ws.workshop_id, title))
        .unwrap();

    let content = fs::read_to_string(fixture.vault.join(&created.card_path)).unwrap();
    let mapping = card_mapping(&content);
    assert_eq!(card_field(&mapping, "amby-id"), created.card_note_id);
    assert_eq!(card_field(&mapping, "amby-title"), title);
    assert_eq!(card_field(&mapping, "amby-story-id"), created.story_id);

    // The note index and the catalog read the same title back.
    let parsed = crate::frontmatter::parse_markdown(&content);
    assert_eq!(parsed.note_id(), Some(created.card_note_id.as_str()));
    assert_eq!(parsed.display_title.as_deref(), Some(title));
    let discovered = discover_projects(&fixture.vault).unwrap();
    assert_eq!(discovered.workshops[0].stories[0].name, title);
    assert!(discovered.diagnostics.is_empty());
}

#[test]
fn the_card_survives_quotes_backslashes_and_line_breaks_in_a_title() {
    // Such a title cannot reach the card through a folder name, but the card must not depend on
    // that: the frontmatter is built with escaping, not by pasting strings together.
    for title in [
        "He said \"hi\"",
        "back\\slash",
        "both \\\" and '",
        "line\nbreak: yes",
        "- [x] {y}: z # tail",
        "Ёж ✓ 日本",
    ] {
        let bytes = super::create::story_card_bytes("01NOTE", title, "01STORY").unwrap();
        let content = String::from_utf8(bytes).unwrap();
        let mapping = card_mapping(&content);
        assert_eq!(card_field(&mapping, "amby-id"), "01NOTE", "{title:?}");
        assert_eq!(card_field(&mapping, "amby-title"), title, "{title:?}");
        assert_eq!(
            card_field(&mapping, "amby-story-id"),
            "01STORY",
            "{title:?}"
        );
    }
}

#[test]
fn a_resumed_story_writes_the_card_bytes_the_journal_holds() {
    let fixture = Fixture::new();
    let created_ws = fixture.create_workshop(&workshop("Saga")).unwrap();
    let request = story(&created_ws.workshop_id, "Дом О'Брайена");

    crash_at(Step::StoryFolderCreated);
    assert!(fixture.create_story(&request).is_err());
    clear_step_hook();
    let planned = read_journal(&fixture.vault, &request.operation_id)
        .unwrap()
        .unwrap()
        .plan
        .story
        .unwrap();

    // No activation in between: the repeat cleans up after itself and resumes.
    let created = fixture.create_story(&request).unwrap();
    assert!(!created.replayed);
    assert_eq!(created.story_id, planned.story_id);
    let on_disk = fs::read(fixture.vault.join(&created.card_path)).unwrap();
    assert_eq!(on_disk, planned.card_bytes, "the same bytes after a resume");
    let finished = read_journal(&fixture.vault, &request.operation_id)
        .unwrap()
        .unwrap();
    assert_eq!(finished.status, STATUS_COMPLETED);
    assert_eq!(finished.plan.story.unwrap().card_bytes, on_disk);
    assert_eq!(created.card_note_id, {
        card_field(
            &card_mapping(&String::from_utf8(on_disk).unwrap()),
            "amby-id",
        )
    });
}

// ---------------------------------------------------------------------------
// A story: failure and crash at every boundary, repeats, interference
// ---------------------------------------------------------------------------

fn story_steps() -> Vec<Step> {
    vec![
        Step::JournalWritten,
        Step::StoryFolderCreated,
        Step::CardNoteCreated,
        Step::TextDatabaseCreated,
        Step::BeforeStoryFile,
        Step::StoryFileWritten,
        Step::BeforeCompletion,
    ]
}

fn story_is_committed_at(target: &Step) -> bool {
    matches!(target, Step::StoryFileWritten | Step::BeforeCompletion)
}

fn assert_one_complete_story(fixture: &Fixture, created: &CreatedStory) {
    let discovered = discover_projects(&fixture.vault).unwrap();
    assert_eq!(
        discovered.workshops[0].stories.len(),
        1,
        "exactly one story"
    );
    assert_eq!(
        discovered.workshops[0].stories[0].story_id,
        created.story_id
    );
    assert!(
        discovered.diagnostics.is_empty(),
        "{:?}",
        discovered.diagnostics
    );
    let databases = discover_vault(&fixture.vault).unwrap();
    assert_eq!(databases.databases.len(), 4, "three base ones and the text");
    assert!(databases.diagnostics.is_empty());
}

#[test]
fn a_failure_at_any_story_step_removes_everything_and_the_retry_creates_one_story() {
    for target in story_steps() {
        let fixture = Fixture::new();
        let created_ws = fixture.create_workshop(&workshop("Saga")).unwrap();
        let before = fixture.tree();
        let journals = fixture.journal_files();
        let request = story(&created_ws.workshop_id, "Дом О'Брайена");

        fail_at(target.clone());
        let outcome = fixture.create_story(&request);
        clear_step_hook();

        if story_is_committed_at(&target) {
            let created = outcome.unwrap_or_else(|error| panic!("{target:?}: {error}"));
            assert_one_complete_story(&fixture, &created);
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
        assert_eq!(fixture.journal_files(), journals, "{target:?}: no journal");

        let created = fixture
            .create_story(&request)
            .unwrap_or_else(|error| panic!("{target:?}: {error}"));
        assert!(!created.replayed);
        assert_one_complete_story(&fixture, &created);
    }
}

#[test]
fn a_crash_at_any_story_step_is_cleaned_at_activation_and_a_repeat_completes() {
    for target in story_steps() {
        let fixture = Fixture::new();
        let created_ws = fixture.create_workshop(&workshop("Saga")).unwrap();
        let before = fixture.tree();
        let request = story(&created_ws.workshop_id, "Дом О'Брайена");

        crash_at(target.clone());
        let outcome = fixture.create_story(&request);
        clear_step_hook();
        assert!(
            matches!(&outcome, Err(ProjectError::Failed { code, .. }) if code == "interrupted"),
            "{target:?}: {outcome:?}"
        );

        let report = recover_pending_projects(&fixture.vault).unwrap();
        assert!(report.quarantined.is_empty(), "{target:?}: {report:?}");
        if story_is_committed_at(&target) {
            assert_eq!((report.rolled_back, report.completed), (0, 1), "{target:?}");
        } else {
            assert_eq!((report.rolled_back, report.completed), (1, 0), "{target:?}");
            assert_eq!(fixture.tree(), before, "{target:?}: leftovers removed");
        }

        let created = fixture
            .create_story(&request)
            .unwrap_or_else(|error| panic!("{target:?}: {error}"));
        assert_eq!(
            created.replayed,
            story_is_committed_at(&target),
            "{target:?}"
        );
        assert_one_complete_story(&fixture, &created);
        assert_eq!(
            recover_pending_projects(&fixture.vault).unwrap(),
            Default::default()
        );
    }
}

#[test]
fn a_story_repeat_returns_the_recorded_answer_and_another_request_under_the_id_is_refused() {
    let fixture = Fixture::new();
    let created_ws = fixture.create_workshop(&workshop("Saga")).unwrap();
    let request = story(&created_ws.workshop_id, "Дом О'Брайена");
    let first = fixture.create_story(&request).unwrap();
    let before = fixture.tree();

    let again = fixture.create_story(&request).unwrap();
    assert!(again.replayed);
    assert_eq!(
        CreatedStory {
            replayed: false,
            ..again
        },
        first
    );
    assert_eq!(fixture.tree(), before, "a repeat writes nothing");

    let mut other_title = request.clone();
    other_title.title = "Другая".to_owned();
    assert!(matches!(
        fixture.create_story(&other_title),
        Err(ProjectError::OperationIdReused { .. })
    ));
    let mut other_levels = request.clone();
    other_levels.text_levels = Some(vec!["Часть".to_owned()]);
    assert!(matches!(
        fixture.create_story(&other_levels),
        Err(ProjectError::OperationIdReused { .. })
    ));
    assert_eq!(fixture.tree(), before);

    // A new intent with the same title is a collision, not a second story.
    assert!(matches!(
        fixture.create_story(&story(&created_ws.workshop_id, "дом о'брайена")),
        Err(ProjectError::PathCollision { .. })
    ));
    assert!(matches!(
        fixture.create_story(&story("no-such-workshop", "Новая")),
        Err(ProjectError::WorkshopNotFound { .. })
    ));
    assert_eq!(fixture.tree(), before);
}

#[test]
fn a_repeat_after_an_unrecovered_workshop_crash_cleans_up_itself_and_completes_one_set() {
    let fixture = Fixture::new();
    let request = workshop("MoleHills");
    crash_at(Step::DatabaseCreated(1));
    assert!(fixture.create_workshop(&request).is_err());
    clear_step_hook();
    assert!(fixture
        .vault
        .join("MoleHills/Персонажи/Персонажи.json")
        .exists());

    // No activation ran in between: the repeat removes our leftovers itself and starts over.
    let created = fixture.create_workshop(&request).unwrap();
    assert!(!created.replayed);
    assert_one_complete_workshop(&fixture, &created);
    assert_eq!(fixture.journal_files().len(), 1);
    let journal = read_journal(&fixture.vault, &request.operation_id)
        .unwrap()
        .unwrap();
    assert_eq!(journal.status, STATUS_COMPLETED);
    assert_eq!(journal.plan.workshop_id, Some(created.workshop_id));
}

#[test]
fn interference_during_the_operation_surfaces_and_the_leftover_is_never_deleted() {
    let fixture = Fixture::new();
    let request = workshop("MoleHills");
    let blocker = fixture.vault.join("MoleHills/Локации");
    let blocker_path = blocker.clone();
    // Another process drops a file where the third database must go.
    set_step_hook(move |step| {
        if *step == Step::BeforeDatabase(2) {
            fs::write(&blocker_path, b"not yours to delete").unwrap();
        }
        None
    });
    let outcome = fixture.create_workshop(&request);
    clear_step_hook();

    match outcome {
        Err(ProjectError::RecoveryRequired {
            operation_id,
            message,
        }) => {
            assert_eq!(operation_id, request.operation_id);
            assert!(message.contains("Локации"), "{message}");
        }
        other => panic!("expected RecoveryRequired, got {other:?}"),
    }
    assert_eq!(fs::read(&blocker).unwrap(), b"not yours to delete");
    assert!(!fixture
        .vault
        .join("MoleHills")
        .join(WORKSHOP_FILE_NAME)
        .exists());
    assert!(
        !fixture.vault.join("MoleHills/Истории").exists(),
        "our own databases were removed"
    );
    assert_eq!(
        fixture.journal_files().len(),
        1,
        "the journal is kept as evidence"
    );

    // Once the user clears the way, the same intent finishes.
    fs::remove_file(&blocker).unwrap();
    let created = fixture.create_workshop(&request).unwrap();
    assert_one_complete_workshop(&fixture, &created);
}

#[test]
fn recovery_leaves_databases_the_user_has_changed_and_quarantines_the_journal() {
    let fixture = Fixture::new();
    let request = workshop("MoleHills");
    crash_at(Step::BeforeWorkshopFile);
    assert!(fixture.create_workshop(&request).is_err());
    clear_step_hook();

    // The user edits one of the new databases before the next activation.
    let manifest = fixture.vault.join("MoleHills/Персонажи/Персонажи.json");
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
        !fixture.vault.join("MoleHills/Истории").exists(),
        "untouched ours are removed"
    );
    assert_eq!(
        journal_dir(&fixture.vault)
            .join("quarantine")
            .read_dir()
            .unwrap()
            .count(),
        1
    );
}

// ---------------------------------------------------------------------------
// Sections: preflight, failure, crash, stale revision, read-only
// ---------------------------------------------------------------------------

fn custom_section(created: &CreatedWorkshop, name: &str) -> CreateWorkshopSectionRequest {
    let mut request = section_request(created, name);
    request.role = "custom".to_owned();
    request
}

#[test]
fn a_section_request_is_checked_before_anything_is_created() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("MoleHills")).unwrap();
    let before = fixture.tree();
    let journals = fixture.journal_files();

    let mut stale = custom_section(&created, "Организации");
    stale.expected_workshop_revision = "0".repeat(64);
    assert!(matches!(
        fixture.add_section(&stale),
        Err(ProjectError::RevisionConflict { actual_revision }) if actual_revision == created.file_revision
    ));

    for name in ["Истории", "истории", "Персонажи"] {
        assert!(
            matches!(
                fixture.add_section(&custom_section(&created, name)),
                Err(ProjectError::PathCollision { .. })
            ),
            "{name}"
        );
    }
    let mut role = custom_section(&created, "Организации");
    role.role = "galaxy".to_owned();
    assert!(matches!(
        fixture.add_section(&role),
        Err(ProjectError::UnsupportedRole { .. })
    ));
    role.role = "characters".to_owned();
    assert!(
        matches!(
            fixture.add_section(&role),
            Err(ProjectError::Failed { code, .. }) if code == "sectionAlreadyExists"
        ),
        "one section per ready-made role"
    );
    let mut missing = custom_section(&created, "Организации");
    missing.workshop_id = "no-such-workshop".to_owned();
    assert!(matches!(
        fixture.add_section(&missing),
        Err(ProjectError::WorkshopNotFound { .. })
    ));

    assert_eq!(fixture.tree(), before);
    assert_eq!(fixture.journal_files(), journals);
}

#[test]
fn a_section_repeat_is_a_replay_and_another_request_under_the_id_is_refused() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("MoleHills")).unwrap();
    let request = custom_section(&created, "Организации");
    let added = fixture.add_section(&request).unwrap();
    let before = fixture.tree();

    let again = fixture.add_section(&request).unwrap();
    assert!(again.replayed);
    assert_eq!(
        CreatedWorkshopSectionResult {
            replayed: false,
            ..again
        },
        added
    );
    assert_eq!(fixture.tree(), before);

    let mut other = request.clone();
    other.name = "Бестиарий".to_owned();
    assert!(matches!(
        fixture.add_section(&other),
        Err(ProjectError::OperationIdReused { .. })
    ));
    let mut other_role = request.clone();
    other_role.role = "notes".to_owned();
    assert!(matches!(
        fixture.add_section(&other_role),
        Err(ProjectError::OperationIdReused { .. })
    ));
    assert_eq!(fixture.tree(), before);
}

#[test]
fn an_anchors_section_is_a_known_role_and_is_kept_in_the_structure_file() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("MoleHills")).unwrap();
    let mut request = section_request(&created, "Якоря");
    request.role = "anchors".to_owned();

    let added = fixture.add_section(&request).unwrap();
    let doc = parse_workshop_file(&fixture.workshop_bytes("MoleHills")).unwrap();
    let section = doc.sections.last().unwrap();
    assert_eq!(section.id, added.section.section_id);
    assert_eq!(section.role, "anchors");
    assert_eq!(section.path, "Якоря");
    assert_eq!(section.database_id, added.section.database_id);
    assert_eq!(doc.sections.len(), 4);
}

#[test]
fn a_failure_or_crash_while_adding_a_section_keeps_the_structure_file_intact() {
    let steps = [
        Step::JournalWritten,
        Step::BeforeDatabase(0),
        Step::DatabaseCreated(0),
        Step::BeforeWorkshopFile,
        Step::WorkshopFileWritten,
    ];
    for crash in [false, true] {
        for target in &steps {
            let fixture = Fixture::new();
            let created = fixture.create_workshop(&workshop("MoleHills")).unwrap();
            let original = fixture.workshop_bytes("MoleHills");
            let before = fixture.tree();
            let request = custom_section(&created, "Организации");

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
            let committed = *target == Step::WorkshopFileWritten;
            if committed {
                assert!(crash || outcome.is_ok(), "{target:?}: {outcome:?}");
                let doc = parse_workshop_file(&fixture.workshop_bytes("MoleHills")).unwrap();
                assert_eq!(doc.sections.len(), 4);
            } else {
                assert!(
                    crash || matches!(outcome, Err(ProjectError::RolledBack { .. })),
                    "{target:?}: {outcome:?}"
                );
                assert_eq!(fixture.workshop_bytes("MoleHills"), original, "{target:?}");
                assert_eq!(
                    fixture.tree(),
                    before,
                    "{target:?}: no database left behind"
                );
            }
            // Repeating the intent ends in exactly one new section.
            let done = fixture.add_section(&request).unwrap();
            assert_eq!(done.replayed, committed, "{target:?} crash={crash}");
            let doc = parse_workshop_file(&fixture.workshop_bytes("MoleHills")).unwrap();
            assert_eq!(doc.sections.len(), 4, "{target:?}");
            assert_eq!(
                doc.sections
                    .iter()
                    .filter(|section| section.name == "Организации")
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
            let created = fixture.create_workshop(&workshop("MoleHills")).unwrap();
            let original = fixture.workshop_bytes("MoleHills");
            let request = custom_section(&created, "Организации");

            crate::frontmatter::inject_nth_atomic_write_failure(nth, after_publish);
            let outcome = fixture.add_section(&request);
            crate::frontmatter::clear_atomic_write_failure();

            let bytes = fixture.workshop_bytes("MoleHills");
            let doc = parse_workshop_file(&bytes).unwrap();
            let container = fixture.vault.join("MoleHills/Организации");
            match outcome {
                Ok(added) => {
                    assert_eq!(doc.sections.len(), 4, "nth={nth} after={after_publish}");
                    assert_eq!(added.workshop_revision, doc.revision);
                    assert!(container.join("Организации.json").is_file());
                }
                Err(ProjectError::RolledBack { .. }) => {
                    assert_eq!(bytes, original, "nth={nth} after={after_publish}");
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
    let created = fixture.create_workshop(&workshop("MoleHills")).unwrap();
    let path = fixture.vault.join("MoleHills").join(WORKSHOP_FILE_NAME);
    let edited = {
        let mut bytes = fs::read(&path).unwrap();
        bytes.extend_from_slice(b"\n");
        bytes
    };
    let edit_path = path.clone();
    let edit_bytes = edited.clone();
    // The user saves the file between the preflight and the write.
    set_step_hook(move |step| {
        if *step == Step::BeforeWorkshopFile {
            fs::write(&edit_path, &edit_bytes).unwrap();
        }
        None
    });
    let outcome = fixture.add_section(&custom_section(&created, "Организации"));
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

pub(super) fn write_future_workshop(fixture: &Fixture, folder: &str) -> Vec<u8> {
    let directory = fixture.vault.join(folder);
    fs::create_dir_all(&directory).unwrap();
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "formatVersion": 9,
        "workshopId": format!("future-{folder}"),
        "name": folder,
        "sections": [
            {"id": "stories", "role": "stories", "databaseId": "db_x", "path": "Истории", "newField": true}
        ],
        "somethingNew": {"a": 1},
    }))
    .unwrap();
    fs::write(directory.join(WORKSHOP_FILE_NAME), &bytes).unwrap();
    bytes
}

#[test]
fn a_workshop_of_an_unknown_format_version_is_listed_read_only_and_never_rewritten() {
    let fixture = Fixture::new();
    let original = write_future_workshop(&fixture, "Future");
    let discovered = discover_projects(&fixture.vault).unwrap();
    assert_eq!(discovered.workshops.len(), 1);
    assert!(!discovered.workshops[0].doc.is_known_version());
    assert!(discovered
        .diagnostics
        .iter()
        .any(|entry| entry.code == "unsupportedFormatVersion"));

    let before = fixture.tree();
    let mut section = custom_section(
        &CreatedWorkshop {
            operation_id: String::new(),
            workshop_id: "future-Future".to_owned(),
            name: "Future".to_owned(),
            path: "Future".to_owned(),
            file_path: "Future/amby-workshop.json".to_owned(),
            file_revision: raw_revision(&original),
            sections: Vec::new(),
            replayed: false,
            warnings: Vec::new(),
        },
        "Новый",
    );
    section.expected_workshop_revision = raw_revision(&original);
    assert_eq!(
        fixture.add_section(&section),
        Err(ProjectError::WorkshopReadOnly { format_version: 9 })
    );
    assert_eq!(
        fixture.create_story(&story("future-Future", "Новая")),
        Err(ProjectError::WorkshopReadOnly { format_version: 9 })
    );
    assert_eq!(fixture.tree(), before);
    assert_eq!(fixture.workshop_bytes("Future"), original);
    assert!(fixture.journal_files().is_empty());
}

/// The keys `projectLabels(t)` in `src/components/workspace/creative/project-labels.ts` sends with
/// every creation. The list is the file `interface-label-keys.json`, which a Vitest test keeps equal
/// to what the interface really sends, so the real backend must accept the whole set.
fn interface_labels() -> BTreeMap<String, String> {
    let keys: Vec<String> = serde_json::from_str(include_str!(
        "../../../src/components/workspace/creative/interface-label-keys.json"
    ))
    .expect("the list of the interface's label keys");
    assert!(keys.len() > 40, "the list is read");
    keys.into_iter()
        .map(|key| {
            let value = key.replace(':', " ");
            (key, value)
        })
        .collect()
}

#[test]
fn the_labels_the_interface_sends_are_accepted_by_every_creation() {
    let fixture = Fixture::new();
    let mut request = workshop("Saga");
    request.labels = interface_labels();
    let created = fixture
        .create_workshop(&request)
        .expect("a workshop with the interface's labels");
    let mut story_request = story(&created.workshop_id, "Дом");
    story_request.labels = interface_labels();
    fixture
        .create_story(&story_request)
        .expect("a story with the interface's labels");
    let mut section = section_request(&created, "Заметки");
    section.labels = interface_labels();
    fixture
        .add_section(&section)
        .expect("a section with the interface's labels");
    // The universes section, with the stories' relation to it, takes the same set.
    let mut universes = section_request(&created, "Вселенные");
    universes.role = "universes".to_owned();
    universes.labels = interface_labels();
    universes.expected_workshop_revision = raw_revision(&fixture.workshop_bytes("Saga"));
    fixture
        .add_section(&universes)
        .expect("the universes with the interface's labels");
    let stories: serde_json::Value = serde_json::from_slice(
        &fs::read(
            fixture
                .vault
                .join("Saga/section stories/section stories.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(stories["properties"]
        .as_array()
        .unwrap()
        .iter()
        .any(|property| property["name"] == "property universe"));
}
