//! The scene links of a story's text (`docs/creative-format.md` §6): "Characters", "Point of
//! view", "Places" and "Story time". Each one is made only when the author first uses it, through
//! `ensure_plot_links` with `parts`; a call without `parts` keeps making the anchors and arcs only.

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde_json::Value;

use super::create::{clear_step_hook, set_step_hook, Fault, Step};
use super::create_test::{op, story, workshop, Fixture};
use super::index::{load_catalog, rebuild_project_index};
use super::links::ensure_plot_links;
use super::links_test::{
    entry, manifest, property_with_id, revision_of, rewrite_json, section_request, workshop_file,
};
use super::model::{
    CreatedStory, CreatedWorkshop, EnsurePlotLinksRequest, PlotLinksTarget, ProjectError,
    TextLinkPart, STORY_FILE_NAME,
};
use crate::database::format::raw_revision;
use crate::index::schema::init_schema;

const HOUSE: &str = "Saga/Истории/Дом";

fn story_manifest(fixture: &Fixture) -> Value {
    manifest(fixture, HOUSE, "Дом")
}

fn story_file(fixture: &Fixture) -> Value {
    serde_json::from_slice(&fixture.story_bytes(HOUSE)).unwrap()
}

fn database_of(fixture: &Fixture, role: &str) -> String {
    entry(&workshop_file(fixture, "Saga"), role)["databaseId"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn property_count(manifest: &Value) -> usize {
    manifest["properties"].as_array().unwrap().len()
}

fn request(
    created: &CreatedWorkshop,
    house: &CreatedStory,
    revision: &str,
    parts: Option<Vec<TextLinkPart>>,
) -> EnsurePlotLinksRequest {
    EnsurePlotLinksRequest {
        expected_generation: 1,
        operation_id: op("scene"),
        workshop_id: created.workshop_id.clone(),
        target: PlotLinksTarget::Story,
        story_id: Some(house.story_id.clone()),
        expected_revision: revision.to_owned(),
        labels: BTreeMap::new(),
        parts,
    }
}

/// A workshop with characters and locations, the anchors and arcs, and one story "Дом".
fn saga() -> (Fixture, CreatedWorkshop, CreatedStory) {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let house = fixture
        .create_story(&story(&created.workshop_id, "Дом"))
        .unwrap();
    for (role, name) in [("anchors", "Якоря"), ("arcs", "Арки")] {
        let revision = revision_of(&fixture, "Saga");
        fixture
            .add_section(&section_request(&created, &revision, role, name))
            .unwrap();
    }
    (fixture, created, house)
}

fn catalog_properties(fixture: &Fixture) -> super::model::TextPropertyIds {
    let connection = Connection::open_in_memory().unwrap();
    init_schema(&connection).unwrap();
    crate::index::sync::sync_vault(&connection, &fixture.vault).unwrap();
    crate::database::projection::rebuild_database_projection(&connection, &fixture.vault).unwrap();
    rebuild_project_index(&connection, &fixture.vault).unwrap();
    let catalog = load_catalog(&connection, &fixture.vault, 1).unwrap();
    catalog.workshops[0].stories[0]
        .text
        .as_ref()
        .unwrap()
        .properties
        .clone()
}

#[test]
fn the_characters_of_the_text_are_made_alone_when_asked_for() {
    let (fixture, created, house) = saga();
    let characters_db = database_of(&fixture, "characters");
    let before = story_manifest(&fixture);

    let ensured = ensure_plot_links(
        &fixture.env(),
        &request(
            &created,
            &house,
            &house.story_file_revision,
            Some(vec![TextLinkPart::Characters]),
        ),
    )
    .unwrap();
    assert!(ensured.changed);
    let characters_id = ensured.characters_property_id.clone().unwrap();
    // The anchors and arcs exist as databases but were not asked for: they are not made.
    assert!(ensured.anchors_property_id.is_none());
    assert!(ensured.arcs_property_id.is_none());

    let after = story_manifest(&fixture);
    assert_eq!(property_count(&after), property_count(&before) + 1);
    let property = property_with_id(&after, &characters_id);
    assert_eq!(property["name"], "Персонажи");
    assert_eq!(property["type"], "relation");
    assert_eq!(
        property["config"]["targetDatabaseId"],
        characters_db.as_str()
    );
    assert!(property["config"]["maxItems"].is_null(), "any number");
    assert!(property["config"]["inversePropertyId"].is_null(), "one way");

    let file = story_file(&fixture);
    assert_eq!(
        file["text"]["properties"]["characters"],
        characters_id.as_str()
    );
    assert!(file["text"]["properties"].get("anchors").is_none());
    assert_eq!(ensured.revision, raw_revision(&fixture.story_bytes(HOUSE)));

    let properties = catalog_properties(&fixture);
    assert_eq!(
        properties.characters.as_deref(),
        Some(characters_id.as_str())
    );
    assert!(properties.anchors.is_none());
}

#[test]
fn point_of_view_places_and_story_time_have_their_own_shapes() {
    let (fixture, created, house) = saga();
    let characters_db = database_of(&fixture, "characters");
    let locations_db = database_of(&fixture, "locations");

    let ensured = ensure_plot_links(
        &fixture.env(),
        &request(
            &created,
            &house,
            &house.story_file_revision,
            Some(vec![
                TextLinkPart::Pov,
                TextLinkPart::Places,
                TextLinkPart::StoryTime,
            ]),
        ),
    )
    .unwrap();
    let after = story_manifest(&fixture);

    let pov = property_with_id(&after, ensured.pov_property_id.as_deref().unwrap());
    assert_eq!(pov["name"], "Точка зрения");
    assert_eq!(pov["config"]["targetDatabaseId"], characters_db.as_str());
    assert_eq!(pov["config"]["maxItems"], 1, "one narrator a scene");

    let places = property_with_id(&after, ensured.places_property_id.as_deref().unwrap());
    assert_eq!(places["name"], "Места");
    assert_eq!(places["config"]["targetDatabaseId"], locations_db.as_str());
    assert!(places["config"]["maxItems"].is_null());

    let time = property_with_id(&after, ensured.story_time_property_id.as_deref().unwrap());
    assert_eq!(time["name"], "Время действия");
    assert_eq!(time["type"], "text");

    let file = story_file(&fixture);
    let recorded = &file["text"]["properties"];
    assert_eq!(recorded["pov"], ensured.pov_property_id.as_deref().unwrap());
    assert_eq!(
        recorded["places"],
        ensured.places_property_id.as_deref().unwrap()
    );
    assert_eq!(
        recorded["storyTime"],
        ensured.story_time_property_id.as_deref().unwrap()
    );
    assert!(recorded.get("characters").is_none(), "not asked for");

    let properties = catalog_properties(&fixture);
    assert_eq!(properties.pov, ensured.pov_property_id);
    assert_eq!(properties.places, ensured.places_property_id);
    assert_eq!(properties.story_time, ensured.story_time_property_id);
}

#[test]
fn a_call_without_parts_still_makes_only_the_anchors_and_arcs() {
    let (fixture, created, house) = saga();
    let ensured = ensure_plot_links(
        &fixture.env(),
        &request(&created, &house, &house.story_file_revision, None),
    )
    .unwrap();
    assert!(ensured.anchors_property_id.is_some());
    assert!(ensured.arcs_property_id.is_some());
    assert!(ensured.characters_property_id.is_none());
    assert!(ensured.pov_property_id.is_none());
    assert!(ensured.places_property_id.is_none());
    assert!(ensured.story_time_property_id.is_none());
    assert!(story_file(&fixture)["text"]["properties"]
        .get("characters")
        .is_none());
}

#[test]
fn a_part_already_there_is_kept_and_the_rest_are_reported_as_they_are() {
    let (fixture, created, house) = saga();
    let first = ensure_plot_links(
        &fixture.env(),
        &request(
            &created,
            &house,
            &house.story_file_revision,
            Some(vec![TextLinkPart::Characters]),
        ),
    )
    .unwrap();
    let tree = fixture.tree();

    // Asked again under a new operation: nothing to make, nothing written.
    let mut again = request(
        &created,
        &house,
        &first.revision,
        Some(vec![TextLinkPart::Characters]),
    );
    again.operation_id = op("scene-again");
    let repeated = ensure_plot_links(&fixture.env(), &again).unwrap();
    assert!(!repeated.changed);
    assert_eq!(
        repeated.characters_property_id,
        first.characters_property_id
    );
    assert_eq!(fixture.tree(), tree);

    // Asking for another part keeps the characters and reports them.
    let mut pov = request(
        &created,
        &house,
        &first.revision,
        Some(vec![TextLinkPart::Pov]),
    );
    pov.operation_id = op("scene-pov");
    let with_pov = ensure_plot_links(&fixture.env(), &pov).unwrap();
    assert!(with_pov.changed);
    assert_eq!(
        with_pov.characters_property_id,
        first.characters_property_id
    );
    let recorded = &story_file(&fixture)["text"]["properties"];
    assert_eq!(
        recorded["characters"],
        first.characters_property_id.as_deref().unwrap()
    );
    assert!(recorded["pov"].is_string());
}

#[test]
fn a_story_time_the_text_already_has_by_name_is_adopted() {
    let (fixture, created, house) = saga();
    // The author added a text property "Время действия" by hand before.
    let first = ensure_plot_links(
        &fixture.env(),
        &request(
            &created,
            &house,
            &house.story_file_revision,
            Some(vec![TextLinkPart::StoryTime]),
        ),
    )
    .unwrap();
    let id = first.story_time_property_id.clone().unwrap();
    // Forget it in the story file only: the property stays in the database.
    let revision = rewrite_json(
        &fixture.vault.join(HOUSE).join(STORY_FILE_NAME),
        false,
        |file| {
            file["text"]["properties"]
                .as_object_mut()
                .unwrap()
                .remove("storyTime");
        },
    );
    let before = story_manifest(&fixture);

    let mut again = request(
        &created,
        &house,
        &revision,
        Some(vec![TextLinkPart::StoryTime]),
    );
    again.operation_id = op("scene-adopt");
    let adopted = ensure_plot_links(&fixture.env(), &again).unwrap();
    assert!(adopted.changed, "the file records it again");
    assert_eq!(adopted.story_time_property_id.as_deref(), Some(id.as_str()));
    assert_eq!(story_manifest(&fixture), before, "no second property");
}

#[test]
fn a_failure_before_the_story_file_leaves_both_files_as_they_were() {
    let (fixture, created, house) = saga();
    let before = fixture.tree();
    let request = request(
        &created,
        &house,
        &house.story_file_revision,
        Some(vec![TextLinkPart::Characters, TextLinkPart::StoryTime]),
    );
    set_step_hook(|step| (*step == Step::BeforeStoryFile).then(|| Fault::Fail("injected".into())));
    let outcome = ensure_plot_links(&fixture.env(), &request);
    clear_step_hook();
    match outcome {
        Err(ProjectError::RolledBack { message, .. }) => assert_eq!(message, "injected"),
        other => panic!("expected RolledBack, got {other:?}"),
    }
    assert_eq!(fixture.tree(), before);
}

#[test]
fn parts_are_refused_for_the_anchors_target() {
    let (fixture, created, _house) = saga();
    let tree = fixture.tree();
    let request = EnsurePlotLinksRequest {
        expected_generation: 1,
        operation_id: op("scene-anchors"),
        workshop_id: created.workshop_id.clone(),
        target: PlotLinksTarget::Anchors,
        story_id: None,
        expected_revision: revision_of(&fixture, "Saga"),
        labels: BTreeMap::new(),
        parts: Some(vec![TextLinkPart::Characters]),
    };
    assert!(matches!(
        ensure_plot_links(&fixture.env(), &request),
        Err(ProjectError::InvalidName { .. })
    ));
    assert_eq!(fixture.tree(), tree);
}
