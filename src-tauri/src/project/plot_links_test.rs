//! `ensure_plot_links` and the places that make the arcs and anchors links at birth, through real
//! files: the text of a story gets its "Anchors" and "Arcs" relations, the anchors database its
//! "Arcs" and "Universe", whichever database was made first.

use std::collections::BTreeMap;
use std::fs;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::create::{clear_step_hook, set_step_hook, Fault, Step};
use super::create_test::{op, story, workshop, Fixture};
use super::index::{load_catalog, rebuild_project_index};
use super::journal::read_journal;
use super::links::{create_entity, ensure_plot_links};
use super::links_test::{
    after_commit, count_named, entry, frontmatter_of, manifest, property_named, property_with_id,
    revision_of, rewrite_json, section_request, workshop_file,
};
use super::model::{
    CreateWorkshopEntityRequest, CreatedStory, CreatedWorkshop, EnsurePlotLinksRequest,
    EnsuredPlotLinks, PlotLinksTarget, ProjectError, STORY_FILE_NAME, WORKSHOP_FILE_NAME,
};
use super::recovery::recover_pending_projects;
use crate::database::discovery::discover_vault;
use crate::database::format::raw_revision;
use crate::index::schema::init_schema;

const HOUSE: &str = "Saga/Истории/Дом";

fn add(fixture: &Fixture, created: &CreatedWorkshop, role: &str, name: &str) {
    let revision = revision_of(fixture, "Saga");
    fixture
        .add_section(&section_request(created, &revision, role, name))
        .unwrap();
}

fn story_manifest(fixture: &Fixture) -> Value {
    manifest(fixture, HOUSE, "Дом")
}

fn story_file(fixture: &Fixture) -> Value {
    serde_json::from_slice(&fixture.story_bytes(HOUSE)).unwrap()
}

fn story_revision(fixture: &Fixture) -> String {
    raw_revision(&fixture.story_bytes(HOUSE))
}

fn database_of(fixture: &Fixture, role: &str) -> String {
    entry(&workshop_file(fixture, "Saga"), role)["databaseId"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn for_story(
    created: &CreatedWorkshop,
    house: &CreatedStory,
    revision: &str,
) -> EnsurePlotLinksRequest {
    EnsurePlotLinksRequest {
        expected_generation: 1,
        operation_id: op("plot"),
        workshop_id: created.workshop_id.clone(),
        target: PlotLinksTarget::Story,
        story_id: Some(house.story_id.clone()),
        expected_revision: revision.to_owned(),
        labels: BTreeMap::new(),
    }
}

fn for_anchors(created: &CreatedWorkshop, revision: &str) -> EnsurePlotLinksRequest {
    EnsurePlotLinksRequest {
        expected_generation: 1,
        operation_id: op("plot"),
        workshop_id: created.workshop_id.clone(),
        target: PlotLinksTarget::Anchors,
        story_id: None,
        expected_revision: revision.to_owned(),
        labels: BTreeMap::new(),
    }
}

/// A workshop with one story "Дом" and the anchors and arcs databases, made after the story.
fn with_plot() -> (Fixture, CreatedWorkshop, CreatedStory) {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let house = fixture
        .create_story(&story(&created.workshop_id, "Дом"))
        .unwrap();
    add(&fixture, &created, "anchors", "Якоря");
    add(&fixture, &created, "arcs", "Арки");
    (fixture, created, house)
}

fn assert_relation(manifest: &Value, id: &str, name: &str, target: &str) {
    let property = property_with_id(manifest, id);
    assert_eq!(property["name"], name);
    assert_eq!(property["type"], "relation");
    assert_eq!(property["config"]["targetDatabaseId"], target);
    assert!(property["config"]["maxItems"].is_null(), "any number");
    assert!(property["config"]["inversePropertyId"].is_null(), "one way");
}

fn assert_clean_databases(fixture: &Fixture) {
    let discovered = discover_vault(&fixture.vault).unwrap();
    assert!(
        discovered.diagnostics.is_empty(),
        "{:?}",
        discovered.diagnostics
    );
}

// ---------------------------------------------------------------------------
// The text of a story
// ---------------------------------------------------------------------------

#[test]
fn the_text_of_a_story_gets_its_anchors_and_arcs_and_the_file_names_them() {
    let (fixture, created, house) = with_plot();
    let anchors_db = database_of(&fixture, "anchors");
    let arcs_db = database_of(&fixture, "arcs");
    let before = story_manifest(&fixture);

    let request = for_story(&created, &house, &house.story_file_revision);
    let ensured = ensure_plot_links(&fixture.env(), &request).unwrap();
    assert!(ensured.changed && !ensured.replayed);
    assert_eq!(ensured.story_id.as_deref(), Some(house.story_id.as_str()));
    let anchors_id = ensured.anchors_property_id.clone().unwrap();
    let arcs_id = ensured.arcs_property_id.clone().unwrap();

    let after = story_manifest(&fixture);
    assert_relation(&after, &anchors_id, "Якоря", &anchors_db);
    assert_relation(&after, &arcs_id, "Арки", &arcs_db);
    assert_eq!(
        after["properties"].as_array().unwrap().len(),
        before["properties"].as_array().unwrap().len() + 2
    );
    // The five system properties are untouched and still come first.
    assert_eq!(
        &after["properties"].as_array().unwrap()[..5],
        &before["properties"].as_array().unwrap()[..5]
    );

    let file = story_file(&fixture);
    assert_eq!(file["text"]["properties"]["anchors"], anchors_id);
    assert_eq!(file["text"]["properties"]["arcs"], arcs_id);
    assert_eq!(ensured.revision, story_revision(&fixture));
    assert_clean_databases(&fixture);

    // The catalog the interface reads carries the same IDs.
    let connection = Connection::open_in_memory().unwrap();
    init_schema(&connection).unwrap();
    crate::index::sync::sync_vault(&connection, &fixture.vault).unwrap();
    crate::database::projection::rebuild_database_projection(&connection, &fixture.vault).unwrap();
    rebuild_project_index(&connection, &fixture.vault).unwrap();
    let catalog = load_catalog(&connection, &fixture.vault, 1).unwrap();
    let properties = &catalog.workshops[0].stories[0]
        .text
        .as_ref()
        .unwrap()
        .properties;
    assert_eq!(properties.anchors.as_deref(), Some(anchors_id.as_str()));
    assert_eq!(properties.arcs.as_deref(), Some(arcs_id.as_str()));
}

#[test]
fn only_the_links_whose_database_exists_are_made_and_the_rest_come_later() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let house = fixture
        .create_story(&story(&created.workshop_id, "Дом"))
        .unwrap();
    // Nothing to link to yet: nothing is written, and no journal is left.
    let tree = fixture.tree();
    let journals = fixture.journal_files();
    let none = ensure_plot_links(
        &fixture.env(),
        &for_story(&created, &house, &house.story_file_revision),
    )
    .unwrap();
    assert!(!none.changed);
    assert_eq!(
        (none.anchors_property_id, none.arcs_property_id),
        (None, None)
    );
    assert_eq!(fixture.tree(), tree);
    assert_eq!(fixture.journal_files(), journals);

    add(&fixture, &created, "anchors", "Якоря");
    let first = ensure_plot_links(
        &fixture.env(),
        &for_story(&created, &house, &house.story_file_revision),
    )
    .unwrap();
    assert!(first.changed);
    let anchors_id = first.anchors_property_id.clone().unwrap();
    assert!(first.arcs_property_id.is_none());

    add(&fixture, &created, "arcs", "Арки");
    let second = ensure_plot_links(
        &fixture.env(),
        &for_story(&created, &house, &first.revision),
    )
    .unwrap();
    assert!(second.changed);
    assert_eq!(
        second.anchors_property_id.as_deref(),
        Some(anchors_id.as_str())
    );
    let manifest = story_manifest(&fixture);
    assert_eq!(count_named(&manifest, "Якоря"), 1);
    assert_eq!(count_named(&manifest, "Арки"), 1);
    assert_eq!(
        story_file(&fixture)["text"]["properties"]["arcs"],
        second.arcs_property_id.clone().unwrap()
    );
}

#[test]
fn a_relation_the_text_already_has_is_adopted_and_only_the_file_changes() {
    let (fixture, created, house) = with_plot();
    let first = ensure_plot_links(
        &fixture.env(),
        &for_story(&created, &house, &house.story_file_revision),
    )
    .unwrap();
    // The story file forgets its IDs, as one from before the links would.
    let revision = rewrite_json(
        &fixture.vault.join(HOUSE).join(STORY_FILE_NAME),
        false,
        |file| {
            let properties = file["text"]["properties"].as_object_mut().unwrap();
            properties.remove("anchors");
            properties.remove("arcs");
        },
    );
    let manifest_before = fs::read(fixture.vault.join(HOUSE).join("Дом.json")).unwrap();

    let adopted =
        ensure_plot_links(&fixture.env(), &for_story(&created, &house, &revision)).unwrap();
    assert!(adopted.changed);
    assert_eq!(adopted.anchors_property_id, first.anchors_property_id);
    assert_eq!(adopted.arcs_property_id, first.arcs_property_id);
    assert_eq!(
        fs::read(fixture.vault.join(HOUSE).join("Дом.json")).unwrap(),
        manifest_before,
        "the database is not touched"
    );
    assert_eq!(
        story_file(&fixture)["text"]["properties"]["anchors"],
        first.anchors_property_id.unwrap()
    );
}

#[test]
fn a_property_the_author_deleted_is_made_again_and_recorded() {
    let (fixture, created, house) = with_plot();
    let first = ensure_plot_links(
        &fixture.env(),
        &for_story(&created, &house, &house.story_file_revision),
    )
    .unwrap();
    rewrite_json(
        &fixture.vault.join(HOUSE).join("Дом.json"),
        false,
        |manifest| {
            manifest["properties"]
                .as_array_mut()
                .unwrap()
                .retain(|property| property["name"] != "Якоря");
        },
    );

    let again = ensure_plot_links(
        &fixture.env(),
        &for_story(&created, &house, &first.revision),
    )
    .unwrap();
    assert!(again.changed);
    assert_ne!(again.anchors_property_id, first.anchors_property_id);
    assert_eq!(
        again.arcs_property_id, first.arcs_property_id,
        "the other stays"
    );
    let manifest = story_manifest(&fixture);
    assert_eq!(count_named(&manifest, "Якоря"), 1);
    assert_eq!(
        story_file(&fixture)["text"]["properties"]["anchors"],
        again.anchors_property_id.unwrap()
    );
}

#[test]
fn when_nothing_is_missing_nothing_is_written_even_for_a_stale_revision() {
    let (fixture, created, house) = with_plot();
    ensure_plot_links(
        &fixture.env(),
        &for_story(&created, &house, &house.story_file_revision),
    )
    .unwrap();
    let tree = fixture.tree();
    let journals = fixture.journal_files();

    let again = ensure_plot_links(
        &fixture.env(),
        &for_story(&created, &house, &house.story_file_revision),
    )
    .unwrap();
    assert!(!again.changed && !again.replayed);
    assert!(again.anchors_property_id.is_some() && again.arcs_property_id.is_some());
    assert_eq!(again.revision, story_revision(&fixture));
    assert_eq!(fixture.tree(), tree);
    assert_eq!(fixture.journal_files(), journals);
}

#[test]
fn the_request_is_checked_before_anything_is_written() {
    let (fixture, created, house) = with_plot();
    let before = fixture.tree();
    let journals = fixture.journal_files();
    let current = story_revision(&fixture);

    let stale = for_story(&created, &house, &raw_revision(b"old"));
    assert!(matches!(
        ensure_plot_links(&fixture.env(), &stale),
        Err(ProjectError::RevisionConflict { actual_revision }) if actual_revision == current
    ));
    let mut unknown = for_story(&created, &house, &current);
    unknown.story_id = Some("01NOSTORY".to_owned());
    assert!(matches!(
        ensure_plot_links(&fixture.env(), &unknown),
        Err(ProjectError::StoryNotFound { .. })
    ));
    let mut no_story = for_story(&created, &house, &current);
    no_story.story_id = None;
    assert!(matches!(
        ensure_plot_links(&fixture.env(), &no_story),
        Err(ProjectError::StoryNotFound { .. })
    ));
    let mut bad_label = for_story(&created, &house, &current);
    bad_label
        .labels
        .insert("section:stories".to_owned(), "x".to_owned());
    assert!(matches!(
        ensure_plot_links(&fixture.env(), &bad_label),
        Err(ProjectError::InvalidName { .. })
    ));
    let mut bad_id = for_story(&created, &house, &current);
    bad_id.operation_id = "bad id".to_owned();
    assert!(matches!(
        ensure_plot_links(&fixture.env(), &bad_id),
        Err(ProjectError::InvalidOperationId)
    ));
    let mut other_workshop = for_story(&created, &house, &current);
    other_workshop.workshop_id = "01NOWORKSHOP".to_owned();
    assert!(matches!(
        ensure_plot_links(&fixture.env(), &other_workshop),
        Err(ProjectError::WorkshopNotFound { .. })
    ));
    assert_eq!(fixture.tree(), before);
    assert_eq!(fixture.journal_files(), journals);
}

#[test]
fn the_same_operation_is_answered_from_the_record_and_another_request_may_not_reuse_it() {
    let (fixture, created, house) = with_plot();
    let request = for_story(&created, &house, &house.story_file_revision);
    let first = ensure_plot_links(&fixture.env(), &request).unwrap();
    assert!(!first.replayed);

    let again = ensure_plot_links(&fixture.env(), &request).unwrap();
    assert!(again.replayed);
    assert_eq!(
        EnsuredPlotLinks {
            replayed: false,
            ..again
        },
        first
    );

    let mut other = request.clone();
    other.expected_revision = first.revision.clone();
    assert!(matches!(
        ensure_plot_links(&fixture.env(), &other),
        Err(ProjectError::OperationIdReused { .. })
    ));
}

#[test]
fn unknown_fields_and_the_bom_of_the_story_file_survive() {
    let (fixture, created, house) = with_plot();
    let revision = rewrite_json(
        &fixture.vault.join(HOUSE).join(STORY_FILE_NAME),
        true,
        |file| {
            file["x-other-app"] = json!({"keep": [1, 2, 3]});
            file["text"]["x-note"] = json!("hand written");
        },
    );
    let ensured =
        ensure_plot_links(&fixture.env(), &for_story(&created, &house, &revision)).unwrap();

    let bytes = fixture.story_bytes(HOUSE);
    assert!(bytes.starts_with(b"\xEF\xBB\xBF"), "the BOM stays");
    assert_eq!(ensured.revision, raw_revision(&bytes));
    let file: Value = serde_json::from_slice(&bytes[3..]).unwrap();
    assert_eq!(file["x-other-app"]["keep"], json!([1, 2, 3]));
    assert_eq!(file["text"]["x-note"], "hand written");
    assert!(file["text"]["properties"]["anchors"].is_string());
}

fn plot_steps(commit: &Step) -> Vec<Step> {
    vec![
        Step::JournalWritten,
        Step::BeforeManifest,
        Step::ManifestWritten,
        commit.clone(),
        if *commit == Step::BeforeStoryFile {
            Step::StoryFileWritten
        } else {
            Step::WorkshopFileWritten
        },
        Step::BeforeCompletion,
    ]
}

fn assert_one_pair(fixture: &Fixture) {
    let manifest = story_manifest(fixture);
    let file = story_file(fixture);
    for (name, key) in [("Якоря", "anchors"), ("Арки", "arcs")] {
        assert_eq!(count_named(&manifest, name), 1, "{name}: never two");
        assert_eq!(
            file["text"]["properties"][key],
            property_named(&manifest, name).unwrap()["id"]
        );
    }
}

#[test]
fn a_failure_at_any_step_restores_both_files_and_the_retry_makes_one_pair() {
    for target in plot_steps(&Step::BeforeStoryFile) {
        let (fixture, created, house) = with_plot();
        let before = fixture.tree();
        let journals = fixture.journal_files();
        let request = for_story(&created, &house, &house.story_file_revision);

        let wanted = target.clone();
        set_step_hook(move |step| (*step == wanted).then(|| Fault::Fail("injected".to_owned())));
        let outcome = ensure_plot_links(&fixture.env(), &request);
        clear_step_hook();

        if matches!(target, Step::StoryFileWritten | Step::BeforeCompletion) {
            outcome.unwrap_or_else(|error| panic!("{target:?}: {error}"));
            assert_one_pair(&fixture);
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
        assert!(
            !ensure_plot_links(&fixture.env(), &request)
                .unwrap()
                .replayed
        );
        assert_one_pair(&fixture);
        assert_clean_databases(&fixture);
    }
}

#[test]
fn a_crash_at_any_step_is_cleaned_at_activation_and_a_repeat_completes() {
    for target in plot_steps(&Step::BeforeStoryFile) {
        let (fixture, created, house) = with_plot();
        let before = fixture.tree();
        let request = for_story(&created, &house, &house.story_file_revision);
        let committed = matches!(target, Step::StoryFileWritten | Step::BeforeCompletion);

        let wanted = target.clone();
        set_step_hook(move |step| (*step == wanted).then_some(Fault::Crash));
        let outcome = ensure_plot_links(&fixture.env(), &request);
        clear_step_hook();
        assert!(outcome.is_err(), "{target:?}");

        let report = recover_pending_projects(&fixture.vault).unwrap();
        assert!(report.quarantined.is_empty(), "{target:?}: {report:?}");
        if !committed {
            assert_eq!(fixture.tree(), before, "{target:?}");
        }
        let again = ensure_plot_links(&fixture.env(), &request).unwrap();
        assert_eq!(again.replayed, committed, "{target:?}");
        assert_one_pair(&fixture);
    }
}

#[test]
fn a_repeat_after_an_unrecovered_crash_makes_the_planned_properties() {
    let (fixture, created, house) = with_plot();
    let request = for_story(&created, &house, &house.story_file_revision);
    set_step_hook(|step| (*step == Step::ManifestWritten).then_some(Fault::Crash));
    assert!(ensure_plot_links(&fixture.env(), &request).is_err());
    clear_step_hook();
    let journal = read_journal(&fixture.vault, &request.operation_id)
        .unwrap()
        .unwrap();
    let planned: EnsuredPlotLinks = serde_json::from_value(journal.expected_result).unwrap();

    let done = ensure_plot_links(&fixture.env(), &request).unwrap();
    assert!(!done.replayed);
    assert_eq!(done.anchors_property_id, planned.anchors_property_id);
    assert_eq!(done.arcs_property_id, planned.arcs_property_id);
    assert_one_pair(&fixture);
}

#[test]
fn a_database_the_author_edited_in_the_meantime_is_left_alone() {
    let (fixture, created, house) = with_plot();
    let request = for_story(&created, &house, &house.story_file_revision);
    set_step_hook(|step| (*step == Step::ManifestWritten).then_some(Fault::Crash));
    assert!(ensure_plot_links(&fixture.env(), &request).is_err());
    clear_step_hook();
    let path = fixture.vault.join(HOUSE).join("Дом.json");
    rewrite_json(&path, false, |manifest| {
        for property in manifest["properties"].as_array_mut().unwrap() {
            if property["name"] == "Якоря" {
                property["name"] = json!("Мои якоря");
            }
        }
    });
    let edited = fs::read(&path).unwrap();
    let outcome = ensure_plot_links(&fixture.env(), &request);
    assert!(
        matches!(outcome, Err(ProjectError::RecoveryRequired { .. })),
        "{outcome:?}"
    );
    assert_eq!(fs::read(&path).unwrap(), edited, "the edit is kept");
}

// ---------------------------------------------------------------------------
// The anchors database
// ---------------------------------------------------------------------------

fn universe_of(fixture: &Fixture) -> Option<String> {
    entry(&workshop_file(fixture, "Saga"), "anchors")["universePropertyId"]
        .as_str()
        .map(str::to_owned)
}

fn arcs_of(fixture: &Fixture) -> Option<String> {
    entry(&workshop_file(fixture, "Saga"), "anchors")["arcsPropertyId"]
        .as_str()
        .map(str::to_owned)
}

#[test]
fn arcs_made_after_the_anchors_give_them_an_arcs_relation_in_the_same_operation() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    add(&fixture, &created, "anchors", "Якоря");
    assert_eq!(arcs_of(&fixture), None, "no arcs to point at yet");
    add(&fixture, &created, "arcs", "Арки");

    let arcs_db = database_of(&fixture, "arcs");
    let id = arcs_of(&fixture).expect("the file names the arcs relation of the anchors");
    let anchors = manifest(&fixture, "Saga/Якоря", "Якоря");
    assert_relation(&anchors, &id, "Арки", &arcs_db);
    assert_eq!(count_named(&anchors, "Арки"), 1);
    // The arcs themselves started with their characters link, and the file names it.
    let characters = entry(&workshop_file(&fixture, "Saga"), "arcs")["charactersPropertyId"]
        .as_str()
        .expect("the arcs name their characters relation")
        .to_owned();
    let arcs = manifest(&fixture, "Saga/Арки", "Арки");
    assert_relation(
        &arcs,
        &characters,
        "Персонажи",
        &database_of(&fixture, "characters"),
    );
    assert_clean_databases(&fixture);

    // The catalog carries the new IDs.
    let connection = Connection::open_in_memory().unwrap();
    init_schema(&connection).unwrap();
    rebuild_project_index(&connection, &fixture.vault).unwrap();
    let catalog = load_catalog(&connection, &fixture.vault, 1).unwrap();
    let find = |role: &str| {
        catalog.workshops[0]
            .sections
            .iter()
            .find(|section| section.role == role)
            .unwrap()
    };
    assert_eq!(
        find("anchors").arcs_property_id.as_deref(),
        Some(id.as_str())
    );
    assert_eq!(
        find("arcs").characters_property_id.as_deref(),
        Some(characters.as_str())
    );
}

#[test]
fn anchors_made_after_the_arcs_and_the_universes_start_with_both_relations_and_the_file_names_them()
{
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    add(&fixture, &created, "arcs", "Арки");
    add(&fixture, &created, "universes", "Вселенные");
    add(&fixture, &created, "anchors", "Якоря");

    let anchors = manifest(&fixture, "Saga/Якоря", "Якоря");
    let arcs_id = arcs_of(&fixture).expect("arcs");
    assert_relation(&anchors, &arcs_id, "Арки", &database_of(&fixture, "arcs"));
    let universe_id = universe_of(&fixture).expect("universe");
    let universe = property_with_id(&anchors, &universe_id);
    assert_eq!(universe["name"], "Вселенная");
    assert_eq!(universe["config"]["maxItems"], 1, "one universe at most");
    assert_eq!(
        universe["config"]["targetDatabaseId"],
        database_of(&fixture, "universes")
    );
    assert!(universe["config"]["inversePropertyId"].is_null());
    // Nothing is missing, so there is nothing left to ensure.
    let tree = fixture.tree();
    let ensured = ensure_plot_links(
        &fixture.env(),
        &for_anchors(&created, &revision_of(&fixture, "Saga")),
    )
    .unwrap();
    assert!(!ensured.changed);
    assert_eq!(ensured.arcs_property_id.as_deref(), Some(arcs_id.as_str()));
    assert_eq!(
        ensured.universe_property_id.as_deref(),
        Some(universe_id.as_str())
    );
    assert_eq!(fixture.tree(), tree);
    assert_clean_databases(&fixture);
}

#[test]
fn universes_made_after_the_anchors_leave_the_universe_relation_to_the_ensure_operation() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    add(&fixture, &created, "anchors", "Якоря");
    add(&fixture, &created, "universes", "Вселенные");
    assert_eq!(universe_of(&fixture), None);
    let anchors_before = manifest(&fixture, "Saga/Якоря", "Якоря");
    assert_eq!(count_named(&anchors_before, "Вселенная"), 0);

    let revision = revision_of(&fixture, "Saga");
    let ensured = ensure_plot_links(&fixture.env(), &for_anchors(&created, &revision)).unwrap();
    assert!(ensured.changed);
    assert_eq!(ensured.arcs_property_id, None, "there are no arcs yet");
    let universe_id = ensured.universe_property_id.clone().unwrap();
    assert_eq!(universe_of(&fixture).as_deref(), Some(universe_id.as_str()));
    let anchors = manifest(&fixture, "Saga/Якоря", "Якоря");
    assert_eq!(count_named(&anchors, "Вселенная"), 1);
    assert_eq!(
        property_with_id(&anchors, &universe_id)["config"]["maxItems"],
        1
    );
    assert_eq!(ensured.revision, revision_of(&fixture, "Saga"));
    assert_clean_databases(&fixture);
}

#[test]
fn the_anchors_adopt_the_relations_they_already_have_without_touching_the_database() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    add(&fixture, &created, "arcs", "Арки");
    add(&fixture, &created, "universes", "Вселенные");
    add(&fixture, &created, "anchors", "Якоря");
    let (arcs_id, universe_id) = (arcs_of(&fixture).unwrap(), universe_of(&fixture).unwrap());
    // The file forgets both IDs.
    let revision = rewrite_json(
        &fixture.vault.join("Saga").join(WORKSHOP_FILE_NAME),
        false,
        |file| {
            for section in file["sections"].as_array_mut().unwrap() {
                if section["role"] == "anchors" {
                    let object = section.as_object_mut().unwrap();
                    object.remove("arcsPropertyId");
                    object.remove("universePropertyId");
                }
            }
        },
    );
    let manifest_before = fs::read(fixture.vault.join("Saga/Якоря/Якоря.json")).unwrap();

    let ensured = ensure_plot_links(&fixture.env(), &for_anchors(&created, &revision)).unwrap();
    assert!(ensured.changed);
    assert_eq!(ensured.arcs_property_id.as_deref(), Some(arcs_id.as_str()));
    assert_eq!(
        ensured.universe_property_id.as_deref(),
        Some(universe_id.as_str())
    );
    assert_eq!(
        fs::read(fixture.vault.join("Saga/Якоря/Якоря.json")).unwrap(),
        manifest_before
    );
    assert_eq!(arcs_of(&fixture).as_deref(), Some(arcs_id.as_str()));
}

#[test]
fn the_anchors_request_needs_the_anchors_and_a_current_workshop_file() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let revision = revision_of(&fixture, "Saga");
    assert!(matches!(
        ensure_plot_links(&fixture.env(), &for_anchors(&created, &revision)),
        Err(ProjectError::StoryLinksUnavailable { .. })
    ));

    add(&fixture, &created, "anchors", "Якоря");
    add(&fixture, &created, "universes", "Вселенные");
    let before = fixture.tree();
    let current = revision_of(&fixture, "Saga");
    assert!(matches!(
        ensure_plot_links(&fixture.env(), &for_anchors(&created, &raw_revision(b"old"))),
        Err(ProjectError::RevisionConflict { actual_revision }) if actual_revision == current
    ));
    assert_eq!(fixture.tree(), before);
}

fn anchors_ready() -> (Fixture, CreatedWorkshop, String) {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    add(&fixture, &created, "anchors", "Якоря");
    add(&fixture, &created, "universes", "Вселенные");
    let revision = revision_of(&fixture, "Saga");
    (fixture, created, revision)
}

fn assert_one_universe(fixture: &Fixture) {
    let anchors = manifest(fixture, "Saga/Якоря", "Якоря");
    assert_eq!(count_named(&anchors, "Вселенная"), 1);
    assert_eq!(
        universe_of(fixture).as_deref(),
        property_named(&anchors, "Вселенная").unwrap()["id"].as_str()
    );
}

#[test]
fn a_failure_at_any_step_of_the_anchors_restores_both_files_and_the_retry_makes_one() {
    for target in plot_steps(&Step::BeforeWorkshopFile) {
        let (fixture, created, revision) = anchors_ready();
        let before = fixture.tree();
        let journals = fixture.journal_files();
        let request = for_anchors(&created, &revision);

        let wanted = target.clone();
        set_step_hook(move |step| (*step == wanted).then(|| Fault::Fail("injected".to_owned())));
        let outcome = ensure_plot_links(&fixture.env(), &request);
        clear_step_hook();

        if after_commit(&target) {
            outcome.unwrap_or_else(|error| panic!("{target:?}: {error}"));
            assert_one_universe(&fixture);
            continue;
        }
        match outcome {
            Err(ProjectError::RolledBack { message, .. }) => assert_eq!(message, "injected"),
            other => panic!("{target:?}: expected RolledBack, got {other:?}"),
        }
        assert_eq!(fixture.tree(), before, "{target:?}");
        assert_eq!(fixture.journal_files(), journals, "{target:?}");
        assert!(
            !ensure_plot_links(&fixture.env(), &request)
                .unwrap()
                .replayed
        );
        assert_one_universe(&fixture);
    }
}

#[test]
fn a_crash_at_any_step_of_the_anchors_is_cleaned_at_activation_and_a_repeat_completes() {
    for target in plot_steps(&Step::BeforeWorkshopFile) {
        let (fixture, created, revision) = anchors_ready();
        let before = fixture.tree();
        let request = for_anchors(&created, &revision);

        let wanted = target.clone();
        set_step_hook(move |step| (*step == wanted).then_some(Fault::Crash));
        let outcome = ensure_plot_links(&fixture.env(), &request);
        clear_step_hook();
        assert!(outcome.is_err(), "{target:?}");

        let report = recover_pending_projects(&fixture.vault).unwrap();
        assert!(report.quarantined.is_empty(), "{target:?}: {report:?}");
        if !after_commit(&target) {
            assert_eq!(fixture.tree(), before, "{target:?}");
        }
        let again = ensure_plot_links(&fixture.env(), &request).unwrap();
        assert_eq!(again.replayed, after_commit(&target), "{target:?}");
        assert_one_universe(&fixture);
    }
}

#[test]
fn a_repeat_after_an_unrecovered_crash_of_the_anchors_makes_the_planned_property() {
    let (fixture, created, revision) = anchors_ready();
    let request = for_anchors(&created, &revision);
    set_step_hook(|step| (*step == Step::ManifestWritten).then_some(Fault::Crash));
    assert!(ensure_plot_links(&fixture.env(), &request).is_err());
    clear_step_hook();
    let journal = read_journal(&fixture.vault, &request.operation_id)
        .unwrap()
        .unwrap();
    let planned: EnsuredPlotLinks = serde_json::from_value(journal.expected_result).unwrap();

    let done = ensure_plot_links(&fixture.env(), &request).unwrap();
    assert_eq!(done.universe_property_id, planned.universe_property_id);
    assert_one_universe(&fixture);
}

#[test]
fn unknown_fields_and_the_bom_of_the_workshop_file_survive_the_anchors() {
    let (fixture, created, _) = anchors_ready();
    let revision = rewrite_json(
        &fixture.vault.join("Saga").join(WORKSHOP_FILE_NAME),
        true,
        |file| {
            file["x-other-app"] = json!({"keep": true});
            for section in file["sections"].as_array_mut().unwrap() {
                section["x-note"] = json!("hand written");
            }
        },
    );
    let ensured = ensure_plot_links(&fixture.env(), &for_anchors(&created, &revision)).unwrap();
    let bytes = fixture.workshop_bytes("Saga");
    assert!(bytes.starts_with(b"\xEF\xBB\xBF"));
    assert_eq!(ensured.revision, raw_revision(&bytes));
    let file: Value = serde_json::from_slice(&bytes[3..]).unwrap();
    assert_eq!(file["x-other-app"]["keep"], true);
    assert_eq!(entry(&file, "anchors")["x-note"], "hand written");
    assert!(entry(&file, "anchors")["universePropertyId"].is_string());
}

// ---------------------------------------------------------------------------
// Arcs made after the anchors: failure and crash at every step
// ---------------------------------------------------------------------------

#[test]
fn a_failure_or_a_crash_at_any_step_of_the_first_arcs_restores_the_anchors_database() {
    let steps = vec![
        Step::JournalWritten,
        Step::BeforeDatabase(0),
        Step::DatabaseCreated(0),
        Step::BeforeManifest,
        Step::ManifestWritten,
        Step::BeforeWorkshopFile,
        Step::WorkshopFileWritten,
        Step::BeforeCompletion,
    ];
    for crash in [false, true] {
        for target in &steps {
            let fixture = Fixture::new();
            let created = fixture.create_workshop(&workshop("Saga")).unwrap();
            add(&fixture, &created, "anchors", "Якоря");
            let before = fixture.tree();
            let journals = fixture.journal_files();
            let revision = revision_of(&fixture, "Saga");
            let request = section_request(&created, &revision, "arcs", "Арки");

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
            let outcome = fixture.add_section(&request);
            clear_step_hook();

            let committed = after_commit(target);
            if crash {
                assert!(outcome.is_err(), "{target:?}");
                recover_pending_projects(&fixture.vault).unwrap();
            } else if committed {
                outcome.unwrap_or_else(|error| panic!("{target:?}: {error}"));
            } else {
                assert!(
                    matches!(outcome, Err(ProjectError::RolledBack { .. })),
                    "{target:?}: {outcome:?}"
                );
            }
            if !committed {
                assert_eq!(
                    fixture.tree(),
                    before,
                    "{target:?} (crash {crash}): the vault is as before"
                );
                assert_eq!(fixture.journal_files(), journals, "{target:?}");
            }
            fixture.add_section(&request).unwrap();
            let anchors = manifest(&fixture, "Saga/Якоря", "Якоря");
            assert_eq!(count_named(&anchors, "Арки"), 1, "{target:?}: never two");
            assert_eq!(
                arcs_of(&fixture).as_deref(),
                property_named(&anchors, "Арки").unwrap()["id"].as_str()
            );
        }
    }
}

// ---------------------------------------------------------------------------
// A story made after the anchors and arcs
// ---------------------------------------------------------------------------

#[test]
fn a_story_made_after_the_anchors_and_arcs_has_both_relations_from_the_start() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    add(&fixture, &created, "anchors", "Якоря");
    add(&fixture, &created, "arcs", "Арки");
    let house = fixture
        .create_story(&story(&created.workshop_id, "Дом"))
        .unwrap();

    let file = story_file(&fixture);
    let manifest = story_manifest(&fixture);
    let anchors_id = file["text"]["properties"]["anchors"].as_str().unwrap();
    let arcs_id = file["text"]["properties"]["arcs"].as_str().unwrap();
    assert_relation(
        &manifest,
        anchors_id,
        "Якоря",
        &database_of(&fixture, "anchors"),
    );
    assert_relation(&manifest, arcs_id, "Арки", &database_of(&fixture, "arcs"));
    assert_eq!(house.story_file_revision, story_revision(&fixture));
    assert_clean_databases(&fixture);

    // Nothing is left for the ensure operation to do.
    let ensured = ensure_plot_links(
        &fixture.env(),
        &for_story(&created, &house, &house.story_file_revision),
    )
    .unwrap();
    assert!(!ensured.changed);
    assert_eq!(ensured.anchors_property_id.as_deref(), Some(anchors_id));

    // A story made with only the anchors there gets only those.
    let other = fixture.create_workshop(&workshop("Other")).unwrap();
    fixture
        .add_section(&section_request(
            &other,
            &other.file_revision,
            "anchors",
            "Якоря",
        ))
        .unwrap();
    fixture
        .create_story(&story(&other.workshop_id, "Дом"))
        .unwrap();
    let only: Value = serde_json::from_slice(&fixture.story_bytes("Other/Истории/Дом")).unwrap();
    assert!(only["text"]["properties"]["anchors"].is_string());
    assert!(only["text"]["properties"].get("arcs").is_none());
}

#[test]
fn the_names_of_the_relations_follow_the_labels_of_the_language() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    add(&fixture, &created, "anchors", "Anchors");
    add(&fixture, &created, "arcs", "Arcs");
    let mut request = story(&created.workshop_id, "Дом");
    request
        .labels
        .insert("property:anchors".to_owned(), "Anchors".to_owned());
    request
        .labels
        .insert("property:arcs".to_owned(), "Arcs".to_owned());
    fixture.create_story(&request).unwrap();
    let manifest = story_manifest(&fixture);
    assert!(property_named(&manifest, "Anchors").is_some());
    assert!(property_named(&manifest, "Arcs").is_some());
    assert!(property_named(&manifest, "Якоря").is_none());
}

// ---------------------------------------------------------------------------
// An event of a universe: an anchor born with its "Universe" value
// ---------------------------------------------------------------------------

fn universe_note(fixture: &Fixture, title: &str) -> String {
    crate::database::rows::create_database_row(
        &fixture.vault,
        &fixture.watcher,
        &crate::database::rows::CreateDatabaseRowRequest {
            expected_generation: 1,
            database_id: database_of(fixture, "universes"),
            title: title.to_owned(),
            template: crate::database::rows::DatabaseRowTemplate::Default,
        },
    )
    .unwrap()
    .note_id
}

fn anchor_of(
    created: &CreatedWorkshop,
    section: &str,
    title: &str,
    universe_id: Option<&str>,
) -> CreateWorkshopEntityRequest {
    CreateWorkshopEntityRequest {
        expected_generation: 1,
        workshop_id: created.workshop_id.clone(),
        section_id: section.to_owned(),
        title: title.to_owned(),
        story_id: None,
        notebook: None,
        universe_id: universe_id.map(str::to_owned),
    }
}

fn relation_of(path: &str, name: &str) -> Vec<String> {
    frontmatter_of(path)
        .get(name)
        .and_then(serde_yaml::Value::as_sequence)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_yaml::Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn an_anchor_is_born_with_its_universe_in_the_same_write() {
    let (fixture, created, revision) = anchors_ready();
    ensure_plot_links(&fixture.env(), &for_anchors(&created, &revision)).unwrap();
    let universe = universe_note(&fixture, "Мир");

    let event = create_entity(
        &fixture.env(),
        &anchor_of(&created, "anchors", "Потоп", Some(&universe)),
    )
    .unwrap();
    assert_eq!(
        relation_of(&event.note_path, "Вселенная"),
        std::slice::from_ref(&universe)
    );
    assert_eq!(event.linked_story_id, None);

    // An anchor made without a universe carries no value.
    let free = create_entity(
        &fixture.env(),
        &anchor_of(&created, "anchors", "Свой", None),
    )
    .unwrap();
    assert!(relation_of(&free.note_path, "Вселенная").is_empty());
}

#[test]
fn an_event_of_a_universe_is_refused_before_any_write_when_it_cannot_be_linked() {
    let (fixture, created, revision) = anchors_ready();
    let universe = universe_note(&fixture, "Мир");

    // The anchors have no "Universe" relation yet: the interface makes it first.
    let before = fixture.tree();
    assert!(matches!(
        create_entity(
            &fixture.env(),
            &anchor_of(&created, "anchors", "Потоп", Some(&universe))
        ),
        Err(ProjectError::StoryLinksUnavailable { .. })
    ));
    assert_eq!(fixture.tree(), before, "nothing was written");

    ensure_plot_links(&fixture.env(), &for_anchors(&created, &revision)).unwrap();
    let before = fixture.tree();
    // A universe that is not a page of the universes base.
    assert!(matches!(
        create_entity(
            &fixture.env(),
            &anchor_of(&created, "anchors", "Потоп", Some("01NOUNIVERSE"))
        ),
        Err(ProjectError::StoryLinksUnavailable { .. })
    ));
    // A section that is not the anchors takes no universe.
    assert!(matches!(
        create_entity(
            &fixture.env(),
            &anchor_of(&created, "characters", "Анна", Some(&universe))
        ),
        Err(ProjectError::InvalidParent { .. })
    ));
    assert_eq!(fixture.tree(), before, "nothing was written");
    // The relation the author deleted from the anchors is not written either.
    rewrite_json(
        &fixture.vault.join("Saga/Якоря/Якоря.json"),
        false,
        |manifest| {
            manifest["properties"]
                .as_array_mut()
                .unwrap()
                .retain(|property| property["name"] != "Вселенная");
        },
    );
    let before = fixture.tree();
    assert!(matches!(
        create_entity(
            &fixture.env(),
            &anchor_of(&created, "anchors", "Потоп", Some(&universe))
        ),
        Err(ProjectError::StoryLinksUnavailable { .. })
    ));
    assert_eq!(fixture.tree(), before, "nothing was written");
}
