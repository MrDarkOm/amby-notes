//! Initializing the workshop of a vault (`init_workshop`) and making a workshop of the earlier
//! stages whole (`complete_workshop`), through real files in a temporary vault: the whole set of
//! bases with every link, a refusal before the first write, a failure or a crash at every step,
//! and the repeat that makes one set.

use std::collections::BTreeMap;
use std::fs;

use serde_json::{json, Value};

use super::complete::complete_workshop;
use super::create::{
    clear_step_hook, init_workshop, set_step_hook, workshop_folder_of, Fault, Step,
};
use super::create_test::{op, story, workshop, Fixture};
use super::discovery::discover_projects;
use super::journal::{read_journal, STATUS_COMPLETED};
use super::links_test::{
    count_named, entry, manifest, property_with_id, revision_of, rewrite_json, workshop_file,
};
use super::model::{
    CompleteWorkshopRequest, CompletedWorkshop, CreatedWorkshop, InitWorkshopRequest, ProjectError,
    WORKSHOP_FILE_NAME,
};
use super::recovery::recover_pending_projects;
use crate::database::discovery::discover_vault;

const ROLES: [(&str, &str); 7] = [
    ("stories", "Истории"),
    ("characters", "Персонажи"),
    ("locations", "Локации"),
    ("universes", "Вселенные"),
    ("arcs", "Арки"),
    ("anchors", "Якоря"),
    ("notes", "Заметки"),
];

fn init_request(path: &str) -> InitWorkshopRequest {
    InitWorkshopRequest {
        expected_generation: 1,
        operation_id: op("init"),
        path: path.to_owned(),
        labels: BTreeMap::new(),
    }
}

fn init(fixture: &Fixture, request: &InitWorkshopRequest) -> Result<CreatedWorkshop, ProjectError> {
    init_workshop(&fixture.env(), request)
}

fn complete_request(workshop_id: &str) -> CompleteWorkshopRequest {
    CompleteWorkshopRequest {
        expected_generation: 1,
        operation_id: op("complete"),
        workshop_id: workshop_id.to_owned(),
        labels: BTreeMap::new(),
    }
}

fn complete(fixture: &Fixture, workshop_id: &str) -> Result<CompletedWorkshop, ProjectError> {
    complete_workshop(&fixture.env(), &complete_request(workshop_id))
}

/// The relation `property_id` of `manifest` as `(target database, max items, other side)`.
fn relation(manifest: &Value, property_id: &str) -> (String, Option<u64>, bool) {
    let property = property_with_id(manifest, property_id);
    assert_eq!(property["type"], "relation", "{property}");
    (
        property["config"]["targetDatabaseId"]
            .as_str()
            .unwrap()
            .to_owned(),
        property["config"]["maxItems"].as_u64(),
        !property["config"]["inversePropertyId"].is_null(),
    )
}

/// Every link a whole workshop has, read back from the files by ID.
fn assert_every_link(fixture: &Fixture, folder: &str) {
    let file = workshop_file(fixture, folder);
    let database = |role: &str| {
        entry(&file, role)["databaseId"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let manifest_of = |role: &str| {
        let name = entry(&file, role)["name"].as_str().unwrap().to_owned();
        manifest(fixture, &format!("{folder}/{name}"), &name)
    };
    let stories = database("stories");
    for role in [
        "characters",
        "locations",
        "universes",
        "arcs",
        "anchors",
        "notes",
    ] {
        assert_eq!(entry(&file, role)["role"], role);
        assert!(!database(role).is_empty());
    }
    // "Stories" on every world base, and only there.
    for role in ["characters", "locations", "arcs", "anchors", "notes"] {
        let id = entry(&file, role)["storiesPropertyId"]
            .as_str()
            .unwrap_or_else(|| panic!("{role} has no storiesPropertyId"));
        assert_eq!(
            relation(&manifest_of(role), id),
            (stories.clone(), None, false),
            "{role}"
        );
    }
    assert!(entry(&file, "universes").get("storiesPropertyId").is_none());
    // "Universe" of the stories and of the anchors: one at most.
    for role in ["stories", "anchors"] {
        let id = entry(&file, role)["universePropertyId"].as_str().unwrap();
        assert_eq!(
            relation(&manifest_of(role), id),
            (database("universes"), Some(1), false),
            "{role}"
        );
    }
    let arcs_id = entry(&file, "anchors")["arcsPropertyId"].as_str().unwrap();
    assert_eq!(
        relation(&manifest_of("anchors"), arcs_id),
        (database("arcs"), None, false)
    );
    let characters_id = entry(&file, "arcs")["charactersPropertyId"]
        .as_str()
        .unwrap();
    assert_eq!(
        relation(&manifest_of("arcs"), characters_id),
        (database("characters"), None, false)
    );
}

fn assert_one_whole_workshop(fixture: &Fixture, folder: &str, created: &CreatedWorkshop) {
    let discovered = discover_projects(&fixture.vault).unwrap();
    assert_eq!(discovered.workshops.len(), 1, "exactly one workshop");
    assert!(
        discovered.diagnostics.is_empty(),
        "{:?}",
        discovered.diagnostics
    );
    let workshop = &discovered.workshops[0];
    assert_eq!(workshop.doc.workshop_id, created.workshop_id);
    let roles = workshop
        .doc
        .sections
        .iter()
        .map(|section| section.role.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        roles,
        ROLES.iter().map(|(role, _)| *role).collect::<Vec<_>>()
    );
    let databases = discover_vault(&fixture.vault).unwrap();
    assert_eq!(databases.databases.len(), 7, "exactly the seven bases");
    assert!(databases.diagnostics.is_empty());
    for section in &created.sections {
        assert!(databases
            .databases
            .iter()
            .any(|database| database.database_id == section.database_id));
    }
    assert_every_link(fixture, folder);
}

#[test]
fn initializing_makes_the_folder_the_marker_and_all_seven_bases_with_every_link() {
    let fixture = Fixture::new();
    let created = init(&fixture, &init_request("Мастерская")).unwrap();

    assert_eq!(
        created.name, "Мастерская",
        "the name of the workshop is its folder"
    );
    assert_eq!(created.path, "Мастерская");
    assert_eq!(created.sections.len(), 7);
    assert_one_whole_workshop(&fixture, "Мастерская", &created);
    for (_, name) in ROLES {
        assert!(
            fixture
                .vault
                .join("Мастерская")
                .join(name)
                .join(format!("{name}.json"))
                .is_file(),
            "{name}"
        );
    }
    let journal = read_journal(&fixture.vault, &created.operation_id)
        .unwrap()
        .unwrap();
    assert_eq!(journal.status, STATUS_COMPLETED);
    // The "Stories" relation of the arcs is made in the arcs' own base, not added later.
    let arcs = manifest(&fixture, "Мастерская/Арки", "Арки");
    assert_eq!(count_named(&arcs, "Истории"), 1);
    assert_eq!(count_named(&arcs, "Персонажи"), 1);
    let anchors = manifest(&fixture, "Мастерская/Якоря", "Якоря");
    for name in ["Истории", "Арки", "Вселенная", "Участники"] {
        assert_eq!(count_named(&anchors, name), 1, "{name}");
    }
    // Nothing for the lazy path to add.
    let completed = complete(&fixture, &created.workshop_id).unwrap();
    assert!(!completed.changed, "{completed:?}");
    assert!(completed.created_roles.is_empty() && completed.linked.is_empty());
}

#[test]
fn a_story_made_in_a_whole_workshop_carries_the_anchors_and_arcs_relations_at_birth() {
    let fixture = Fixture::new();
    let created = init(&fixture, &init_request("Мастерская")).unwrap();
    let house = fixture
        .create_story(&story(&created.workshop_id, "Дом"))
        .unwrap();
    let text = manifest(&fixture, "Мастерская/Истории/Дом", "Дом");
    assert_eq!(count_named(&text, "Якоря"), 1);
    assert_eq!(count_named(&text, "Арки"), 1);
    let file: Value =
        serde_json::from_slice(&fixture.story_bytes("Мастерская/Истории/Дом")).unwrap();
    assert!(file["text"]["properties"]["anchors"].is_string());
    assert!(file["text"]["properties"]["arcs"].is_string());
    assert_eq!(house.title, "Дом");
}

#[test]
fn the_marker_is_written_last_and_a_folder_that_was_there_is_taken() {
    let fixture = Fixture::new();
    let folder = fixture.vault.join("Мастерская");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join(".DS_Store"), b"junk").unwrap();
    let vault = fixture.vault.clone();
    let order = std::rc::Rc::new(std::cell::RefCell::new(Vec::<(String, bool, usize)>::new()));
    let seen = order.clone();
    set_step_hook(move |step| {
        let marker = vault.join("Мастерская").join(WORKSHOP_FILE_NAME).exists();
        let bases = ROLES
            .iter()
            .filter(|(_, name)| {
                vault
                    .join("Мастерская")
                    .join(name)
                    .join(format!("{name}.json"))
                    .exists()
            })
            .count();
        seen.borrow_mut().push((format!("{step:?}"), marker, bases));
        None
    });
    let created = init(&fixture, &init_request("Мастерская")).unwrap();
    clear_step_hook();

    assert_one_whole_workshop(&fixture, "Мастерская", &created);
    let order = order.borrow();
    assert!(order.iter().all(|(step, marker, _)| {
        if step == "WorkshopFileWritten" || step == "BeforeCompletion" {
            *marker
        } else {
            !marker
        }
    }));
    assert!(order.iter().any(|(_, _, bases)| *bases == 7));
}

#[test]
fn a_path_inside_a_folder_of_the_vault_is_made_there() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.vault.join("Книги")).unwrap();
    let created = init(&fixture, &init_request("Книги/Мастерская")).unwrap();
    assert_eq!(created.path, "Книги/Мастерская");
    assert_eq!(created.name, "Мастерская");
    assert_one_whole_workshop(&fixture, "Книги/Мастерская", &created);
}

#[test]
fn a_folder_with_anything_else_in_it_is_refused_before_any_write() {
    let fixture = Fixture::new();
    let folder = fixture.vault.join("Мастерская");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("Чужое.md"), b"# mine\n").unwrap();
    let before = fixture.tree();
    let outcome = init(&fixture, &init_request("Мастерская"));
    assert!(
        matches!(&outcome, Err(ProjectError::Failed { code, .. }) if code == "folderNotEmpty"),
        "{outcome:?}"
    );
    assert_eq!(fixture.tree(), before);
    assert!(fixture.journal_files().is_empty());

    // A file where the folder should be, and a folder of a workshop of another format.
    fs::remove_dir_all(&folder).unwrap();
    fs::write(&folder, b"a file").unwrap();
    let outcome = init(&fixture, &init_request("Мастерская"));
    assert!(matches!(outcome, Err(ProjectError::PathCollision { .. })));
    assert!(fixture.journal_files().is_empty());
}

#[test]
fn paths_outside_the_vault_or_hiding_in_it_are_refused_before_any_write() {
    let fixture = Fixture::new();
    fs::write(fixture.vault.join("Existing.md"), b"# keep\n").unwrap();
    let before = fixture.tree();
    for path in [
        "",
        "   ",
        "..",
        "../Мастерская",
        "Книги/../Мастерская",
        "/Мастерская",
        "Мастерская/",
        "./Мастерская",
        "a//b",
        "C:\\Мастерская",
        "..\\Мастерская",
        ".hidden",
        ".amby/Мастерская",
        "Книги/.тень/Мастерская",
        " Мастерская",
        "assets",
        "Нет/Такой/Папки",
        "a:b",
    ] {
        let outcome = init(&fixture, &init_request(path));
        assert!(outcome.is_err(), "{path:?} must be refused: {outcome:?}");
        assert_eq!(fixture.tree(), before, "{path:?}");
        assert!(fixture.journal_files().is_empty(), "{path:?}");
    }
    let outcome = init(
        &fixture,
        &InitWorkshopRequest {
            operation_id: "bad id".to_owned(),
            ..init_request("Мастерская")
        },
    );
    assert!(matches!(outcome, Err(ProjectError::InvalidOperationId)));
    assert_eq!(fixture.tree(), before);
}

#[test]
fn a_symlinked_parent_is_refused() {
    #[cfg(unix)]
    {
        let fixture = Fixture::new();
        let outside = std::env::temp_dir().join(format!("amby-outside-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, fixture.vault.join("Ссылка")).unwrap();
        let outcome = init(&fixture, &init_request("Ссылка/Мастерская"));
        assert!(outcome.is_err(), "{outcome:?}");
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
        fs::remove_dir_all(&outside).ok();
    }
}

#[test]
fn two_bases_cannot_share_a_folder_name_in_any_case() {
    let fixture = Fixture::new();
    let mut request = init_request("Мастерская");
    request
        .labels
        .insert("section:arcs".to_owned(), "ЯКОРЯ".to_owned());
    request
        .labels
        .insert("section:anchors".to_owned(), "Якоря".to_owned());
    let before = fixture.tree();
    assert!(matches!(
        init(&fixture, &request),
        Err(ProjectError::InvalidName { .. })
    ));
    assert_eq!(fixture.tree(), before);
    assert!(fixture.journal_files().is_empty());
}

#[test]
fn the_labels_of_the_active_language_name_the_folders_and_the_properties() {
    let fixture = Fixture::new();
    let mut request = init_request("Workshop");
    for (role, name) in [
        ("stories", "Stories"),
        ("characters", "Characters"),
        ("locations", "Locations"),
        ("universes", "Universes"),
        ("arcs", "Arcs"),
        ("anchors", "Anchors"),
        ("notes", "Notes"),
    ] {
        request
            .labels
            .insert(format!("section:{role}"), name.to_owned());
    }
    request
        .labels
        .insert("property:stories".to_owned(), "Stories".to_owned());
    request
        .labels
        .insert("property:universe".to_owned(), "Universe".to_owned());
    request
        .labels
        .insert("property:arcs".to_owned(), "Arcs".to_owned());
    request
        .labels
        .insert("preset:characters".to_owned(), "Characters".to_owned());
    let created = init(&fixture, &request).unwrap();
    assert_eq!(created.name, "Workshop");
    let anchors = manifest(&fixture, "Workshop/Anchors", "Anchors");
    for name in ["Stories", "Arcs", "Universe"] {
        assert_eq!(count_named(&anchors, name), 1, "{name}");
    }
    let stories = manifest(&fixture, "Workshop/Stories", "Stories");
    assert_eq!(count_named(&stories, "Universe"), 1);
}

// ---------------------------------------------------------------------------
// Failure and crash at every boundary
// ---------------------------------------------------------------------------

fn init_steps() -> Vec<Step> {
    let mut steps = vec![Step::JournalWritten, Step::FolderCreated];
    for index in 0..7 {
        steps.push(Step::BeforeDatabase(index));
        steps.push(Step::DatabaseCreated(index));
    }
    steps.push(Step::BeforeWorkshopFile);
    steps.push(Step::WorkshopFileWritten);
    steps.push(Step::BeforeCompletion);
    steps
}

fn committed(step: &Step) -> bool {
    matches!(step, Step::WorkshopFileWritten | Step::BeforeCompletion)
}

#[test]
fn a_failure_at_any_step_puts_every_byte_back_and_the_retry_makes_one_set() {
    // Once with a folder that is not there, once with an empty one the author chose.
    for pre_existing in [false, true] {
        for target in init_steps() {
            let fixture = Fixture::new();
            fs::write(fixture.vault.join("Existing.md"), b"# keep\n").unwrap();
            if pre_existing {
                fs::create_dir(fixture.vault.join("Мастерская")).unwrap();
            }
            let before = fixture.tree();
            let request = init_request("Мастерская");

            let wanted = target.clone();
            set_step_hook(move |step| {
                (*step == wanted).then(|| Fault::Fail("injected".to_owned()))
            });
            let outcome = init(&fixture, &request);
            clear_step_hook();

            if committed(&target) {
                let created = outcome.unwrap_or_else(|error| panic!("{target:?}: {error}"));
                assert_one_whole_workshop(&fixture, "Мастерская", &created);
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
            assert_eq!(
                fixture.tree(),
                before,
                "{target:?} (folder there: {pre_existing}): the vault is as before"
            );
            assert!(fixture.journal_files().is_empty(), "{target:?}");

            let created =
                init(&fixture, &request).unwrap_or_else(|error| panic!("{target:?}: {error}"));
            assert!(!created.replayed);
            assert_one_whole_workshop(&fixture, "Мастерская", &created);
        }
    }
}

#[test]
fn a_crash_at_any_step_is_cleaned_at_activation_and_the_repeat_completes() {
    for pre_existing in [false, true] {
        for target in init_steps() {
            let fixture = Fixture::new();
            fs::write(fixture.vault.join("Existing.md"), b"# keep\n").unwrap();
            if pre_existing {
                fs::create_dir(fixture.vault.join("Мастерская")).unwrap();
            }
            let before = fixture.tree();
            let request = init_request("Мастерская");

            let wanted = target.clone();
            set_step_hook(move |step| (*step == wanted).then_some(Fault::Crash));
            let outcome = init(&fixture, &request);
            clear_step_hook();
            assert!(
                matches!(&outcome, Err(ProjectError::Failed { code, .. }) if code == "interrupted"),
                "{target:?}: {outcome:?}"
            );

            let report = recover_pending_projects(&fixture.vault).unwrap();
            assert!(report.quarantined.is_empty(), "{target:?}: {report:?}");
            if committed(&target) {
                assert_eq!((report.rolled_back, report.completed), (0, 1), "{target:?}");
            } else {
                assert_eq!((report.rolled_back, report.completed), (1, 0), "{target:?}");
                assert_eq!(fixture.tree(), before, "{target:?}: activation cleaned up");
                assert!(fixture.journal_files().is_empty());
            }

            let created =
                init(&fixture, &request).unwrap_or_else(|error| panic!("{target:?}: {error}"));
            assert_eq!(created.replayed, committed(&target), "{target:?}");
            assert_one_whole_workshop(&fixture, "Мастерская", &created);
            assert_eq!(
                recover_pending_projects(&fixture.vault).unwrap(),
                Default::default()
            );
        }
    }
}

#[test]
fn a_repeat_returns_the_record_and_another_request_under_the_id_is_refused() {
    let fixture = Fixture::new();
    let request = init_request("Мастерская");
    let first = init(&fixture, &request).unwrap();
    let after_first = fixture.tree();
    let again = init(&fixture, &request).unwrap();
    assert!(again.replayed);
    assert_eq!(again.workshop_id, first.workshop_id);
    assert_eq!(fixture.tree(), after_first);

    let other = InitWorkshopRequest {
        path: "Другая".to_owned(),
        ..request
    };
    assert!(matches!(
        init(&fixture, &other),
        Err(ProjectError::OperationIdReused { .. })
    ));
    assert_eq!(fixture.tree(), after_first);
}

#[test]
fn a_second_initialization_of_the_same_folder_is_refused_not_merged() {
    let fixture = Fixture::new();
    init(&fixture, &init_request("Мастерская")).unwrap();
    let before = fixture.tree();
    let outcome = init(&fixture, &init_request("Мастерская"));
    assert!(
        matches!(&outcome, Err(ProjectError::Failed { code, .. }) if code == "folderNotEmpty"),
        "{outcome:?}"
    );
    assert_eq!(fixture.tree(), before);
}

// ---------------------------------------------------------------------------
// Making a workshop of the earlier stages whole
// ---------------------------------------------------------------------------

/// A workshop as stages 2 to 7 made it: three bases, a story and an author's own section.
fn earlier_workshop(fixture: &Fixture) -> CreatedWorkshop {
    let created = fixture.create_workshop(&workshop("MoleHills")).unwrap();
    fixture
        .create_story(&story(&created.workshop_id, "Дом"))
        .unwrap();
    let mut custom = super::create_test::section_request(&created, "Бестиарий");
    custom.role = "custom".to_owned();
    custom.expected_workshop_revision = revision_of(fixture, "MoleHills");
    fixture.add_section(&custom).unwrap();
    created
}

#[test]
fn a_workshop_of_the_earlier_stages_gets_what_is_absent_and_nothing_else() {
    let fixture = Fixture::new();
    let created = earlier_workshop(&fixture);
    let before = fixture.tree();
    let characters_before = fixture.tree()["MoleHills/Персонажи/Персонажи.json"].clone();

    let completed = complete(&fixture, &created.workshop_id).unwrap();
    assert!(completed.changed);
    assert_eq!(
        completed.created_roles,
        ["universes", "arcs", "anchors", "notes"]
    );
    assert!(completed.skipped.is_empty(), "{:?}", completed.skipped);

    let after = fixture.tree();
    assert_eq!(
        after["MoleHills/Персонажи/Персонажи.json"], characters_before,
        "a base that was complete is not touched"
    );
    // Files that were there changed only where the missing links go: the structure file, the
    // stories base, the story's text and its settings.
    for (path, bytes) in &before {
        if after.get(path) != Some(bytes) {
            assert!(
                matches!(
                    path.as_str(),
                    "MoleHills/amby-workshop.json"
                        | "MoleHills/Истории/Истории.json"
                        | "MoleHills/Истории/Дом/Дом.json"
                        | "MoleHills/Истории/Дом/amby-story.json"
                ),
                "{path} changed"
            );
        }
    }
    let discovered = discover_projects(&fixture.vault).unwrap();
    assert!(
        discovered.diagnostics.is_empty(),
        "{:?}",
        discovered.diagnostics
    );
    assert_every_link(&fixture, "MoleHills");
    let file = workshop_file(&fixture, "MoleHills");
    assert!(
        file["sections"]
            .as_array()
            .unwrap()
            .iter()
            .any(|section| section["role"] == "custom" && section["storiesPropertyId"].is_string()),
        "the author's section keeps its link"
    );
    let text = manifest(&fixture, "MoleHills/Истории/Дом", "Дом");
    assert_eq!(count_named(&text, "Якоря"), 1);
    assert_eq!(count_named(&text, "Арки"), 1);
    let story_file: Value =
        serde_json::from_slice(&fixture.story_bytes("MoleHills/Истории/Дом")).unwrap();
    assert!(story_file["text"]["properties"]["anchors"].is_string());
    assert!(story_file["text"]["properties"]["arcs"].is_string());

    // Doing it again writes nothing.
    let settled = fixture.tree();
    let again = complete(&fixture, &created.workshop_id).unwrap();
    assert!(!again.changed, "{again:?}");
    assert!(again.created_roles.is_empty() && again.linked.is_empty());
    assert_eq!(fixture.tree(), settled);
}

#[test]
fn a_section_without_its_recorded_link_adopts_the_relation_it_already_has() {
    let fixture = Fixture::new();
    let created = earlier_workshop(&fixture);
    let locations_before = fixture.tree()["MoleHills/Локации/Локации.json"].clone();
    // The structure file forgets the "Stories" ID of the locations (a workshop made before).
    rewrite_json(
        &fixture.vault.join("MoleHills").join(WORKSHOP_FILE_NAME),
        false,
        |file| {
            for section in file["sections"].as_array_mut().unwrap() {
                if section["role"] == "locations" {
                    section.as_object_mut().unwrap().remove("storiesPropertyId");
                }
            }
        },
    );
    let completed = complete(&fixture, &created.workshop_id).unwrap();
    assert!(completed
        .linked
        .iter()
        .any(|entry| entry == "section:locations"));
    assert_eq!(
        fixture.tree()["MoleHills/Локации/Локации.json"],
        locations_before,
        "the relation was there: only its ID was recorded"
    );
    assert_every_link(&fixture, "MoleHills");
}

#[test]
fn unknown_fields_and_the_bom_of_the_structure_file_survive_completing() {
    let fixture = Fixture::new();
    let created = earlier_workshop(&fixture);
    rewrite_json(
        &fixture.vault.join("MoleHills").join(WORKSHOP_FILE_NAME),
        true,
        |file| {
            file["x-other-app"] = json!({"keep": [1, 2, 3]});
        },
    );
    complete(&fixture, &created.workshop_id).unwrap();
    let bytes = fixture.workshop_bytes("MoleHills");
    assert!(bytes.starts_with(b"\xEF\xBB\xBF"), "the BOM is kept");
    let file: Value = serde_json::from_slice(&bytes[3..]).unwrap();
    assert_eq!(file["x-other-app"], json!({"keep": [1, 2, 3]}));
}

#[test]
fn a_failure_or_a_crash_while_completing_leaves_the_files_as_they_were_and_the_retry_finishes() {
    let steps = [
        Step::BeforeDatabase(0),
        Step::DatabaseCreated(0),
        Step::BeforeManifest,
        Step::ManifestWritten,
        Step::BeforeWorkshopFile,
    ];
    for crash in [false, true] {
        for target in &steps {
            let fixture = Fixture::new();
            let created = earlier_workshop(&fixture);
            let before = fixture.tree();

            let wanted = target.clone();
            set_step_hook(move |step| {
                (*step == wanted).then(|| {
                    if crash {
                        Fault::Crash
                    } else {
                        Fault::Fail("injected".to_owned())
                    }
                })
            });
            let outcome = complete(&fixture, &created.workshop_id);
            clear_step_hook();
            assert!(outcome.is_err(), "{target:?} crash={crash}: {outcome:?}");
            recover_pending_projects(&fixture.vault).unwrap();
            assert_eq!(
                fixture.tree(),
                before,
                "{target:?} crash={crash}: nothing of the first step is left"
            );

            let completed = complete(&fixture, &created.workshop_id).unwrap();
            assert!(completed.changed);
            assert_eq!(completed.created_roles.len(), 4);
            assert_every_link(&fixture, "MoleHills");
            assert_eq!(
                discover_vault(&fixture.vault).unwrap().databases.len(),
                9,
                "3 bases + 4 new + the author's + the story's text, never two sets"
            );
        }
    }
}

#[test]
fn a_taken_folder_is_skipped_and_the_rest_is_done() {
    let fixture = Fixture::new();
    let created = earlier_workshop(&fixture);
    fs::create_dir(fixture.vault.join("MoleHills/Арки")).unwrap();
    fs::write(fixture.vault.join("MoleHills/Арки/мои.md"), b"# mine\n").unwrap();
    let completed = complete(&fixture, &created.workshop_id).unwrap();
    assert_eq!(completed.skipped, ["section:arcs"]);
    assert_eq!(completed.created_roles, ["universes", "anchors", "notes"]);
    assert_eq!(
        fs::read(fixture.vault.join("MoleHills/Арки/мои.md")).unwrap(),
        b"# mine\n"
    );
}

#[test]
fn a_workshop_of_another_format_version_is_never_completed() {
    let fixture = Fixture::new();
    let created = earlier_workshop(&fixture);
    rewrite_json(
        &fixture.vault.join("MoleHills").join(WORKSHOP_FILE_NAME),
        false,
        |file| file["formatVersion"] = json!(4),
    );
    let before = fixture.tree();
    let journals = fixture.journal_files();
    assert!(matches!(
        complete(&fixture, &created.workshop_id),
        Err(ProjectError::WorkshopReadOnly { .. })
    ));
    assert!(matches!(
        complete(&fixture, "01JNOSUCH"),
        Err(ProjectError::WorkshopNotFound { .. })
    ));
    assert_eq!(fixture.tree(), before);
    assert_eq!(fixture.journal_files(), journals, "no new journal");
}

#[test]
fn a_picked_folder_becomes_a_relative_path_only_inside_the_vault() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.vault.join("Книги/Серия")).unwrap();
    fs::create_dir(fixture.vault.join(".тень")).unwrap();
    fs::write(fixture.vault.join("файл.md"), b"x").unwrap();
    let pick = |relative: &str| {
        workshop_folder_of(
            &fixture.vault,
            fixture.vault.join(relative).to_str().unwrap(),
        )
    };
    assert_eq!(pick("Книги").unwrap(), "Книги");
    assert_eq!(pick("Книги/Серия").unwrap(), "Книги/Серия");
    assert_eq!(pick("Книги/../Книги").unwrap(), "Книги", "canonicalized");
    for bad in [".тень", "файл.md", "нет", ""] {
        assert!(pick(bad).is_err(), "{bad:?}");
    }
    let outside = std::env::temp_dir().join(format!("amby-outside-{}", ulid::Ulid::generate()));
    fs::create_dir_all(&outside).unwrap();
    assert!(workshop_folder_of(&fixture.vault, outside.to_str().unwrap()).is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, fixture.vault.join("Ссылка")).unwrap();
        assert!(
            pick("Ссылка").is_err(),
            "a link out of the vault is the place it leads to"
        );
    }
    fs::remove_dir_all(&outside).ok();
}
