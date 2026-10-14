//! Links between world pages, stories and universes, through real files: the properties a
//! workshop starts with, the lazy universes section, `add_story_links`, and pages born linked.

use std::collections::BTreeMap;
use std::fs;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::create::{clear_step_hook, set_step_hook, Fault, Step};
use super::create_test::{op, section_request as notes_request, story, workshop, Fixture};
use super::index::{load_catalog, rebuild_project_index};
use super::journal::read_journal;
use super::links::{add_story_links, create_entity};
use super::model::{
    AddStoryLinksRequest, AddedStoryLinks, CreateWorkshopEntityRequest,
    CreateWorkshopSectionRequest, CreatedWorkshop, ProjectError, WORKSHOP_FILE_NAME,
};
use super::recovery::recover_pending_projects;
use crate::database::discovery::discover_vault;
use crate::database::format::raw_revision;
use crate::index::schema::init_schema;

fn read_json(fixture: &Fixture, relative: &str) -> Value {
    serde_json::from_slice(&fs::read(fixture.vault.join(relative)).unwrap()).unwrap()
}

/// The manifest of a section database; every section folder `X` holds `X.json`.
fn manifest(fixture: &Fixture, folder: &str, name: &str) -> Value {
    read_json(fixture, &format!("{folder}/{name}.json"))
}

fn property_named<'a>(manifest: &'a Value, name: &str) -> Option<&'a Value> {
    manifest["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|property| property["name"] == name)
}

fn property_with_id<'a>(manifest: &'a Value, id: &str) -> &'a Value {
    manifest["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|property| property["id"] == id)
        .unwrap_or_else(|| panic!("no property {id}"))
}

fn count_named(manifest: &Value, name: &str) -> usize {
    manifest["properties"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|property| property["name"] == name)
        .count()
}

fn entry<'a>(file: &'a Value, role: &str) -> &'a Value {
    file["sections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|section| section["role"] == role)
        .unwrap_or_else(|| panic!("no section {role}"))
}

fn workshop_file(fixture: &Fixture, folder: &str) -> Value {
    read_json(fixture, &format!("{folder}/{WORKSHOP_FILE_NAME}"))
}

fn revision_of(fixture: &Fixture, folder: &str) -> String {
    raw_revision(&fixture.workshop_bytes(folder))
}

fn section_request(
    created: &CreatedWorkshop,
    revision: &str,
    role: &str,
    name: &str,
) -> CreateWorkshopSectionRequest {
    CreateWorkshopSectionRequest {
        expected_generation: 1,
        operation_id: op("section"),
        workshop_id: created.workshop_id.clone(),
        expected_workshop_revision: revision.to_owned(),
        role: role.to_owned(),
        name: name.to_owned(),
        labels: BTreeMap::new(),
    }
}

/// Rewrites a JSON file the way Amby writes it (pretty, one newline), optionally with a BOM.
fn rewrite_json(path: &std::path::Path, with_bom: bool, edit: impl FnOnce(&mut Value)) -> String {
    let body = fs::read(path).unwrap();
    let body = body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&body);
    let mut value: Value = serde_json::from_slice(body).unwrap();
    edit(&mut value);
    let mut bytes = Vec::new();
    if with_bom {
        bytes.extend_from_slice(b"\xEF\xBB\xBF");
    }
    bytes.extend(serde_json::to_vec_pretty(&value).unwrap());
    bytes.push(b'\n');
    fs::write(path, &bytes).unwrap();
    raw_revision(&bytes)
}

/// Makes a workshop look as it did before the links existed: the file names no link property.
fn forget_links(fixture: &Fixture, folder: &str, with_bom: bool) -> String {
    rewrite_json(
        &fixture.vault.join(folder).join(WORKSHOP_FILE_NAME),
        with_bom,
        |file| {
            for section in file["sections"].as_array_mut().unwrap() {
                let entry = section.as_object_mut().unwrap();
                entry.remove("storiesPropertyId");
                entry.remove("universePropertyId");
            }
        },
    )
}

fn remove_property(fixture: &Fixture, folder: &str, name: &str, property_name: &str) {
    rewrite_json(
        &fixture.vault.join(folder).join(format!("{name}.json")),
        false,
        |manifest| {
            manifest["properties"]
                .as_array_mut()
                .unwrap()
                .retain(|property| property["name"] != property_name);
        },
    );
}

fn links_request(
    created: &CreatedWorkshop,
    revision: &str,
    section_id: &str,
) -> AddStoryLinksRequest {
    AddStoryLinksRequest {
        expected_generation: 1,
        operation_id: op("links"),
        workshop_id: created.workshop_id.clone(),
        expected_workshop_revision: revision.to_owned(),
        section_id: section_id.to_owned(),
        labels: BTreeMap::new(),
    }
}

// ---------------------------------------------------------------------------
// What a workshop starts with
// ---------------------------------------------------------------------------

#[test]
fn a_new_workshop_records_the_stories_property_of_every_world_section() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let file = workshop_file(&fixture, "Saga");
    let stories = manifest(&fixture, "Saga/Истории", "Истории");

    for (role, folder) in [("characters", "Персонажи"), ("locations", "Локации")] {
        let id = entry(&file, role)["storiesPropertyId"]
            .as_str()
            .unwrap_or_else(|| panic!("{role} names its stories property"));
        let section = manifest(&fixture, &format!("Saga/{folder}"), folder);
        let property = property_with_id(&section, id);
        assert_eq!(property["name"], "Истории");
        assert_eq!(property["type"], "relation");
        assert_eq!(
            property["config"]["targetDatabaseId"], stories["databaseId"],
            "{role}: to the stories database"
        );
        assert!(
            property["config"]["maxItems"].is_null(),
            "{role}: any number"
        );
        assert!(
            property["config"]["inversePropertyId"].is_null(),
            "{role}: no other side"
        );
    }
    // The stories do not link to themselves, and no universe exists yet.
    let stories_entry = entry(&file, "stories");
    assert!(stories_entry.get("storiesPropertyId").is_none());
    assert!(stories_entry.get("universePropertyId").is_none());
    assert_eq!(count_named(&stories, "Вселенная"), 0);

    // The catalog the interface reads carries the same IDs.
    let connection = Connection::open_in_memory().unwrap();
    init_schema(&connection).unwrap();
    rebuild_project_index(&connection, &fixture.vault).unwrap();
    let catalog = load_catalog(&connection, &fixture.vault, 1).unwrap();
    let summary = &catalog.workshops[0];
    assert_eq!(summary.workshop_id, created.workshop_id);
    for section in &summary.sections {
        let recorded = entry(&file, &section.role);
        assert_eq!(
            section.stories_property_id.as_deref(),
            recorded["storiesPropertyId"].as_str(),
            "{}",
            section.role
        );
        assert_eq!(section.universe_property_id, None);
    }
}

#[test]
fn the_link_properties_are_named_by_the_labels_of_the_language() {
    let fixture = Fixture::new();
    let mut request = workshop("Saga");
    request
        .labels
        .insert("property:stories".to_owned(), "Stories".to_owned());
    request
        .labels
        .insert("property:universe".to_owned(), "Universe".to_owned());
    let created = fixture.create_workshop(&request).unwrap();
    let characters = manifest(&fixture, "Saga/Персонажи", "Персонажи");
    assert!(property_named(&characters, "Stories").is_some());
    assert!(property_named(&characters, "Истории").is_none());

    let mut universes = section_request(&created, &created.file_revision, "universes", "Вселенные");
    universes
        .labels
        .insert("property:universe".to_owned(), "Universe".to_owned());
    fixture.add_section(&universes).unwrap();
    let stories = manifest(&fixture, "Saga/Истории", "Истории");
    assert!(property_named(&stories, "Universe").is_some());
}

#[test]
fn every_world_role_gets_the_stories_link_when_it_is_added() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let stories = manifest(&fixture, "Saga/Истории", "Истории");
    for (role, name) in [
        ("arcs", "Арки"),
        ("anchors", "Якоря"),
        ("notes", "Заметки"),
        ("custom", "Организации"),
    ] {
        let revision = revision_of(&fixture, "Saga");
        let added = fixture
            .add_section(&section_request(&created, &revision, role, name))
            .unwrap();
        let file = workshop_file(&fixture, "Saga");
        let id = file["sections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|section| section["id"] == added.section.section_id)
            .unwrap()["storiesPropertyId"]
            .as_str()
            .unwrap_or_else(|| panic!("{role} names its stories property"))
            .to_owned();
        let section = manifest(&fixture, &format!("Saga/{name}"), name);
        let property = property_with_id(&section, &id);
        assert_eq!(property["name"], "Истории", "{role}");
        assert_eq!(
            property["config"]["targetDatabaseId"], stories["databaseId"],
            "{role}"
        );
        assert_eq!(added.workshop_revision, revision_of(&fixture, "Saga"));
    }
}

#[test]
fn the_first_universe_gives_the_stories_a_universe_relation_in_one_operation() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let added = fixture
        .add_section(&section_request(
            &created,
            &created.file_revision,
            "universes",
            "Вселенные",
        ))
        .unwrap();

    let file = workshop_file(&fixture, "Saga");
    let universes = entry(&file, "universes");
    assert!(
        universes.get("storiesPropertyId").is_none(),
        "a universe is not in stories"
    );
    let stories_entry = entry(&file, "stories");
    let property_id = stories_entry["universePropertyId"].as_str().unwrap();
    let stories = manifest(&fixture, "Saga/Истории", "Истории");
    let property = property_with_id(&stories, property_id);
    assert_eq!(property["name"], "Вселенная");
    assert_eq!(property["type"], "relation");
    assert_eq!(
        property["config"]["targetDatabaseId"],
        added.section.database_id
    );
    assert_eq!(property["config"]["maxItems"], 1, "one universe at most");
    assert!(property["config"]["inversePropertyId"].is_null());
    // The status and synopsis the stories started with are untouched.
    assert!(property_named(&stories, "Статус").is_some());
    assert!(property_named(&stories, "Синопсис").is_some());

    // The databases still read cleanly.
    let discovered = discover_vault(&fixture.vault).unwrap();
    assert!(
        discovered.diagnostics.is_empty(),
        "{:?}",
        discovered.diagnostics
    );
}

// ---------------------------------------------------------------------------
// The lazy universes: a failure or a crash at every step
// ---------------------------------------------------------------------------

fn universe_steps() -> Vec<Step> {
    vec![
        Step::JournalWritten,
        Step::BeforeDatabase(0),
        Step::DatabaseCreated(0),
        Step::BeforeManifest,
        Step::ManifestWritten,
        Step::BeforeWorkshopFile,
        Step::WorkshopFileWritten,
        Step::BeforeCompletion,
    ]
}

fn after_commit(step: &Step) -> bool {
    matches!(step, Step::WorkshopFileWritten | Step::BeforeCompletion)
}

fn assert_one_universe_link(fixture: &Fixture) {
    let stories = manifest(fixture, "Saga/Истории", "Истории");
    assert_eq!(
        count_named(&stories, "Вселенная"),
        1,
        "one relation, never two"
    );
    let file = workshop_file(fixture, "Saga");
    let universes: Vec<_> = file["sections"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|section| section["role"] == "universes")
        .collect();
    assert_eq!(universes.len(), 1);
    assert_eq!(
        entry(&file, "stories")["universePropertyId"],
        property_named(&stories, "Вселенная").unwrap()["id"]
    );
    let universe_databases = discover_vault(&fixture.vault)
        .unwrap()
        .databases
        .into_iter()
        .filter(|database| database.name == "Вселенные")
        .count();
    assert_eq!(universe_databases, 1);
}

#[test]
fn a_failure_at_any_step_of_the_first_universe_restores_both_files_byte_for_byte() {
    for target in universe_steps() {
        let fixture = Fixture::new();
        let created = fixture.create_workshop(&workshop("Saga")).unwrap();
        let before = fixture.tree();
        let journals = fixture.journal_files();
        let stories_before = fs::read(fixture.vault.join("Saga/Истории/Истории.json")).unwrap();
        let file_before = fixture.workshop_bytes("Saga");
        let request = section_request(&created, &created.file_revision, "universes", "Вселенные");

        let wanted = target.clone();
        set_step_hook(move |step| (*step == wanted).then(|| Fault::Fail("injected".to_owned())));
        let outcome = fixture.add_section(&request);
        clear_step_hook();

        if after_commit(&target) {
            outcome.unwrap_or_else(|error| panic!("{target:?}: {error}"));
            assert_one_universe_link(&fixture);
            continue;
        }
        match outcome {
            Err(ProjectError::RolledBack { message, .. }) => assert_eq!(message, "injected"),
            other => panic!("{target:?}: expected RolledBack, got {other:?}"),
        }
        assert_eq!(fixture.tree(), before, "{target:?}: the vault is as before");
        assert_eq!(
            fs::read(fixture.vault.join("Saga/Истории/Истории.json")).unwrap(),
            stories_before,
            "{target:?}: the stories manifest is as before"
        );
        assert_eq!(fixture.workshop_bytes("Saga"), file_before, "{target:?}");
        assert_eq!(
            fixture.journal_files(),
            journals,
            "{target:?}: no stale journal"
        );

        let again = fixture.add_section(&request).unwrap();
        assert!(!again.replayed);
        assert_one_universe_link(&fixture);
    }
}

#[test]
fn a_crash_at_any_step_of_the_first_universe_is_cleaned_at_activation_and_a_repeat_completes() {
    for target in universe_steps() {
        let fixture = Fixture::new();
        let created = fixture.create_workshop(&workshop("Saga")).unwrap();
        let before = fixture.tree();
        let request = section_request(&created, &created.file_revision, "universes", "Вселенные");

        let wanted = target.clone();
        set_step_hook(move |step| (*step == wanted).then_some(Fault::Crash));
        let outcome = fixture.add_section(&request);
        clear_step_hook();
        assert!(
            matches!(&outcome, Err(ProjectError::Failed { code, .. }) if code == "interrupted"),
            "{target:?}: {outcome:?}"
        );

        let report = recover_pending_projects(&fixture.vault).unwrap();
        assert!(report.quarantined.is_empty(), "{target:?}: {report:?}");
        if after_commit(&target) {
            assert_eq!((report.rolled_back, report.completed), (0, 1), "{target:?}");
        } else {
            assert_eq!((report.rolled_back, report.completed), (1, 0), "{target:?}");
            assert_eq!(
                fixture.tree(),
                before,
                "{target:?}: activation restored both"
            );
        }
        fixture.add_section(&request).unwrap();
        assert_one_universe_link(&fixture);
    }
}

#[test]
fn a_repeat_after_a_crash_reuses_the_planned_ids_of_the_workshop_and_of_the_universe() {
    // The workshop: a crash after the second database, no activation in between.
    let fixture = Fixture::new();
    let request = workshop("Saga");
    set_step_hook(|step| (*step == Step::DatabaseCreated(1)).then_some(Fault::Crash));
    let outcome = fixture.create_workshop(&request);
    clear_step_hook();
    assert!(outcome.is_err());
    let journal = read_journal(&fixture.vault, &request.operation_id)
        .unwrap()
        .expect("the journal is still there");
    let planned_ids: Vec<String> = journal
        .plan
        .sections
        .iter()
        .map(|section| section.database_id.clone())
        .collect();
    let planned_links: Vec<Option<String>> = journal
        .plan
        .sections
        .iter()
        .map(|section| section.stories_property_id.clone())
        .collect();
    assert!(planned_links[1].is_some() && planned_links[2].is_some());

    let created = fixture.create_workshop(&request).unwrap();
    assert!(!created.replayed);
    assert_eq!(
        created.workshop_id,
        journal.plan.workshop_id.clone().unwrap(),
        "the same workshop"
    );
    let ids: Vec<String> = created
        .sections
        .iter()
        .map(|section| section.database_id.clone())
        .collect();
    assert_eq!(ids, planned_ids, "the same databases");
    let file = workshop_file(&fixture, "Saga");
    assert_eq!(
        entry(&file, "characters")["storiesPropertyId"].as_str(),
        planned_links[1].as_deref(),
        "the same link property"
    );
    assert_eq!(
        entry(&file, "locations")["storiesPropertyId"].as_str(),
        planned_links[2].as_deref()
    );
    assert_eq!(fixture.workshop_bytes("Saga"), {
        let text = journal.plan.workshop_file_text.clone().unwrap();
        text.into_bytes()
    });
    assert_eq!(
        discover_vault(&fixture.vault).unwrap().databases.len(),
        3,
        "one set"
    );

    // The section: a crash after the stories manifest, no activation in between.
    let created = fixture.create_workshop(&workshop("Other")).unwrap();
    let request = section_request(&created, &created.file_revision, "universes", "Вселенные");
    set_step_hook(|step| (*step == Step::ManifestWritten).then_some(Fault::Crash));
    assert!(fixture.add_section(&request).is_err());
    clear_step_hook();
    let journal = read_journal(&fixture.vault, &request.operation_id)
        .unwrap()
        .expect("the journal is still there");
    let planned_database = journal.plan.sections[0].database_id.clone();
    let planned_manifest: Value =
        serde_json::from_str(&journal.plan.manifest_write.clone().unwrap().post_text).unwrap();
    let planned_property = property_named(&planned_manifest, "Вселенная").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let added = fixture.add_section(&request).unwrap();
    assert_eq!(added.section.database_id, planned_database);
    let file = workshop_file(&fixture, "Other");
    assert_eq!(
        entry(&file, "stories")["universePropertyId"].as_str(),
        Some(planned_property.as_str())
    );
    let stories = manifest(&fixture, "Other/Истории", "Истории");
    assert_eq!(count_named(&stories, "Вселенная"), 1);
}

// ---------------------------------------------------------------------------
// add_story_links
// ---------------------------------------------------------------------------

#[test]
fn a_section_that_already_has_the_relation_adopts_it_and_only_the_file_changes() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let recorded = workshop_file(&fixture, "Saga");
    let planned_id = entry(&recorded, "characters")["storiesPropertyId"]
        .as_str()
        .unwrap()
        .to_owned();
    let revision = forget_links(&fixture, "Saga", false);
    let manifest_before = fs::read(fixture.vault.join("Saga/Персонажи/Персонажи.json")).unwrap();

    let added = add_story_links(
        &fixture.env(),
        &links_request(&created, &revision, "characters"),
    )
    .unwrap();
    assert_eq!(added.link, "stories");
    assert_eq!(added.property_id, planned_id, "the relation that was there");
    assert_eq!(
        fs::read(fixture.vault.join("Saga/Персонажи/Персонажи.json")).unwrap(),
        manifest_before,
        "the database is not touched"
    );
    let file = workshop_file(&fixture, "Saga");
    assert_eq!(entry(&file, "characters")["storiesPropertyId"], planned_id);
    assert_eq!(added.workshop_revision, revision_of(&fixture, "Saga"));
    assert!(entry(&file, "locations").get("storiesPropertyId").is_none());
}

#[test]
fn a_section_without_the_relation_gets_one_and_the_file_names_it() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    forget_links(&fixture, "Saga", false);
    remove_property(&fixture, "Saga/Персонажи", "Персонажи", "Истории");
    let revision = revision_of(&fixture, "Saga");
    let stories = manifest(&fixture, "Saga/Истории", "Истории");

    let added = add_story_links(
        &fixture.env(),
        &links_request(&created, &revision, "characters"),
    )
    .unwrap();
    let characters = manifest(&fixture, "Saga/Персонажи", "Персонажи");
    let property = property_with_id(&characters, &added.property_id);
    assert_eq!(property["name"], "Истории");
    assert_eq!(
        property["config"]["targetDatabaseId"],
        stories["databaseId"]
    );
    assert_eq!(count_named(&characters, "Истории"), 1);
    assert_eq!(
        entry(&workshop_file(&fixture, "Saga"), "characters")["storiesPropertyId"],
        added.property_id
    );
    // The database layer accepts the result.
    let discovered = discover_vault(&fixture.vault).unwrap();
    assert!(
        discovered.diagnostics.is_empty(),
        "{:?}",
        discovered.diagnostics
    );
}

#[test]
fn the_stories_section_is_linked_to_universes_only_once_they_exist() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let request = links_request(&created, &created.file_revision, "stories");
    assert!(matches!(
        add_story_links(&fixture.env(), &request),
        Err(ProjectError::StoryLinksUnavailable { .. })
    ));

    fixture
        .add_section(&section_request(
            &created,
            &created.file_revision,
            "universes",
            "Вселенные",
        ))
        .unwrap();
    let recorded = entry(&workshop_file(&fixture, "Saga"), "stories")["universePropertyId"]
        .as_str()
        .unwrap()
        .to_owned();

    // An older workshop that has the relation but not the ID in its file: it is adopted.
    let revision = forget_links(&fixture, "Saga", false);
    let adopted = add_story_links(
        &fixture.env(),
        &links_request(&created, &revision, "stories"),
    )
    .unwrap();
    assert_eq!(adopted.link, "universe");
    assert_eq!(adopted.property_id, recorded);

    // Without the relation a new one is made, still one universe at most.
    forget_links(&fixture, "Saga", false);
    remove_property(&fixture, "Saga/Истории", "Истории", "Вселенная");
    let revision = revision_of(&fixture, "Saga");
    let made = add_story_links(
        &fixture.env(),
        &links_request(&created, &revision, "stories"),
    )
    .unwrap();
    let stories = manifest(&fixture, "Saga/Истории", "Истории");
    let property = property_with_id(&stories, &made.property_id);
    assert_eq!(property["config"]["maxItems"], 1);
    assert_eq!(count_named(&stories, "Вселенная"), 1);
}

#[test]
fn the_request_is_checked_before_anything_is_written() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let revision = forget_links(&fixture, "Saga", false);
    let before = fixture.tree();
    let journals = fixture.journal_files();

    // A stale revision.
    let mut request = links_request(&created, &created.file_revision, "characters");
    assert!(matches!(
        add_story_links(&fixture.env(), &request),
        Err(ProjectError::RevisionConflict { actual_revision }) if actual_revision == revision
    ));
    // An unknown section, universes, a label that is not a link label, a bad operation ID.
    request = links_request(&created, &revision, "nowhere");
    assert!(matches!(
        add_story_links(&fixture.env(), &request),
        Err(ProjectError::SectionNotFound { .. })
    ));
    fixture
        .add_section(&section_request(
            &created,
            &revision,
            "universes",
            "Вселенные",
        ))
        .unwrap();
    let revision = revision_of(&fixture, "Saga");
    let before_universes = fixture.tree();
    request = links_request(&created, &revision, "universes");
    assert!(matches!(
        add_story_links(&fixture.env(), &request),
        Err(ProjectError::StoryLinksUnavailable { .. })
    ));
    request = links_request(&created, &revision, "characters");
    request
        .labels
        .insert("section:stories".to_owned(), "x".to_owned());
    assert!(matches!(
        add_story_links(&fixture.env(), &request),
        Err(ProjectError::InvalidName { .. })
    ));
    request.labels.clear();
    request.operation_id = "bad id".to_owned();
    assert!(matches!(
        add_story_links(&fixture.env(), &request),
        Err(ProjectError::InvalidOperationId)
    ));
    assert_eq!(fixture.tree(), before_universes);
    assert!(before.len() < before_universes.len());
    assert_eq!(
        fixture.journal_files().len(),
        journals.len() + 1,
        "only the universes' own"
    );
}

#[test]
fn linking_twice_is_refused_and_the_same_operation_is_answered_from_the_record() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let revision = forget_links(&fixture, "Saga", false);
    let request = links_request(&created, &revision, "characters");
    let first = add_story_links(&fixture.env(), &request).unwrap();
    assert!(!first.replayed);

    let again = add_story_links(&fixture.env(), &request).unwrap();
    assert!(again.replayed);
    assert_eq!(again.property_id, first.property_id);
    assert_eq!(
        AddedStoryLinks {
            replayed: false,
            ..again
        },
        first
    );

    let mut other = request.clone();
    other.section_id = "locations".to_owned();
    assert!(matches!(
        add_story_links(&fixture.env(), &other),
        Err(ProjectError::OperationIdReused { .. })
    ));
    let next = links_request(&created, &first.workshop_revision, "characters");
    assert!(matches!(
        add_story_links(&fixture.env(), &next),
        Err(ProjectError::StoryLinksAlreadyConfigured)
    ));
}

#[test]
fn unknown_fields_and_the_bom_of_the_workshop_file_survive_the_link() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    forget_links(&fixture, "Saga", true);
    let revision = rewrite_json(
        &fixture.vault.join("Saga").join(WORKSHOP_FILE_NAME),
        true,
        |file| {
            file["x-other-app"] = json!({"keep": [1, 2, 3]});
            file["sections"][1]["x-note"] = json!("hand written");
        },
    );
    remove_property(&fixture, "Saga/Персонажи", "Персонажи", "Истории");

    let added = add_story_links(
        &fixture.env(),
        &links_request(&created, &revision, "characters"),
    )
    .unwrap();
    let bytes = fixture.workshop_bytes("Saga");
    assert!(bytes.starts_with(b"\xEF\xBB\xBF"), "the BOM stays");
    assert_eq!(added.workshop_revision, raw_revision(&bytes));
    let file: Value = serde_json::from_slice(&bytes[3..]).unwrap();
    assert_eq!(file["x-other-app"]["keep"], json!([1, 2, 3]));
    assert_eq!(file["sections"][1]["x-note"], "hand written");
    assert_eq!(
        file["sections"][1]["storiesPropertyId"],
        Value::String(added.property_id)
    );
    // A snapshot of the file before the rewrite exists in history.
    let history = fixture.vault.join(".amby");
    assert!(history.exists());
}

fn links_steps() -> Vec<Step> {
    vec![
        Step::JournalWritten,
        Step::BeforeManifest,
        Step::ManifestWritten,
        Step::BeforeWorkshopFile,
        Step::WorkshopFileWritten,
        Step::BeforeCompletion,
    ]
}

fn prepared_without_relation() -> (Fixture, CreatedWorkshop, String) {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    forget_links(&fixture, "Saga", false);
    remove_property(&fixture, "Saga/Персонажи", "Персонажи", "Истории");
    let revision = revision_of(&fixture, "Saga");
    (fixture, created, revision)
}

fn assert_one_stories_link(fixture: &Fixture) {
    let characters = manifest(fixture, "Saga/Персонажи", "Персонажи");
    assert_eq!(count_named(&characters, "Истории"), 1);
    assert_eq!(
        entry(&workshop_file(fixture, "Saga"), "characters")["storiesPropertyId"],
        property_named(&characters, "Истории").unwrap()["id"]
    );
}

#[test]
fn a_failure_at_any_step_of_linking_restores_both_files_and_the_retry_links_once() {
    for target in links_steps() {
        let (fixture, created, revision) = prepared_without_relation();
        let before = fixture.tree();
        let journals = fixture.journal_files();
        let request = links_request(&created, &revision, "characters");

        let wanted = target.clone();
        set_step_hook(move |step| (*step == wanted).then(|| Fault::Fail("injected".to_owned())));
        let outcome = add_story_links(&fixture.env(), &request);
        clear_step_hook();

        if after_commit(&target) {
            outcome.unwrap_or_else(|error| panic!("{target:?}: {error}"));
            assert_one_stories_link(&fixture);
            continue;
        }
        match outcome {
            Err(ProjectError::RolledBack { message, .. }) => assert_eq!(message, "injected"),
            other => panic!("{target:?}: expected RolledBack, got {other:?}"),
        }
        assert_eq!(fixture.tree(), before, "{target:?}: both files as before");
        assert_eq!(
            fixture.journal_files(),
            journals,
            "{target:?}: no stale journal"
        );
        assert!(!add_story_links(&fixture.env(), &request).unwrap().replayed);
        assert_one_stories_link(&fixture);
    }
}

#[test]
fn a_crash_at_any_step_of_linking_is_cleaned_at_activation_and_a_repeat_completes() {
    for target in links_steps() {
        let (fixture, created, revision) = prepared_without_relation();
        let before = fixture.tree();
        let request = links_request(&created, &revision, "characters");

        let wanted = target.clone();
        set_step_hook(move |step| (*step == wanted).then_some(Fault::Crash));
        let outcome = add_story_links(&fixture.env(), &request);
        clear_step_hook();
        assert!(outcome.is_err(), "{target:?}");

        let report = recover_pending_projects(&fixture.vault).unwrap();
        assert!(report.quarantined.is_empty(), "{target:?}: {report:?}");
        if !after_commit(&target) {
            assert_eq!(fixture.tree(), before, "{target:?}");
        }
        let again = add_story_links(&fixture.env(), &request).unwrap();
        assert_eq!(again.replayed, after_commit(&target), "{target:?}");
        assert_one_stories_link(&fixture);
    }
}

#[test]
fn a_repeat_after_an_unrecovered_crash_links_with_the_planned_property() {
    let (fixture, created, revision) = prepared_without_relation();
    let request = links_request(&created, &revision, "characters");
    set_step_hook(|step| (*step == Step::ManifestWritten).then_some(Fault::Crash));
    assert!(add_story_links(&fixture.env(), &request).is_err());
    clear_step_hook();
    let journal = read_journal(&fixture.vault, &request.operation_id)
        .unwrap()
        .unwrap();
    let planned: AddedStoryLinks = serde_json::from_value(journal.expected_result).unwrap();

    let added = add_story_links(&fixture.env(), &request).unwrap();
    assert_eq!(added.property_id, planned.property_id);
    assert_one_stories_link(&fixture);
}

#[test]
fn a_database_the_author_edited_in_the_meantime_is_left_alone() {
    let (fixture, created, revision) = prepared_without_relation();
    let request = links_request(&created, &revision, "characters");
    set_step_hook(|step| (*step == Step::ManifestWritten).then_some(Fault::Crash));
    assert!(add_story_links(&fixture.env(), &request).is_err());
    clear_step_hook();
    // The author renamed the property after the crash.
    let path = fixture.vault.join("Saga/Персонажи/Персонажи.json");
    rewrite_json(&path, false, |manifest| {
        for property in manifest["properties"].as_array_mut().unwrap() {
            if property["name"] == "Истории" {
                property["name"] = json!("Мои истории");
            }
        }
    });
    let edited = fs::read(&path).unwrap();
    let outcome = add_story_links(&fixture.env(), &request);
    assert!(
        matches!(outcome, Err(ProjectError::RecoveryRequired { .. })),
        "{outcome:?}"
    );
    assert_eq!(fs::read(&path).unwrap(), edited, "the edit is kept");
}

// ---------------------------------------------------------------------------
// Pages born linked
// ---------------------------------------------------------------------------

fn entity(
    created: &CreatedWorkshop,
    section: &str,
    title: &str,
    story_id: Option<&str>,
) -> CreateWorkshopEntityRequest {
    CreateWorkshopEntityRequest {
        expected_generation: 1,
        workshop_id: created.workshop_id.clone(),
        section_id: section.to_owned(),
        title: title.to_owned(),
        story_id: story_id.map(str::to_owned),
        notebook: None,
    }
}

fn frontmatter_of(path: &str) -> serde_yaml::Mapping {
    crate::frontmatter::frontmatter_yaml_mapping(&fs::read_to_string(path).unwrap())
        .unwrap()
        .expect("a frontmatter")
}

#[test]
fn a_page_made_in_a_story_carries_the_link_to_its_card_from_the_first_write() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let house = fixture
        .create_story(&story(&created.workshop_id, "Дом"))
        .unwrap();

    let linked = create_entity(
        &fixture.env(),
        &entity(&created, "characters", "Анна", Some(&house.story_id)),
    )
    .unwrap();
    assert_eq!(
        linked.linked_story_id.as_deref(),
        Some(house.story_id.as_str())
    );
    let mapping = frontmatter_of(&linked.note_path);
    let stories: Vec<String> = mapping
        .get("Истории")
        .and_then(serde_yaml::Value::as_sequence)
        .expect("the stories relation is in the note")
        .iter()
        .filter_map(serde_yaml::Value::as_str)
        .map(str::to_owned)
        .collect();
    assert_eq!(stories, std::slice::from_ref(&house.card_note_id));
    assert_eq!(
        mapping
            .get("amby-title")
            .and_then(serde_yaml::Value::as_str),
        Some("Анна")
    );

    // Without a story nothing is linked.
    let free = create_entity(
        &fixture.env(),
        &entity(&created, "characters", "Борис", None),
    )
    .unwrap();
    assert_eq!(free.linked_story_id, None);
    assert!(frontmatter_of(&free.note_path).get("Истории").is_none());
}

#[test]
fn a_page_cannot_be_linked_where_the_section_has_no_link_or_the_story_is_unknown() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let house = fixture
        .create_story(&story(&created.workshop_id, "Дом"))
        .unwrap();

    assert!(matches!(
        create_entity(
            &fixture.env(),
            &entity(&created, "characters", "Анна", Some("01NOSTORY"))
        ),
        Err(ProjectError::StoryNotFound { .. })
    ));
    assert!(matches!(
        create_entity(&fixture.env(), &entity(&created, "nowhere", "Анна", None)),
        Err(ProjectError::SectionNotFound { .. })
    ));
    assert!(matches!(
        create_entity(&fixture.env(), &entity(&created, "stories", "Анна", None)),
        Err(ProjectError::UnsupportedRole { .. })
    ));

    // A workshop from before the links: the file names no property, so no link is written.
    forget_links(&fixture, "Saga", false);
    let before = fixture.tree();
    assert!(matches!(
        create_entity(
            &fixture.env(),
            &entity(&created, "characters", "Анна", Some(&house.story_id))
        ),
        Err(ProjectError::StoryLinksUnavailable { .. })
    ));
    assert_eq!(fixture.tree(), before, "nothing was written");
    // Without a story such a page is still made.
    create_entity(
        &fixture.env(),
        &entity(&created, "characters", "Анна", None),
    )
    .unwrap();
}

/// W10: two pages with one title in one shared database get two files and keep one title.
#[test]
fn two_pages_with_one_title_in_a_shared_database_get_two_files_and_show_one_title() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let house = fixture
        .create_story(&story(&created.workshop_id, "Дом"))
        .unwrap();
    let forest = fixture
        .create_story(&story(&created.workshop_id, "Лес"))
        .unwrap();

    let first = create_entity(
        &fixture.env(),
        &entity(&created, "characters", "Финал", Some(&house.story_id)),
    )
    .unwrap();
    let second = create_entity(
        &fixture.env(),
        &entity(&created, "characters", "Финал", Some(&forest.story_id)),
    )
    .unwrap();
    let third = create_entity(
        &fixture.env(),
        &entity(&created, "characters", "Финал", None),
    )
    .unwrap();

    let names: Vec<String> = [&first, &second, &third]
        .iter()
        .map(|page| {
            std::path::Path::new(&page.note_path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert_eq!(names, ["Финал.md", "Финал 2.md", "Финал 3.md"]);
    assert_ne!(first.note_id, second.note_id);
    for page in [&first, &second, &third] {
        assert_eq!(
            frontmatter_of(&page.note_path)
                .get("amby-title")
                .and_then(serde_yaml::Value::as_str),
            Some("Финал")
        );
    }

    // The note index (search, links, tabs) and the database rows both say "Финал" for each.
    let connection = Connection::open_in_memory().unwrap();
    init_schema(&connection).unwrap();
    crate::index::sync::sync_vault(&connection, &fixture.vault).unwrap();
    crate::database::projection::rebuild_database_projection(&connection, &fixture.vault).unwrap();
    for page in [&first, &second, &third] {
        let title: String = connection
            .query_row(
                "SELECT title FROM notes WHERE id = ?1",
                [&page.note_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Финал");
    }
    let rows = crate::database::query::query_database(
        &connection,
        &crate::database::model::DatabaseQueryRequest {
            expected_generation: 1,
            database_id: first.database_id.clone(),
            source: crate::database::model::DatabaseQuerySource::Inline {
                spec: crate::database::model::DatabaseQuerySpec {
                    filter: None,
                    sorts: Vec::new(),
                },
            },
            page: crate::database::model::DatabasePageRequest {
                limit: 50,
                cursor: None,
            },
            search: None,
            sorts: None,
            filter: None,
            manual_order: None,
            context_page_id: None,
        },
    )
    .unwrap()
    .rows;
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().all(|row| row.title == "Финал"));
    let mut paths: Vec<_> = rows.iter().map(|row| row.relative_path.clone()).collect();
    paths.sort();
    paths.dedup();
    assert_eq!(paths.len(), 3, "three files");

    // The same holds in another shared database, and the files do not clash across them.
    let place = create_entity(
        &fixture.env(),
        &entity(&created, "locations", "Финал", None),
    )
    .unwrap();
    assert!(place.note_path.ends_with("Локации/Финал.md"));
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

#[test]
fn an_older_index_gets_the_link_columns_and_is_rebuilt_from_the_files() {
    let fixture = Fixture::new();
    fixture.create_workshop(&workshop("Saga")).unwrap();
    let connection = Connection::open_in_memory().unwrap();
    // A cache written before the columns existed.
    connection
        .execute_batch(
            "CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE project_workshops (
                workshop_id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                icon TEXT, tags_json TEXT NOT NULL, file_revision TEXT NOT NULL,
                format_version INTEGER NOT NULL, read_only INTEGER NOT NULL, position INTEGER NOT NULL);
             CREATE TABLE project_sections (
                workshop_id TEXT NOT NULL REFERENCES project_workshops(workshop_id) ON DELETE CASCADE,
                section_id TEXT NOT NULL, position INTEGER NOT NULL, role TEXT NOT NULL,
                name TEXT NOT NULL, database_id TEXT NOT NULL, path_hint TEXT NOT NULL,
                PRIMARY KEY (workshop_id, section_id));
             INSERT INTO index_metadata VALUES ('project_index_epoch', 'old');",
        )
        .unwrap();
    init_schema(&connection).unwrap();
    let columns: Vec<String> = connection
        .prepare("SELECT name FROM pragma_table_info('project_sections')")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(columns.contains(&"stories_property_id".to_owned()));
    assert!(columns.contains(&"universe_property_id".to_owned()));

    // The old epoch is gone, so the next read rebuilds and fills the columns.
    let catalog = load_catalog(&connection, &fixture.vault, 1).unwrap();
    assert_ne!(catalog.index_epoch, "old");
    let characters = catalog.workshops[0]
        .sections
        .iter()
        .find(|section| section.role == "characters")
        .unwrap();
    assert!(characters.stories_property_id.is_some());
    // Widening twice is harmless.
    init_schema(&connection).unwrap();
}

// ---------------------------------------------------------------------------
// Notebooks: pages born in a folder of the notes base
// ---------------------------------------------------------------------------

fn note_in(
    created: &CreatedWorkshop,
    title: &str,
    story_id: Option<&str>,
    notebook: &[&str],
) -> CreateWorkshopEntityRequest {
    let mut request = entity(created, "notes", title, story_id);
    request.notebook = Some(notebook.iter().map(|name| (*name).to_owned()).collect());
    request
}

fn workshop_with_notes(fixture: &Fixture) -> (CreatedWorkshop, String) {
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let added = fixture
        .add_section(&notes_request(&created, "Заметки"))
        .unwrap();
    assert_eq!(added.section.section_id, "notes");
    (created, added.section.container_path)
}

#[test]
fn a_note_made_in_a_notebook_lies_in_its_folder_stays_a_row_of_the_notes_base_and_keeps_its_story()
{
    let fixture = Fixture::new();
    let (created, container) = workshop_with_notes(&fixture);
    let house = fixture
        .create_story(&story(&created.workshop_id, "Дом"))
        .unwrap();
    fs::create_dir_all(fixture.vault.join(&container).join("Идеи/Сюжеты")).unwrap();

    let nested = create_entity(
        &fixture.env(),
        &note_in(
            &created,
            "Поворот",
            Some(&house.story_id),
            &["Идеи", "Сюжеты"],
        ),
    )
    .unwrap();
    let top = create_entity(
        &fixture.env(),
        &note_in(&created, "Поворот", None, &["Идеи"]),
    )
    .unwrap();
    let root = create_entity(&fixture.env(), &entity(&created, "notes", "Поворот", None)).unwrap();
    let root_empty_list = {
        let mut request = entity(&created, "notes", "Второй", None);
        request.notebook = Some(Vec::new());
        create_entity(&fixture.env(), &request).unwrap()
    };

    let folder = fixture.vault.join(&container);
    assert_eq!(
        std::path::Path::new(&nested.note_path),
        folder.join("Идеи/Сюжеты/Поворот.md")
    );
    assert_eq!(
        std::path::Path::new(&top.note_path),
        folder.join("Идеи/Поворот.md"),
        "the same name in another notebook is not renamed"
    );
    assert_eq!(
        std::path::Path::new(&root.note_path),
        folder.join("Поворот.md")
    );
    assert_eq!(
        std::path::Path::new(&root_empty_list.note_path),
        folder.join("Второй.md"),
        "an empty list is the root of the base"
    );
    assert_eq!(
        nested.linked_story_id.as_deref(),
        Some(house.story_id.as_str())
    );
    let stories = frontmatter_of(&nested.note_path)
        .get("Истории")
        .and_then(serde_yaml::Value::as_sequence)
        .expect("the story link is written with the note")
        .len();
    assert_eq!(stories, 1);

    // The discovery sees every note as a row of the one notes base, with its notebook as the
    // category path.
    let discovery = discover_vault(&fixture.vault).unwrap();
    let place = |note_id: &str| {
        let note = discovery
            .notes
            .iter()
            .find(|note| note.note_id.as_deref() == Some(note_id))
            .expect("the note is discovered");
        (note.owner_database_id.clone(), note.category_path.clone())
    };
    let base = Some(nested.database_id.clone());
    assert_eq!(
        place(&nested.note_id),
        (base.clone(), vec!["Идеи".to_owned(), "Сюжеты".to_owned()])
    );
    assert_eq!(place(&top.note_id), (base.clone(), vec!["Идеи".to_owned()]));
    assert_eq!(place(&root.note_id), (base, Vec::<String>::new()));
}

#[test]
fn a_notebook_that_is_not_an_ordinary_folder_of_the_notes_base_is_refused_before_any_write() {
    let fixture = Fixture::new();
    let (created, container) = workshop_with_notes(&fixture);
    let house = fixture
        .create_story(&story(&created.workshop_id, "Дом"))
        .unwrap();
    let folder = fixture.vault.join(&container);
    fs::create_dir_all(folder.join("Идеи")).unwrap();
    fs::write(folder.join("Файл"), "x").unwrap();
    fs::create_dir_all(folder.join("Папка заметки")).unwrap();
    fs::write(folder.join("Папка заметки/Папка заметки.md"), "x").unwrap();
    // A folder of another base, beside the notes base, and one outside the vault.
    fs::create_dir_all(fixture.vault.join("Saga/Чужая")).unwrap();
    let before = fixture.tree();

    let refused = |segments: &[&str]| {
        let result = create_entity(
            &fixture.env(),
            &note_in(&created, "Заметка", Some(&house.story_id), segments),
        );
        assert!(
            matches!(
                result,
                Err(ProjectError::InvalidName { .. } | ProjectError::InvalidParent { .. })
            ),
            "{segments:?} must be refused, got {result:?}"
        );
        assert_eq!(fixture.tree(), before, "{segments:?} wrote something");
    };
    refused(&[".."]);
    refused(&["Идеи", ".."]);
    refused(&["..", "Персонажи"]);
    refused(&["../Чужая"]);
    refused(&["Идеи/Сюжеты"]);
    refused(&["Ид:еи"]);
    refused(&[""]);
    refused(&[" Идеи"]);
    refused(&[".скрытая"]);
    refused(&["Нет такой"]);
    refused(&["Идеи", "Нет такой"]);
    refused(&["Файл"]);
    refused(&["Папка заметки"]);
    refused(&["Чужая"]);

    // Only the notes base has notebooks.
    let mut elsewhere = entity(&created, "characters", "Анна", None);
    elsewhere.notebook = Some(vec!["Идеи".to_owned()]);
    assert!(matches!(
        create_entity(&fixture.env(), &elsewhere),
        Err(ProjectError::InvalidParent { .. })
    ));
    assert_eq!(fixture.tree(), before);
}

#[cfg(unix)]
#[test]
fn a_notebook_that_is_a_link_to_a_folder_outside_the_base_is_refused() {
    let fixture = Fixture::new();
    let (created, container) = workshop_with_notes(&fixture);
    let outside = std::env::temp_dir().join(format!("amby-outside-{}", ulid::Ulid::generate()));
    fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, fixture.vault.join(&container).join("Ссылка")).unwrap();
    let before = fixture.tree();

    let result = create_entity(
        &fixture.env(),
        &note_in(&created, "Заметка", None, &["Ссылка"]),
    );
    assert!(matches!(result, Err(ProjectError::InvalidParent { .. })));
    assert_eq!(fixture.tree(), before);
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    fs::remove_dir_all(&outside).ok();
}
