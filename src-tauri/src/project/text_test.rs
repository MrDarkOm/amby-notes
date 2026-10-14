//! The text schema of a story and the page operations on it, through real files, the real
//! database layer and a real SQLite projection.

use std::collections::BTreeMap;
use std::fs;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::create::{clear_step_hook, set_step_hook, Fault, Step};
use super::create_test::{story, workshop, Fixture};
use super::discovery::discover_projects;
use super::index::{load_catalog, rebuild_project_index};
use super::journal::read_journal;
use super::model::{
    CreateTextPageRequest, CreatedStory, CreatedWorkshop, MoveTextPageRequest, ProjectError,
    TextEntryState, STORY_FILE_NAME, WORKSHOP_FILE_NAME,
};
use super::recovery::recover_pending_projects;
use super::text::{create_page, move_page, valid_order_key};
use crate::database::discovery::discover_vault;
use crate::database::format::{parse_manifest, raw_revision};
use crate::database::mutations::{
    delete_database_property, update_database_property_options, DatabaseOptionInput,
    DeleteDatabasePropertyRequest, UpdateDatabasePropertyOptionsRequest,
};
use crate::database::projection::rebuild_database_projection;
use crate::index::schema::init_schema;

struct Text {
    fixture: Fixture,
    created_ws: CreatedWorkshop,
    created: CreatedStory,
    connection: Connection,
}

impl Text {
    fn new() -> Self {
        let fixture = Fixture::new();
        let created_ws = fixture.create_workshop(&workshop("Saga")).unwrap();
        let created = fixture
            .create_story(&story(&created_ws.workshop_id, "Глава 1"))
            .unwrap();
        let connection = Connection::open_in_memory().unwrap();
        init_schema(&connection).unwrap();
        let text = Self {
            fixture,
            created_ws,
            created,
            connection,
        };
        text.refresh();
        text
    }

    fn from_levels(levels: &[&str]) -> Self {
        let fixture = Fixture::new();
        let created_ws = fixture.create_workshop(&workshop("Saga")).unwrap();
        let mut story_req = story(&created_ws.workshop_id, "Глава 1");
        story_req.text_levels = Some(levels.iter().map(|n| (*n).to_owned()).collect());
        let created = fixture.create_story(&story_req).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        init_schema(&connection).unwrap();
        let text = Self {
            fixture,
            created_ws,
            created,
            connection,
        };
        text.refresh();
        text
    }

    fn refresh(&self) {
        // The projection only holds pages the note index knows, as in the running app.
        crate::index::sync::sync_vault(&self.connection, &self.fixture.vault).unwrap();
        rebuild_database_projection(&self.connection, &self.fixture.vault).unwrap();
        rebuild_project_index(&self.connection, &self.fixture.vault).unwrap();
    }

    fn block(&self) -> Value {
        let doc: Value =
            serde_json::from_slice(&self.fixture.story_bytes("Saga/Истории/Глава 1")).unwrap();
        doc["text"].clone()
    }

    fn manifest(&self) -> crate::database::format::DatabaseManifest {
        let path = self.fixture.vault.join("Saga/Истории/Глава 1/Глава 1.json");
        parse_manifest(&fs::read(path).unwrap()).unwrap().value
    }

    fn level(&self, index: usize) -> String {
        self.block()["levels"][index]["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn format(&self, kind: &str) -> String {
        self.block()["formats"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["kind"] == kind)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn page(&self, title: &str, parent: Option<&str>, level: usize, key: &str) -> String {
        let created = create_page(
            &self.fixture.env(),
            &self.connection,
            &CreateTextPageRequest {
                expected_generation: 1,
                story_id: self.created.story_id.clone(),
                title: title.to_owned(),
                parent_note_id: parent.map(str::to_owned),
                level_id: self.level(level),
                format_id: None,
                order_key: key.to_owned(),
            },
        )
        .unwrap();
        self.refresh();
        created.note_id
    }

    fn note_text(&self, note_id: &str) -> String {
        let note = discover_vault(&self.fixture.vault)
            .unwrap()
            .notes
            .into_iter()
            .find(|note| note.note_id.as_deref() == Some(note_id))
            .unwrap();
        fs::read_to_string(note.path).unwrap()
    }

    fn note_revision(&self, note_id: &str) -> String {
        raw_revision(self.note_text(note_id).as_bytes())
    }

    fn movement(&self, note_id: &str, parent: Option<&str>, key: &str) -> MoveTextPageRequest {
        MoveTextPageRequest {
            expected_generation: 1,
            operation_id: format!("move-{}", ulid::Ulid::generate()),
            story_id: self.created.story_id.clone(),
            note_id: note_id.to_owned(),
            new_parent_note_id: parent.map(str::to_owned),
            order_key: key.to_owned(),
            expected_revision: self.note_revision(note_id),
        }
    }

    fn move_page(
        &self,
        request: &MoveTextPageRequest,
    ) -> Result<super::model::MovedTextPage, ProjectError> {
        move_page(&self.fixture.env(), &self.connection, None, request)
    }
}

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

#[test]
fn a_story_text_is_created_with_its_system_properties_and_the_block_that_names_them() {
    let text = Text::new();
    let manifest = text.manifest();
    let names = manifest
        .properties
        .iter()
        .map(|property| property.name().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        ["Уровень", "Родитель", "Порядок", "Формат", "Статус"]
    );

    let block = text.block();
    let properties = &block["properties"];
    for (key, name) in [
        ("level", "Уровень"),
        ("parent", "Родитель"),
        ("order", "Порядок"),
        ("format", "Формат"),
        ("status", "Статус"),
    ] {
        let id = properties[key].as_str().unwrap();
        assert!(ulid::Ulid::from_string(id).is_ok(), "{key} is a ULID");
        let property = manifest
            .properties
            .iter()
            .find(|p| p.id() == Some(id))
            .unwrap();
        assert_eq!(property.name(), Some(name));
    }

    // A level has no ID of its own: the entry is the option of the level Select, keeping
    // only the order (and an icon). The names live in the database, not in the file.
    let levels = block["levels"].as_array().unwrap();
    assert_eq!(levels.len(), 4);
    let level_property = manifest
        .properties
        .iter()
        .find(|p| p.id() == properties["level"].as_str())
        .unwrap();
    let option_names = ["Книга", "Том", "Глава", "Страница"];
    for (entry, name) in levels.iter().zip(option_names) {
        assert_eq!(
            entry.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["id"],
            "no name in the file"
        );
        assert!(ulid::Ulid::from_string(entry["id"].as_str().unwrap()).is_ok());
        assert_eq!(
            level_property.find_option_name(entry["id"].as_str().unwrap()),
            Some(name)
        );
    }
    let file = String::from_utf8(text.fixture.story_bytes("Saga/Истории/Глава 1")).unwrap();
    assert!(
        !file.contains("Глава"),
        "level names are not stored in the structure file"
    );

    let formats = block["formats"].as_array().unwrap();
    assert_eq!(
        formats
            .iter()
            .map(|entry| entry["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["manuscript", "screenplay", "comic", "note"]
    );
    let format_property = manifest
        .properties
        .iter()
        .find(|p| p.id() == properties["format"].as_str())
        .unwrap();
    assert_eq!(
        format_property.find_option_name(formats[0]["id"].as_str().unwrap()),
        Some("Рукопись")
    );

    // The parent is a one-way relation to the same database that keeps at most one parent.
    let parent = manifest
        .properties
        .iter()
        .find(|p| p.id() == properties["parent"].as_str())
        .unwrap();
    let config = serde_json::to_value(parent).unwrap();
    assert_eq!(config["type"], "relation");
    assert_eq!(config["config"]["targetDatabaseId"], manifest.database_id);
    assert_eq!(config["config"]["maxItems"], 1);
    assert!(config["config"]["inversePropertyId"].is_null());

    // The existing database layer accepts the manifest as it is.
    let databases = discover_vault(&text.fixture.vault).unwrap();
    assert!(
        databases.diagnostics.is_empty(),
        "{:?}",
        databases.diagnostics
    );
}

#[test]
fn the_names_follow_the_labels_of_the_active_language() {
    let fixture = Fixture::new();
    let ws = fixture.create_workshop(&workshop("Saga")).unwrap();
    let mut request = story(&ws.workshop_id, "Глава 1");
    request.labels = BTreeMap::from([
        ("property:level".to_owned(), "Level".to_owned()),
        ("property:parent".to_owned(), "Parent".to_owned()),
        ("property:order".to_owned(), "Order".to_owned()),
        ("property:format".to_owned(), "Format".to_owned()),
        ("property:status".to_owned(), "Status".to_owned()),
        ("level:book".to_owned(), "Book".to_owned()),
        ("level:arc".to_owned(), "Arc".to_owned()),
        ("level:chapter".to_owned(), "Chapter".to_owned()),
        ("level:page".to_owned(), "Page".to_owned()),
        ("format:manuscript".to_owned(), "Manuscript".to_owned()),
        ("format:screenplay".to_owned(), "Screenplay".to_owned()),
        ("format:comic".to_owned(), "Comic".to_owned()),
        ("format:note".to_owned(), "Note".to_owned()),
        ("status:draft".to_owned(), "Draft".to_owned()),
        ("status:inProgress".to_owned(), "In progress".to_owned()),
        ("status:done".to_owned(), "Done".to_owned()),
    ]);
    fixture.create_story(&request).unwrap();
    let manifest =
        parse_manifest(&fs::read(fixture.vault.join("Saga/Истории/Глава 1/Глава 1.json")).unwrap())
            .unwrap()
            .value;
    let names = manifest
        .properties
        .iter()
        .map(|p| p.name().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(names, ["Level", "Parent", "Order", "Format", "Status"]);
    let level = serde_json::to_value(&manifest.properties[0]).unwrap();
    let options = level["config"]["options"].as_array().unwrap();
    assert_eq!(
        options
            .iter()
            .map(|o| o["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["Book", "Arc", "Chapter", "Page"]
    );

    // Two levels, or two properties, with one name are refused before anything is written.
    let other = Fixture::new();
    let ws2 = other.create_workshop(&workshop("Saga")).unwrap();
    let mut clash = story(&ws2.workshop_id, "Глава 1");
    clash.labels = BTreeMap::from([
        ("level:book".to_owned(), "Part".to_owned()),
        ("level:arc".to_owned(), "part".to_owned()),
    ]);
    let before = other.tree();
    assert!(matches!(
        other.create_story(&clash),
        Err(ProjectError::InvalidName { .. })
    ));
    assert_eq!(other.tree(), before);
}

#[test]
fn unknown_kinds_and_unknown_fields_of_the_text_block_survive_a_rewrite() {
    let text = Text::new();
    let path = text
        .fixture
        .vault
        .join("Saga/Истории/Глава 1")
        .join(STORY_FILE_NAME);
    let mut doc: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    doc["text"]["formats"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "01JZ", "kind": "audio-drama", "tempo": 3}));
    doc["text"]["x-future"] = json!({"keep": true});
    let mut bytes = serde_json::to_vec_pretty(&doc).unwrap();
    bytes.push(b'\n');
    fs::write(&path, &bytes).unwrap();

    let levels = text.block()["levels"].as_array().unwrap().clone();
    let level_inputs = levels
        .iter()
        .enumerate()
        .map(|(i, l)| super::model::TextLevelUpdateInput {
            id: Some(l["id"].as_str().unwrap().to_owned()),
            name: format!("L{i}"),
            icon: None,
        })
        .collect::<Vec<_>>();
    let updated = super::settings::update_text_levels(
        &text.fixture.env(),
        Some(&text.connection),
        &super::model::UpdateTextLevelsRequest {
            expected_generation: 1,
            operation_id: "op-preserve-1".to_owned(),
            story_id: text.created.story_id.clone(),
            expected_story_revision: raw_revision(&bytes),
            levels: level_inputs,
        },
    )
    .unwrap();
    assert!(!updated.replayed);

    let after: Value =
        serde_json::from_slice(&text.fixture.story_bytes("Saga/Истории/Глава 1")).unwrap();
    assert_eq!(after["text"]["x-future"], json!({"keep": true}));
    let formats = after["text"]["formats"].as_array().unwrap();
    assert_eq!(
        formats.last().unwrap(),
        &json!({"id": "01JZ", "kind": "audio-drama", "tempo": 3})
    );
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

#[test]
fn the_catalog_resolves_levels_and_formats_against_the_database() {
    let text = Text::new();
    let catalog = load_catalog(&text.connection, &text.fixture.vault, 1).unwrap();
    let summary = catalog.workshops[0].stories[0].text.as_ref().unwrap();
    assert_eq!(
        summary.database_id.as_deref(),
        Some(text.manifest().database_id.as_str())
    );
    assert!(summary.properties.level.is_some() && summary.properties.parent.is_some());
    assert!(summary.properties.order.is_some() && summary.properties.format.is_some());
    assert_eq!(
        summary
            .levels
            .iter()
            .map(|level| level.name.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["Книга", "Том", "Глава", "Страница"]
    );
    assert!(summary
        .levels
        .iter()
        .all(|level| level.state == TextEntryState::Ok && level.color.is_some()));
    assert_eq!(summary.formats[0].kind, "manuscript");
    assert_eq!(summary.formats[0].name.as_deref(), Some("Рукопись"));
    assert!(catalog.diagnostics.is_empty());
}

#[test]
fn a_level_deleted_in_the_database_is_dangling_with_a_diagnostic_and_nothing_is_rewritten() {
    let text = Text::new();
    let before = text.fixture.story_bytes("Saga/Истории/Глава 1");
    let manifest = text.manifest();
    let level_property = manifest.properties[0].id().unwrap().to_owned();
    let removed = text.level(1);
    let remaining = serde_json::to_value(&manifest.properties[0]).unwrap()["config"]["options"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|option| option["id"] != removed.as_str())
        .map(|option| DatabaseOptionInput {
            id: option["id"].as_str().map(str::to_owned),
            name: option["name"].as_str().unwrap().to_owned(),
            color: option["color"].as_str().unwrap().to_owned(),
            group: None,
            is_default: false,
        })
        .collect::<Vec<_>>();
    let manifest_bytes =
        fs::read(text.fixture.vault.join("Saga/Истории/Глава 1/Глава 1.json")).unwrap();
    update_database_property_options(
        &text.fixture.vault,
        &text.fixture.watcher,
        &UpdateDatabasePropertyOptionsRequest {
            expected_generation: 1,
            database_id: manifest.database_id.clone(),
            property_id: level_property,
            expected_manifest_revision: raw_revision(&manifest_bytes),
            options: remaining,
        },
    )
    .unwrap();
    text.refresh();

    let catalog = load_catalog(&text.connection, &text.fixture.vault, 1).unwrap();
    let levels = &catalog.workshops[0].stories[0]
        .text
        .as_ref()
        .unwrap()
        .levels;
    assert_eq!(levels.len(), 4, "the entry stays, so the order is not lost");
    assert_eq!(levels[1].state, TextEntryState::Dangling);
    assert_eq!(levels[1].name, None);
    assert_eq!(levels[0].state, TextEntryState::Ok);
    assert!(catalog
        .diagnostics
        .iter()
        .any(|entry| entry.code == "danglingTextLevel"));
    assert_eq!(text.fixture.story_bytes("Saga/Истории/Глава 1"), before);

    // A new page cannot take the missing level.
    let refused = create_page(
        &text.fixture.env(),
        &text.connection,
        &CreateTextPageRequest {
            expected_generation: 1,
            story_id: text.created.story_id.clone(),
            title: "X".to_owned(),
            parent_note_id: None,
            level_id: removed,
            format_id: None,
            order_key: "a0".to_owned(),
        },
    );
    assert!(matches!(
        refused,
        Err(ProjectError::UnknownTextLevel { .. })
    ));
}

#[test]
fn a_deleted_system_property_is_reported_and_the_block_is_kept() {
    let text = Text::new();
    let before = text.fixture.story_bytes("Saga/Истории/Глава 1");
    let manifest = text.manifest();
    let manifest_bytes =
        fs::read(text.fixture.vault.join("Saga/Истории/Глава 1/Глава 1.json")).unwrap();
    delete_database_property(
        &text.fixture.vault,
        &text.fixture.watcher,
        &DeleteDatabasePropertyRequest {
            expected_generation: 1,
            database_id: manifest.database_id.clone(),
            property_id: text.block()["properties"]["order"]
                .as_str()
                .unwrap()
                .to_owned(),
            expected_manifest_revision: raw_revision(&manifest_bytes),
        },
    )
    .unwrap();
    text.refresh();
    let catalog = load_catalog(&text.connection, &text.fixture.vault, 1).unwrap();
    let summary = catalog.workshops[0].stories[0].text.as_ref().unwrap();
    assert!(summary.properties.order.is_none() && summary.properties.level.is_some());
    assert!(catalog.diagnostics.iter().any(
        |entry| entry.code == "missingTextProperty" && entry.detail.as_deref() == Some("order")
    ));
    assert_eq!(text.fixture.story_bytes("Saga/Истории/Глава 1"), before);
    let refused = text.fixture.env();
    let page = create_page(
        &refused,
        &text.connection,
        &CreateTextPageRequest {
            expected_generation: 1,
            story_id: text.created.story_id.clone(),
            title: "X".to_owned(),
            parent_note_id: None,
            level_id: text.level(0),
            format_id: None,
            order_key: "a0".to_owned(),
        },
    );
    assert!(matches!(page, Err(ProjectError::Failed { code, .. }) if code == "textSchemaBroken"));
}

#[test]
fn when_the_text_database_is_missing_nothing_is_compared() {
    let text = Text::new();
    fs::remove_file(text.fixture.vault.join("Saga/Истории/Глава 1/Глава 1.json")).unwrap();
    text.refresh();
    let catalog = load_catalog(&text.connection, &text.fixture.vault, 1).unwrap();
    let story_summary = &catalog.workshops[0].stories[0];
    let summary = story_summary.text.as_ref().unwrap();
    assert!(summary.database_id.is_none());
    assert!(summary
        .levels
        .iter()
        .all(|level| level.state == TextEntryState::Unresolved));
    assert!(!catalog
        .diagnostics
        .iter()
        .any(|entry| entry.code.starts_with("dangling")));
    let found = discover_projects(&text.fixture.vault).unwrap();
    assert_eq!(found.workshops[0].stories.len(), 1);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

#[test]
fn a_page_is_created_with_all_its_values_in_one_write() {
    let text = Text::new();
    let book = text.page("Книга первая", None, 0, "a0");
    let chapter = {
        let created = create_page(
            &text.fixture.env(),
            &text.connection,
            &CreateTextPageRequest {
                expected_generation: 1,
                story_id: text.created.story_id.clone(),
                title: "Глава 1".to_owned(),
                parent_note_id: Some(book.clone()),
                level_id: text.level(2),
                format_id: Some(text.format("screenplay")),
                order_key: "a1".to_owned(),
            },
        )
        .unwrap();
        assert_eq!(created.parent_note_id.as_deref(), Some(book.as_str()));
        created.note_id
    };
    let note = text.note_text(&chapter);
    assert!(note.contains("Уровень: Глава"), "{note}");
    assert!(note.contains("Формат: Сценарий"), "{note}");
    assert!(note.contains("Порядок: a1"), "{note}");
    assert!(note.contains(&book), "{note}");
    assert!(note.contains("amby-id"), "{note}");

    // A top-level page with no format given is a manuscript page.
    let top = text.note_text(&book);
    assert!(
        top.contains("Уровень: Книга")
            && top.contains("Формат: Рукопись")
            && !top.contains("Родитель"),
        "{top}"
    );
    let databases = discover_vault(&text.fixture.vault).unwrap();
    assert!(
        databases.diagnostics.is_empty(),
        "{:?}",
        databases.diagnostics
    );
}

#[test]
fn a_page_request_is_checked_before_a_file_is_written() {
    let text = Text::new();
    let before = text.fixture.tree();
    let request = |edit: &dyn Fn(&mut CreateTextPageRequest)| {
        let mut request = CreateTextPageRequest {
            expected_generation: 1,
            story_id: text.created.story_id.clone(),
            title: "Глава".to_owned(),
            parent_note_id: None,
            level_id: text.level(2),
            format_id: None,
            order_key: "a0".to_owned(),
        };
        edit(&mut request);
        create_page(&text.fixture.env(), &text.connection, &request)
    };
    assert!(matches!(
        request(&|r| r.level_id = "01NOPE".to_owned()),
        Err(ProjectError::UnknownTextLevel { .. })
    ));
    assert!(matches!(
        request(&|r| r.format_id = Some("01NOPE".to_owned())),
        Err(ProjectError::UnknownTextFormat { .. })
    ));
    for key in ["", "a b", "a/0", &"a".repeat(65)] {
        let key = key.to_owned();
        assert!(
            matches!(
                request(&|r| r.order_key = key.clone()),
                Err(ProjectError::InvalidOrderKey)
            ),
            "{key:?}"
        );
    }
    assert!(matches!(
        request(&|r| r.parent_note_id = Some("01NOPE".to_owned())),
        Err(ProjectError::PageNotFound { .. })
    ));
    assert!(matches!(
        request(&|r| r.story_id = "nope".to_owned()),
        Err(ProjectError::StoryNotFound { .. })
    ));
    assert!(matches!(
        request(&|r| r.title = "a/b".to_owned()),
        Err(ProjectError::Failed { .. })
    ));
    assert_eq!(text.fixture.tree(), before);

    // A story without a text schema takes no pages.
    let level2 = text.level(2);
    let story_path = text
        .fixture
        .vault
        .join("Saga/Истории/Глава 1/amby-story.json");
    let mut doc: Value = serde_json::from_slice(&fs::read(&story_path).unwrap()).unwrap();
    doc.as_object_mut().unwrap().remove("text");
    fs::write(&story_path, serde_json::to_vec(&doc).unwrap()).unwrap();

    let none = create_page(
        &text.fixture.env(),
        &text.connection,
        &CreateTextPageRequest {
            expected_generation: 1,
            story_id: text.created.story_id.clone(),
            title: "Глава".to_owned(),
            parent_note_id: None,
            level_id: level2,
            format_id: None,
            order_key: "a0".to_owned(),
        },
    );
    assert_eq!(none, Err(ProjectError::TextNotConfigured));
}

#[test]
fn order_keys_are_alphanumeric_and_bounded() {
    for good in ["a0", "V", "a0V", &"z".repeat(64)] {
        assert!(valid_order_key(good), "{good}");
    }
    for bad in ["", "-", "a 0", "я", &"z".repeat(65)] {
        assert!(!valid_order_key(bad), "{bad}");
    }
}

#[test]
fn a_move_rewrites_only_the_moved_page_parent_and_order_together() {
    let text = Text::new();
    let book = text.page("Книга", None, 0, "a0");
    let other = text.page("Другая", None, 0, "a1");
    let chapter = text.page("Глава", Some(&book), 2, "a0");
    let sibling_before = text.note_text(&other);
    let book_before = text.note_text(&book);

    let moved = text
        .move_page(&text.movement(&chapter, Some(&other), "a5"))
        .unwrap();
    assert_eq!(moved.parent_note_id.as_deref(), Some(other.as_str()));
    let note = text.note_text(&chapter);
    assert!(note.contains(&other) && !note.contains(&book), "{note}");
    assert!(note.contains("Порядок: a5"), "{note}");
    assert_eq!(moved.revision, text.note_revision(&chapter));
    assert_eq!(text.note_text(&other), sibling_before);
    assert_eq!(
        text.note_text(&book),
        book_before,
        "no parent keeps a list of children"
    );

    // To the top: the parent value is removed, not left stale.
    text.refresh();
    text.move_page(&text.movement(&chapter, None, "a9"))
        .unwrap();
    let note = text.note_text(&chapter);
    assert!(
        !note.contains("Родитель") && note.contains("Порядок: a9"),
        "{note}"
    );
}

#[test]
fn a_move_that_would_make_a_loop_is_refused_and_writes_nothing() {
    let text = Text::new();
    let a = text.page("A", None, 0, "a0");
    let b = text.page("B", Some(&a), 1, "a0");
    let c = text.page("C", Some(&b), 2, "a0");
    let before = text.fixture.tree();
    for (label, note, parent) in [
        ("a<c", &a, &c),
        ("a<b", &a, &b),
        ("a<a", &a, &a),
        ("b<c", &b, &c),
    ] {
        assert_eq!(
            text.move_page(&text.movement(note, Some(parent), "a1"))
                .map(|_| ()),
            Err(ProjectError::ParentCycle),
            "{label}"
        );
    }
    assert_eq!(text.fixture.tree(), before);
    // Moving down the same branch without a loop is fine.
    assert!(text.move_page(&text.movement(&c, Some(&a), "a1")).is_ok());
}

#[test]
fn a_move_is_checked_like_every_write() {
    let text = Text::new();
    let a = text.page("A", None, 1, "a0");
    let b = text.page("B", None, 0, "a1");
    let before = text.fixture.tree();

    let mut stale = text.movement(&a, Some(&b), "a2");
    stale.expected_revision = "0".repeat(64);
    assert!(matches!(
        text.move_page(&stale),
        Err(ProjectError::RevisionConflict { .. })
    ));
    assert!(matches!(
        text.move_page(&text.movement(&a, Some("01NOPE"), "a2")),
        Err(ProjectError::PageNotFound { .. })
    ));
    let mut missing = text.movement(&a, None, "a2");
    missing.note_id = "01NOPE".to_owned();
    assert!(matches!(
        text.move_page(&missing),
        Err(ProjectError::PageNotFound { .. })
    ));
    assert_eq!(
        text.move_page(&text.movement(&a, None, "")).map(|_| ()),
        Err(ProjectError::InvalidOrderKey)
    );
    let mut bad_op = text.movement(&a, None, "a2");
    bad_op.operation_id = "../x".to_owned();
    assert_eq!(
        text.move_page(&bad_op).map(|_| ()),
        Err(ProjectError::InvalidOperationId)
    );
    assert_eq!(text.fixture.tree(), before);

    // The same intent twice writes once and answers the same.
    let request = text.movement(&a, Some(&b), "a2");
    let first = text.move_page(&request).unwrap();
    let after = text.fixture.tree();
    let again = text.move_page(&request).unwrap();
    assert_eq!(first.revision, again.revision);
    assert_eq!(text.fixture.tree(), after);
}

// ---------------------------------------------------------------------------
// Levels of parent and page
// ---------------------------------------------------------------------------

fn request_at(text: &Text, level: usize, parent: Option<&str>) -> CreateTextPageRequest {
    CreateTextPageRequest {
        expected_generation: 1,
        story_id: text.created.story_id.clone(),
        title: "Страница".to_owned(),
        parent_note_id: parent.map(str::to_owned),
        level_id: text.level(level),
        format_id: None,
        order_key: "a0".to_owned(),
    }
}

#[test]
fn a_page_goes_under_a_shallower_parent_and_a_level_may_be_skipped() {
    let text = Text::new();
    let arc = text.page("Арка", None, 1, "a0");
    // Same level and deeper parents are refused; nothing is written.
    let before = text.fixture.tree();
    let deeper = text.page("Страница 1", Some(&arc), 3, "a0");
    let before_refusals = text.fixture.tree();
    for (level, parent, label) in [
        (1, &arc, "same"),
        (0, &arc, "arc is deeper than a book"),
        (2, &deeper, "page is deeper than a chapter"),
    ] {
        let refused = create_page(
            &text.fixture.env(),
            &text.connection,
            &request_at(&text, level, Some(parent)),
        );
        assert!(
            matches!(&refused, Err(ProjectError::ParentLevelNotShallower { parent_level_id, level_id }) if *level_id == text.level(level) && !parent_level_id.is_empty()),
            "{label}: {refused:?}"
        );
    }
    assert_eq!(
        text.fixture.tree(),
        before_refusals,
        "a refusal writes nothing"
    );
    assert_ne!(before, before_refusals);

    // Book > Chapter skips the arc; Arc > Page skipped the chapter above (page 1 is level 3 under level 1).
    let book = text.page("Книга", None, 0, "a0");
    assert!(create_page(
        &text.fixture.env(),
        &text.connection,
        &request_at(&text, 2, Some(&book))
    )
    .is_ok());
    assert!(create_page(
        &text.fixture.env(),
        &text.connection,
        &request_at(&text, 3, Some(&book))
    )
    .is_ok());
}

#[test]
fn a_parent_without_a_known_level_constrains_nothing() {
    let text = Text::new();
    let loose = text.page("Без уровня", None, 1, "a0");
    // The level value is removed from the page, as an author may do by hand.
    let note = discover_vault(&text.fixture.vault)
        .unwrap()
        .notes
        .into_iter()
        .find(|note| note.note_id.as_deref() == Some(loose.as_str()))
        .unwrap();
    let without = fs::read_to_string(&note.path)
        .unwrap()
        .lines()
        .filter(|line| !line.starts_with("Уровень:"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(&note.path, without).unwrap();
    text.refresh();
    assert!(create_page(
        &text.fixture.env(),
        &text.connection,
        &request_at(&text, 0, Some(&loose))
    )
    .is_ok());
}

#[test]
fn a_move_keeps_the_level_rule_and_leaves_the_page_where_it_was_when_refused() {
    let text = Text::new();
    let book = text.page("Книга", None, 0, "a0");
    let chapter = text.page("Глава", Some(&book), 2, "a0");
    let second = text.page("Глава 2", Some(&book), 2, "a1");
    let page = text.page("Страница", Some(&chapter), 3, "a0");
    let before = text.fixture.tree();

    // Same level, and a deeper parent.
    for (note, parent) in [(&chapter, &second), (&chapter, &page), (&book, &chapter)] {
        let refused = text.move_page(&text.movement(note, Some(parent), "a5"));
        assert!(
            matches!(
                refused,
                Err(ProjectError::ParentLevelNotShallower { .. }) | Err(ProjectError::ParentCycle)
            ),
            "{refused:?}"
        );
    }
    assert!(matches!(
        text.move_page(&text.movement(&chapter, Some(&second), "a5")),
        Err(ProjectError::ParentLevelNotShallower { .. })
    ));
    assert_eq!(text.fixture.tree(), before);

    // Skipping a level is allowed, and so is going to the top.
    assert!(text
        .move_page(&text.movement(&page, Some(&book), "a2"))
        .is_ok());
    text.refresh();
    assert!(text.move_page(&text.movement(&page, None, "a3")).is_ok());
}

// ---------------------------------------------------------------------------
// A stale revision, by type
// ---------------------------------------------------------------------------

#[test]
fn a_stale_page_revision_comes_back_typed_with_the_revision_the_page_has_now() {
    let text = Text::new();
    let a = text.page("A", None, 1, "a0");
    let b = text.page("B", None, 0, "a1");
    let request = text.movement(&a, Some(&b), "a2");

    // Someone edits the page after the caller read it.
    let note = discover_vault(&text.fixture.vault)
        .unwrap()
        .notes
        .into_iter()
        .find(|note| note.note_id.as_deref() == Some(a.as_str()))
        .unwrap();
    let mut edited = fs::read(&note.path).unwrap();
    edited.extend_from_slice(b"\nA line the author added.\n");
    fs::write(&note.path, &edited).unwrap();
    let before = text.fixture.tree();

    match text.move_page(&request) {
        Err(ProjectError::RevisionConflict { actual_revision }) => {
            assert_eq!(
                actual_revision,
                raw_revision(&edited),
                "the revision on disk now"
            );
            assert_ne!(actual_revision, request.expected_revision);
        }
        other => panic!("expected a revision conflict, got {other:?}"),
    }
    assert_eq!(
        text.fixture.tree(),
        before,
        "the author's edit is untouched"
    );

    // The caller can retry with the revision it was given.
    let retry = MoveTextPageRequest {
        expected_revision: raw_revision(&edited),
        operation_id: format!("move-{}", ulid::Ulid::generate()),
        ..request
    };
    assert!(text.move_page(&retry).is_ok());
}

#[test]
fn another_failure_of_the_write_is_not_taken_for_a_conflict() {
    // A batch refused for a reason other than the revision stays a plain failure.
    let text = Text::new();
    let a = text.page("A", None, 0, "a0");
    let mut request = text.movement(&a, None, "a1");
    request.operation_id = "bad id with spaces".to_owned();
    assert_eq!(
        text.move_page(&request).map(|_| ()),
        Err(ProjectError::InvalidOperationId)
    );
}

// ---------------------------------------------------------------------------
// Relations of one note, both ways (the dossier's blocks)
// ---------------------------------------------------------------------------

#[test]
fn a_note_lists_who_points_at_it_and_whom_it_points_at() {
    use super::references::{list_references, ReferenceDirection};
    use crate::database::mutations::{
        apply_value_batch, create_database_property, CreateDatabasePropertyRequest,
        DatabaseValueBatchRequest, DatabaseValueMutation,
    };
    use crate::database::rows::{
        create_database_row, CreateDatabaseRowRequest, DatabaseRowTemplate,
    };

    let text = Text::new();
    let chapter = text.page("Глава первая", None, 2, "a0");
    let characters = manifest_database_id(&text, "Saga/Персонажи", "Персонажи");
    let alice = create_database_row(
        &text.fixture.vault,
        &text.fixture.watcher,
        &CreateDatabaseRowRequest {
            expected_generation: 1,
            database_id: characters.clone(),
            title: "Алиса".to_owned(),
            template: DatabaseRowTemplate::Default,
        },
    )
    .unwrap()
    .note_id;

    // The chapter gets a relation "Участники" to the characters, the way an author would.
    let text_manifest_bytes =
        fs::read(text.fixture.vault.join("Saga/Истории/Глава 1/Глава 1.json")).unwrap();
    let created = create_database_property(
        &text.fixture.vault,
        &text.fixture.watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: text.manifest().database_id,
            expected_manifest_revision: raw_revision(&text_manifest_bytes),
            name: "Участники".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(characters.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    let value =
        serde_json::to_string(&json!({"type": "relation", "targetNoteIds": [alice]})).unwrap();
    apply_value_batch(
        &text.fixture.vault,
        &text.fixture.watcher,
        &DatabaseValueBatchRequest {
            expected_generation: 1,
            database_id: text.manifest().database_id,
            operation_id: "relate-1".to_owned(),
            cells: vec![DatabaseValueMutation {
                note_id: chapter.clone(),
                property_id: created.property_id.clone(),
                value_json: Some(value),
                expected_revision: String::new(),
            }],
        },
        None,
    )
    .unwrap();
    text.refresh();

    let incoming = list_references(&text.connection, &alice).unwrap();
    assert_eq!(incoming.len(), 1, "{incoming:?}");
    let reference = &incoming[0];
    assert_eq!(reference.direction, ReferenceDirection::In);
    assert_eq!(reference.note_id, chapter);
    assert_eq!(reference.title.as_deref(), Some("Глава первая"));
    assert_eq!(reference.property_name, "Участники");
    assert_eq!(reference.database_name.as_deref(), Some("Глава 1"));
    assert_eq!(
        reference.database_id.as_deref(),
        Some(text.manifest().database_id.as_str())
    );

    // From the chapter's side, the same edge goes out; its parent relation has no target.
    let outgoing = list_references(&text.connection, &chapter).unwrap();
    assert_eq!(outgoing.len(), 1, "{outgoing:?}");
    assert_eq!(outgoing[0].direction, ReferenceDirection::Out);
    assert_eq!(outgoing[0].note_id, alice);
    assert_eq!(outgoing[0].title.as_deref(), Some("Алиса"));
    assert_eq!(outgoing[0].database_name.as_deref(), Some("Персонажи"));

    // A note nobody relates to has none.
    assert!(list_references(&text.connection, "01NOBODY")
        .unwrap()
        .is_empty());
}

fn manifest_database_id(text: &Text, container: &str, name: &str) -> String {
    let path = text
        .fixture
        .vault
        .join(container)
        .join(format!("{name}.json"));
    parse_manifest(&fs::read(path).unwrap())
        .unwrap()
        .value
        .database_id
}

// ---------------------------------------------------------------------------
// The levels the author chose
// ---------------------------------------------------------------------------

fn level_names(text: &Text) -> Vec<String> {
    let manifest = text.manifest();
    let block = text.block();
    let property = manifest
        .properties
        .iter()
        .find(|p| p.id() == block["properties"]["level"].as_str())
        .unwrap();
    block["levels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            property
                .find_option_name(entry["id"].as_str().unwrap())
                .unwrap()
                .to_owned()
        })
        .collect()
}

fn page_request(
    text: &Text,
    parent: Option<&str>,
    level: usize,
    key: &str,
) -> CreateTextPageRequest {
    CreateTextPageRequest {
        expected_generation: 1,
        story_id: text.created.story_id.clone(),
        title: "Страница".to_owned(),
        parent_note_id: parent.map(str::to_owned),
        level_id: text.level(level),
        format_id: None,
        order_key: key.to_owned(),
    }
}

#[test]
fn a_story_is_created_with_the_levels_the_author_chose() {
    let text = Text::from_levels(&[" Часть ", "Глава", "Сцена"]);
    assert_eq!(level_names(&text), ["Часть", "Глава", "Сцена"]);

    // Only the levels differ: the properties and formats are the template's, and a level is still
    // just the option's ID in the file, with no name.
    let block = text.block();
    assert_eq!(block["formats"].as_array().unwrap().len(), 4);
    for entry in block["levels"].as_array().unwrap() {
        assert_eq!(
            entry.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["id"]
        );
        assert!(ulid::Ulid::from_string(entry["id"].as_str().unwrap()).is_ok());
    }
    let file = String::from_utf8(text.fixture.story_bytes("Saga/Истории/Глава 1")).unwrap();
    assert!(
        !file.contains("Сцена"),
        "names are not stored in the structure file"
    );

    let catalog = load_catalog(&text.connection, &text.fixture.vault, 1).unwrap();
    let summary = catalog.workshops[0].stories[0].text.as_ref().unwrap();
    assert_eq!(
        summary
            .levels
            .iter()
            .map(|level| level.name.clone().unwrap())
            .collect::<Vec<_>>(),
        ["Часть", "Глава", "Сцена"]
    );
    assert!(summary
        .levels
        .iter()
        .all(|level| level.state == TextEntryState::Ok));

    // The rule of the parent follows the chosen order: a level may be skipped, not repeated.
    let part = text.page("Часть I", None, 0, "a0");
    text.page("Сцена 1", Some(&part), 2, "a0");
    let refused = create_page(
        &text.fixture.env(),
        &text.connection,
        &page_request(&text, Some(&part), 0, "a1"),
    );
    assert!(matches!(
        refused,
        Err(ProjectError::ParentLevelNotShallower { .. })
    ));
}

#[test]
fn a_one_level_story_takes_its_pages_in_a_row_at_the_top() {
    let text = Text::from_levels(&["Страница"]);
    assert_eq!(level_names(&text), ["Страница"]);

    let first = text.page("Раз", None, 0, "a0");
    let second = text.page("Два", None, 0, "a1");
    let third = text.page("Три", None, 0, "a2");

    // The only level is not shallower than itself, so nothing goes under a page ...
    let nested = create_page(
        &text.fixture.env(),
        &text.connection,
        &page_request(&text, Some(&first), 0, "a0"),
    );
    assert!(matches!(
        nested,
        Err(ProjectError::ParentLevelNotShallower { .. })
    ));
    let moved_under = text.move_page(&text.movement(&second, Some(&first), "a0"));
    assert!(matches!(
        moved_under,
        Err(ProjectError::ParentLevelNotShallower { .. })
    ));

    // ... but the pages keep their order among the roots and can be reordered there.
    let moved = text.move_page(&text.movement(&third, None, "a05")).unwrap();
    assert_eq!(moved.parent_note_id, None);
    assert_eq!(moved.order_key, "a05");
}

#[test]
fn repeating_a_create_with_levels_replays_and_another_list_under_the_same_id_is_refused() {
    let fixture = Fixture::new();
    let ws = fixture.create_workshop(&workshop("Saga")).unwrap();
    let mut request = story(&ws.workshop_id, "Глава 1");
    request.text_levels = Some(vec!["Книга".to_owned(), "Сцена".to_owned()]);
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

    // The list is part of the request: another one, or none, is another request.
    let mut other = request.clone();
    other.text_levels = Some(vec!["Книга".to_owned(), "Глава".to_owned()]);
    assert!(matches!(
        fixture.create_story(&other),
        Err(ProjectError::OperationIdReused { .. })
    ));
    other.text_levels = None;
    assert!(matches!(
        fixture.create_story(&other),
        Err(ProjectError::OperationIdReused { .. })
    ));
    assert_eq!(fixture.tree(), before);
}

fn assert_levels_refused(
    fixture: &Fixture,
    outcome: Result<CreatedStory, ProjectError>,
    why: &str,
) {
    assert!(
        matches!(&outcome, Err(ProjectError::InvalidName { field, .. }) if field == "textLevels"),
        "{why}: {outcome:?}"
    );
    assert_eq!(fixture.journal_files().len(), 1, "{why}: no story journal");
}

#[test]
fn a_bad_list_of_levels_is_refused_before_anything_is_written() {
    let fixture = Fixture::new();
    let ws = fixture.create_workshop(&workshop("Saga")).unwrap();
    let too_long = "я".repeat(101);
    let seven = ["1", "2", "3", "4", "5", "6", "7"];
    for (why, names) in [
        ("no level", Vec::<&str>::new()),
        ("seven levels", seven.to_vec()),
        ("blank name", vec!["Глава", "  "]),
        ("a name that is too long", vec!["Глава", too_long.as_str()]),
        ("a repeated name", vec!["Глава", "Сцена", "Глава"]),
        ("a name repeated in other case", vec!["Глава", "ГЛАВА"]),
        ("a control character", vec!["Гла\nва"]),
    ] {
        let mut req = story(&ws.workshop_id, "Глава 1");
        req.text_levels = Some(names.into_iter().map(str::to_owned).collect());
        let outcome = fixture.create_story(&req);
        assert_levels_refused(&fixture, outcome, why);
    }

    // Six levels are the most there can be.
    let mut six = story(&ws.workshop_id, "Глава 2");
    six.text_levels = Some(seven[..6].iter().map(|s| (*s).to_owned()).collect());
    fixture.create_story(&six).unwrap();
}

#[test]
fn chosen_levels_survive_a_failure_or_a_crash_and_the_cleanup_leaves_nothing() {
    let steps = [
        Step::StoryFolderCreated,
        Step::CardNoteCreated,
        Step::TextDatabaseCreated,
        Step::BeforeStoryFile,
    ];
    for crash in [false, true] {
        for target in steps.clone() {
            let fixture = Fixture::new();
            let ws = fixture.create_workshop(&workshop("Saga")).unwrap();
            let before = fixture.tree();
            let mut request = story(&ws.workshop_id, "Глава 1");
            request.text_levels = Some(vec!["Часть".to_owned(), "Сцена".to_owned()]);

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
            let outcome = fixture.create_story(&request);
            clear_step_hook();
            assert!(outcome.is_err(), "{target:?} crash={crash}");
            if crash {
                let report = recover_pending_projects(&fixture.vault).unwrap();
                assert!(report.quarantined.is_empty(), "{target:?}: {report:?}");
            }
            assert_eq!(
                fixture.tree(),
                before,
                "{target:?} crash={crash}: the vault is as before"
            );
            assert_eq!(fixture.journal_files().len(), 1);

            let created = fixture.create_story(&request).unwrap();
            assert!(!created.replayed);
            let doc: Value =
                serde_json::from_slice(&fixture.story_bytes("Saga/Истории/Глава 1")).unwrap();
            assert_eq!(doc["text"]["levels"].as_array().unwrap().len(), 2);
        }
    }
}

#[test]
fn a_repeat_after_an_unrecovered_crash_reuses_the_planned_levels() {
    let fixture = Fixture::new();
    let ws = fixture.create_workshop(&workshop("Saga")).unwrap();
    let mut request = story(&ws.workshop_id, "Глава 1");
    request.text_levels = Some(vec!["Часть".to_owned(), "Сцена".to_owned()]);
    set_step_hook(|step| (*step == Step::TextDatabaseCreated).then_some(Fault::Crash));
    assert!(fixture.create_story(&request).is_err());
    clear_step_hook();

    // The journal of the dead process holds the plan, IDs of the levels included.
    let planned_bytes = read_journal(&fixture.vault, &request.operation_id)
        .unwrap()
        .unwrap()
        .plan
        .story
        .unwrap()
        .story_file_bytes;
    let planned: Value = serde_json::from_slice(&planned_bytes).unwrap();
    assert_eq!(planned["text"]["levels"].as_array().unwrap().len(), 2);

    // Repeating the same intent cleans up after the crash and finishes with the planned IDs.
    fixture.create_story(&request).unwrap();
    let doc: Value = serde_json::from_slice(&fixture.story_bytes("Saga/Истории/Глава 1")).unwrap();
    assert_eq!(doc["text"]["levels"], planned["text"]["levels"]);
}

// ---------------------------------------------------------------------------
// Workshop settings & text status operations
// ---------------------------------------------------------------------------

use super::model::{
    AddTextStatusRequest, RemoveWorkshopSectionRequest, ReorderWorkshopSectionsRequest,
    TextLevelUpdateInput, UpdateTextLevelsRequest, UpdateWorkshopRequest,
};
use super::settings::{
    add_text_status, remove_workshop_section, reorder_workshop_sections, update_text_levels,
    update_workshop,
};

#[test]
fn update_workshop_edits_name_icon_and_tags_while_preserving_unknown_fields_and_bom() {
    let text = Text::new();
    let path = text.fixture.vault.join("Saga").join(WORKSHOP_FILE_NAME);
    let mut doc: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    doc["x-custom"] = json!({"keep": 42});
    let mut bytes = b"\xEF\xBB\xBF".to_vec();
    bytes.extend(serde_json::to_vec_pretty(&doc).unwrap());
    bytes.push(b'\n');
    fs::write(&path, &bytes).unwrap();
    let rev = raw_revision(&bytes);

    let updated = update_workshop(
        &text.fixture.env(),
        &UpdateWorkshopRequest {
            expected_generation: 1,
            operation_id: "op-update-1".to_owned(),
            workshop_id: text.created_ws.workshop_id.clone(),
            expected_workshop_revision: rev,
            name: Some("Хроники".to_owned()),
            icon: Some("lucide:Sparkles".to_owned()),
            tags: Some(vec!["фэнтези".to_owned(), "сериал".to_owned()]),
        },
    )
    .unwrap();
    assert!(!updated.replayed);

    let raw_after = fs::read(&path).unwrap();
    assert!(
        raw_after.starts_with(b"\xEF\xBB\xBF"),
        "UTF-8 BOM preserved"
    );
    assert_eq!(raw_revision(&raw_after), updated.workshop_revision);
    let after: Value = serde_json::from_slice(&raw_after[3..]).unwrap();
    assert_eq!(after["name"], "Хроники");
    assert_eq!(after["icon"], "lucide:Sparkles");
    assert_eq!(after["tags"], json!(["фэнтези", "сериал"]));
    assert_eq!(after["x-custom"], json!({"keep": 42}));
    assert!(
        text.fixture.vault.join("Saga").is_dir(),
        "folder on disk is not renamed"
    );
}

#[test]
fn remove_and_reorder_sections_update_only_the_workshop_file_and_forbid_removing_stories() {
    let text = Text::new();
    let stories_sec = text
        .created_ws
        .sections
        .iter()
        .find(|s| s.role == "stories")
        .unwrap();
    let other_sec = text
        .created_ws
        .sections
        .iter()
        .find(|s| s.role != "stories")
        .unwrap();

    // Removing the stories section is forbidden.
    let err = remove_workshop_section(
        &text.fixture.env(),
        &RemoveWorkshopSectionRequest {
            expected_generation: 1,
            operation_id: "op-rm-stories".to_owned(),
            workshop_id: text.created_ws.workshop_id.clone(),
            expected_workshop_revision: text.created_ws.file_revision.clone(),
            section_id: stories_sec.section_id.clone(),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ProjectError::CannotRemoveStoriesSection));

    // Removing a regular section removes its entry from amby-workshop.json, keeping the database on disk.
    let removed = remove_workshop_section(
        &text.fixture.env(),
        &RemoveWorkshopSectionRequest {
            expected_generation: 1,
            operation_id: "op-rm-other".to_owned(),
            workshop_id: text.created_ws.workshop_id.clone(),
            expected_workshop_revision: text.created_ws.file_revision.clone(),
            section_id: other_sec.section_id.clone(),
        },
    )
    .unwrap();
    let doc: Value = serde_json::from_slice(&text.fixture.workshop_bytes("Saga")).unwrap();
    let remaining_ids = doc["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert!(!remaining_ids.contains(&other_sec.section_id));
    assert!(
        text.fixture.vault.join(&other_sec.container_path).is_dir(),
        "database container remains on disk"
    );

    // Reordering sections reverses the remaining sections.
    let mut reversed = remaining_ids.clone();
    reversed.reverse();
    let reordered = reorder_workshop_sections(
        &text.fixture.env(),
        &ReorderWorkshopSectionsRequest {
            expected_generation: 1,
            operation_id: "op-reorder".to_owned(),
            workshop_id: text.created_ws.workshop_id.clone(),
            expected_workshop_revision: removed.workshop_revision,
            section_ids: reversed.clone(),
        },
    )
    .unwrap();
    let doc_after: Value = serde_json::from_slice(&text.fixture.workshop_bytes("Saga")).unwrap();
    let order_after = doc_after["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(order_after, reversed);
    assert_eq!(
        reordered.workshop_revision,
        raw_revision(&text.fixture.workshop_bytes("Saga"))
    );
}

#[test]
fn update_text_levels_renames_reorders_adds_and_recovers_on_crash() {
    let text = Text::new();
    let initial_levels = text.block()["levels"].as_array().unwrap().clone();
    let book_id = initial_levels[0]["id"].as_str().unwrap().to_owned();
    let arc_id = initial_levels[1]["id"].as_str().unwrap().to_owned();
    let chapter_id = initial_levels[2]["id"].as_str().unwrap().to_owned();
    let page_id = initial_levels[3]["id"].as_str().unwrap().to_owned();

    // Omitting an existing level is refused so pages never lose their hierarchy level.
    let omit_req = UpdateTextLevelsRequest {
        expected_generation: 1,
        operation_id: "op-levels-omit".to_owned(),
        story_id: text.created.story_id.clone(),
        expected_story_revision: text.created.story_file_revision.clone(),
        levels: vec![TextLevelUpdateInput {
            id: Some(book_id.clone()),
            name: "Том".to_owned(),
            icon: None,
        }],
    };
    assert!(matches!(
        update_text_levels(&text.fixture.env(), Some(&text.connection), &omit_req),
        Err(ProjectError::LevelInUse { .. }) | Err(ProjectError::UnknownTextLevel { .. })
    ));

    // Inject a failure before amby-story.json is written (on the 2nd atomic write): manifest must roll back cleanly.
    let before = text.fixture.tree();
    let req = UpdateTextLevelsRequest {
        expected_generation: 1,
        operation_id: "op-levels-1".to_owned(),
        story_id: text.created.story_id.clone(),
        expected_story_revision: text.created.story_file_revision.clone(),
        levels: vec![
            TextLevelUpdateInput {
                id: Some(chapter_id.clone()),
                name: "Эпизод".to_owned(),
                icon: Some("lucide:Film".to_owned()),
            },
            TextLevelUpdateInput {
                id: Some(book_id.clone()),
                name: "Том".to_owned(),
                icon: None,
            },
            TextLevelUpdateInput {
                id: Some(arc_id.clone()),
                name: "Арка".to_owned(),
                icon: None,
            },
            TextLevelUpdateInput {
                id: Some(page_id.clone()),
                name: "Страница".to_owned(),
                icon: None,
            },
            TextLevelUpdateInput {
                id: None,
                name: "Сцена".to_owned(),
                icon: Some("lucide:Sparkles".to_owned()),
            },
        ],
    };

    crate::frontmatter::inject_nth_atomic_write_failure(2, false);
    assert!(update_text_levels(&text.fixture.env(), Some(&text.connection), &req).is_err());
    crate::frontmatter::clear_atomic_write_failure();
    recover_pending_projects(&text.fixture.vault).unwrap();
    assert_eq!(
        text.fixture.tree(),
        before,
        "manifest and story file rolled back on crash before story file"
    );

    // Repeating with the same operation_id succeeds and reuses the journaled option ID.
    let updated = update_text_levels(&text.fixture.env(), Some(&text.connection), &req).unwrap();
    assert!(!updated.replayed);
    text.refresh();
    let catalog = load_catalog(&text.connection, &text.fixture.vault, 1).unwrap();
    let story = &catalog.workshops[0].stories[0];
    let resolved_levels = &story.text.as_ref().unwrap().levels;
    assert_eq!(resolved_levels.len(), 5);
    assert_eq!(resolved_levels[0].id, chapter_id);
    assert_eq!(resolved_levels[0].name.as_deref(), Some("Эпизод"));
    assert_eq!(resolved_levels[0].icon.as_deref(), Some("lucide:Film"));
    assert_eq!(resolved_levels[1].id, book_id);
    assert_eq!(resolved_levels[1].name.as_deref(), Some("Том"));
    assert_eq!(resolved_levels[4].name.as_deref(), Some("Сцена"));
    assert_eq!(resolved_levels[4].icon.as_deref(), Some("lucide:Sparkles"));
}

#[test]
fn legacy_story_without_status_property_works_cleanly_and_can_add_status_on_demand() {
    let text = Text::new();
    // Simulate a story created before status was introduced: remove status from amby-story.json and Глава 1.json.
    let story_path = text
        .fixture
        .vault
        .join("Saga/Истории/Глава 1")
        .join(STORY_FILE_NAME);
    let mut doc: Value = serde_json::from_slice(&fs::read(&story_path).unwrap()).unwrap();
    let status_prop_id = doc["text"]["properties"]["status"]
        .as_str()
        .unwrap()
        .to_owned();
    doc["text"]["properties"]
        .as_object_mut()
        .unwrap()
        .remove("status");
    let mut story_bytes = serde_json::to_vec_pretty(&doc).unwrap();
    story_bytes.push(b'\n');
    fs::write(&story_path, &story_bytes).unwrap();

    let manifest_path = text.fixture.vault.join("Saga/Истории/Глава 1/Глава 1.json");
    let mut manifest_doc: Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest_doc["properties"]
        .as_array_mut()
        .unwrap()
        .retain(|p| p["id"].as_str() != Some(status_prop_id.as_str()));
    let mut manifest_bytes = serde_json::to_vec_pretty(&manifest_doc).unwrap();
    manifest_bytes.push(b'\n');
    fs::write(&manifest_path, &manifest_bytes).unwrap();

    text.refresh();
    let catalog = load_catalog(&text.connection, &text.fixture.vault, 1).unwrap();
    assert!(
        catalog.diagnostics.is_empty(),
        "no diagnostic when status is omitted in legacy story: {:?}",
        catalog.diagnostics
    );
    let summary = catalog.workshops[0].stories[0].text.as_ref().unwrap();
    assert!(summary.properties.status.is_none());
    assert!(summary.status_options.is_empty());

    // Now add status via add_text_status.
    let added = add_text_status(
        &text.fixture.env(),
        &AddTextStatusRequest {
            expected_generation: 1,
            operation_id: "op-add-status".to_owned(),
            story_id: text.created.story_id.clone(),
            expected_story_revision: raw_revision(&story_bytes),
            labels: BTreeMap::new(),
        },
    )
    .unwrap();
    assert!(!added.replayed);
    assert!(ulid::Ulid::from_string(&added.property_id).is_ok());

    text.refresh();
    let catalog_after = load_catalog(&text.connection, &text.fixture.vault, 1).unwrap();
    let summary_after = catalog_after.workshops[0].stories[0].text.as_ref().unwrap();
    assert_eq!(
        summary_after.properties.status.as_deref(),
        Some(added.property_id.as_str())
    );
    assert_eq!(summary_after.status_options.len(), 3);
    assert_eq!(summary_after.status_options[0].name, "Черновик");
    assert_eq!(summary_after.status_options[0].group, "notStarted");
    assert_eq!(summary_after.status_options[1].name, "В работе");
    assert_eq!(summary_after.status_options[1].group, "inProgress");
    assert_eq!(summary_after.status_options[2].name, "Готово");
    assert_eq!(summary_after.status_options[2].group, "done");

    // Calling add_text_status with a new operation_id when status is already configured returns StatusAlreadyConfigured.
    let err = add_text_status(
        &text.fixture.env(),
        &AddTextStatusRequest {
            expected_generation: 1,
            operation_id: "op-add-status-2".to_owned(),
            story_id: text.created.story_id.clone(),
            expected_story_revision: added.story_revision,
            labels: BTreeMap::new(),
        },
    )
    .unwrap_err();
    assert!(matches!(err, ProjectError::StatusAlreadyConfigured));
}

// ---------------------------------------------------------------------------
// Settings: stale revisions, reused operation IDs, preserved bytes, read-only
// ---------------------------------------------------------------------------

fn stale() -> String {
    "0".repeat(64)
}

fn update_request(text: &Text, operation: &str, name: &str) -> UpdateWorkshopRequest {
    UpdateWorkshopRequest {
        expected_generation: 1,
        operation_id: operation.to_owned(),
        workshop_id: text.created_ws.workshop_id.clone(),
        expected_workshop_revision: text.created_ws.file_revision.clone(),
        name: Some(name.to_owned()),
        icon: None,
        tags: None,
    }
}

#[test]
fn workshop_settings_refuse_a_stale_revision_a_bad_name_and_a_reused_operation_id() {
    let text = Text::new();
    let env = text.fixture.env();
    let before = text.fixture.tree();
    let journals = text.fixture.journal_files();

    let mut old = update_request(&text, "op-stale", "Хроники");
    old.expected_workshop_revision = stale();
    assert!(matches!(
        update_workshop(&env, &old),
        Err(ProjectError::RevisionConflict { actual_revision }) if actual_revision == text.created_ws.file_revision
    ));
    for bad in ["a/b", "Конец.", "..", "q\"q"] {
        assert!(
            matches!(
                update_workshop(&env, &update_request(&text, "op-bad", bad)),
                Err(ProjectError::InvalidName { .. })
            ),
            "{bad:?}"
        );
    }
    let mut missing = update_request(&text, "op-missing", "Хроники");
    missing.workshop_id = "no-such-workshop".to_owned();
    assert!(matches!(
        update_workshop(&env, &missing),
        Err(ProjectError::WorkshopNotFound { .. })
    ));
    assert_eq!(text.fixture.tree(), before, "nothing was written");
    assert_eq!(text.fixture.journal_files(), journals);

    let request = update_request(&text, "op-update", "Хроники");
    let done = update_workshop(&env, &request).unwrap();
    let after = text.fixture.tree();
    let again = update_workshop(&env, &request).unwrap();
    assert!(again.replayed);
    assert_eq!(again.workshop_revision, done.workshop_revision);
    assert_eq!(text.fixture.tree(), after, "a repeat writes nothing");
    assert!(matches!(
        update_workshop(&env, &update_request(&text, "op-update", "Другое")),
        Err(ProjectError::OperationIdReused { .. })
    ));
    assert_eq!(text.fixture.tree(), after);
}

#[test]
fn section_removal_and_reorder_refuse_a_stale_revision_an_unknown_section_and_a_reused_id() {
    let text = Text::new();
    let env = text.fixture.env();
    let ws = &text.created_ws;
    let other = ws.sections.iter().find(|s| s.role != "stories").unwrap();
    let before = text.fixture.tree();

    let remove = |operation: &str, revision: String, section: &str| RemoveWorkshopSectionRequest {
        expected_generation: 1,
        operation_id: operation.to_owned(),
        workshop_id: ws.workshop_id.clone(),
        expected_workshop_revision: revision,
        section_id: section.to_owned(),
    };
    assert!(matches!(
        remove_workshop_section(&env, &remove("op-r1", stale(), &other.section_id)),
        Err(ProjectError::RevisionConflict { .. })
    ));
    assert!(matches!(
        remove_workshop_section(&env, &remove("op-r2", ws.file_revision.clone(), "nope")),
        Err(ProjectError::SectionNotFound { .. })
    ));
    let ids = ws
        .sections
        .iter()
        .map(|s| s.section_id.clone())
        .collect::<Vec<_>>();
    let reorder =
        |operation: &str, revision: String, ids: Vec<String>| ReorderWorkshopSectionsRequest {
            expected_generation: 1,
            operation_id: operation.to_owned(),
            workshop_id: ws.workshop_id.clone(),
            expected_workshop_revision: revision,
            section_ids: ids,
        };
    assert!(matches!(
        reorder_workshop_sections(&env, &reorder("op-o1", stale(), ids.clone())),
        Err(ProjectError::RevisionConflict { .. })
    ));
    assert_eq!(text.fixture.tree(), before, "nothing was written");

    let mut reversed = ids.clone();
    reversed.reverse();
    let done = reorder_workshop_sections(
        &env,
        &reorder("op-o2", ws.file_revision.clone(), reversed.clone()),
    )
    .unwrap();
    let again =
        reorder_workshop_sections(&env, &reorder("op-o2", ws.file_revision.clone(), reversed))
            .unwrap();
    assert!(again.replayed);
    assert_eq!(again.workshop_revision, done.workshop_revision);
    assert!(matches!(
        reorder_workshop_sections(&env, &reorder("op-o2", ws.file_revision.clone(), ids)),
        Err(ProjectError::OperationIdReused { .. })
    ));
    assert!(matches!(
        remove_workshop_section(
            &env,
            &remove("op-o2", ws.file_revision.clone(), &other.section_id)
        ),
        Err(ProjectError::OperationIdReused { .. })
    ));
}

fn level_inputs(text: &Text, names: &[&str]) -> Vec<TextLevelUpdateInput> {
    names
        .iter()
        .enumerate()
        .map(|(index, name)| TextLevelUpdateInput {
            id: Some(text.level(index)),
            name: (*name).to_owned(),
            icon: None,
        })
        .collect()
}

fn levels_request(
    text: &Text,
    operation: &str,
    levels: Vec<TextLevelUpdateInput>,
) -> UpdateTextLevelsRequest {
    UpdateTextLevelsRequest {
        expected_generation: 1,
        operation_id: operation.to_owned(),
        story_id: text.created.story_id.clone(),
        expected_story_revision: text.created.story_file_revision.clone(),
        levels,
    }
}

#[test]
fn text_levels_refuse_a_stale_revision_a_removed_level_and_a_reused_operation_id() {
    let text = Text::new();
    let env = text.fixture.env();
    let book = text.page("Том первый", None, 0, "a0");
    let before = text.fixture.tree();

    let mut old = levels_request(&text, "op-l1", level_inputs(&text, &["А", "Б", "В", "Г"]));
    old.expected_story_revision = stale();
    assert!(matches!(
        update_text_levels(&env, Some(&text.connection), &old),
        Err(ProjectError::RevisionConflict { .. })
    ));

    // The level of a page that exists is not allowed to disappear.
    let fewer = levels_request(&text, "op-l2", level_inputs(&text, &["А", "Б", "В"]));
    assert!(matches!(
        update_text_levels(&env, Some(&text.connection), &fewer),
        Err(ProjectError::UnknownTextLevel { .. })
    ));
    let mut foreign = level_inputs(&text, &["А", "Б", "В", "Г"]);
    foreign[0].id = Some("01NOPE".to_owned());
    assert!(matches!(
        update_text_levels(
            &env,
            Some(&text.connection),
            &levels_request(&text, "op-l3", foreign)
        ),
        Err(ProjectError::UnknownTextLevel { .. })
    ));
    for bad in [
        vec![],
        level_inputs(&text, &["А", "а", "В", "Г"]),
        level_inputs(&text, &["А", "", "В", "Г"]),
    ] {
        assert!(matches!(
            update_text_levels(
                &env,
                Some(&text.connection),
                &levels_request(&text, "op-l4", bad)
            ),
            Err(ProjectError::InvalidName { .. })
        ));
    }
    assert_eq!(text.fixture.tree(), before, "nothing was written");
    assert!(text.note_text(&book).contains("Том первый"));

    let request = levels_request(&text, "op-l5", level_inputs(&text, &["А", "Б", "В", "Г"]));
    let done = update_text_levels(&env, Some(&text.connection), &request).unwrap();
    let again = update_text_levels(&env, Some(&text.connection), &request).unwrap();
    assert!(again.replayed);
    assert_eq!(again.story_revision, done.story_revision);
    let other = levels_request(&text, "op-l5", level_inputs(&text, &["А", "Б", "В", "Д"]));
    assert!(matches!(
        update_text_levels(&env, Some(&text.connection), &other),
        Err(ProjectError::OperationIdReused { .. })
    ));
}

#[test]
fn updating_levels_keeps_the_unknown_fields_and_the_bom_of_the_story_file() {
    let text = Text::new();
    let inputs = level_inputs(&text, &["А", "Б", "В", "Г"]);
    let path = text
        .fixture
        .vault
        .join("Saga/Истории/Глава 1")
        .join(STORY_FILE_NAME);
    let mut doc: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    doc["x-other-app"] = json!({"keep": [1, 2, 3]});
    doc["text"]["x-extra"] = json!("kept too");
    let mut bytes = b"\xEF\xBB\xBF".to_vec();
    bytes.extend(serde_json::to_vec_pretty(&doc).unwrap());
    bytes.push(b'\n');
    fs::write(&path, &bytes).unwrap();

    let mut request = levels_request(&text, "op-keep", inputs);
    request.expected_story_revision = raw_revision(&bytes);
    let updated =
        update_text_levels(&text.fixture.env(), Some(&text.connection), &request).unwrap();

    let after = fs::read(&path).unwrap();
    assert!(after.starts_with(b"\xEF\xBB\xBF"), "the BOM stays");
    assert_eq!(raw_revision(&after), updated.story_revision);
    let value: Value = serde_json::from_slice(&after[3..]).unwrap();
    assert_eq!(value["x-other-app"], json!({"keep": [1, 2, 3]}));
    assert_eq!(value["text"]["x-extra"], "kept too");
    assert_eq!(value["text"]["levels"].as_array().unwrap().len(), 4);
}

#[test]
fn adding_a_status_refuses_a_stale_revision_and_a_reused_operation_id() {
    let text = Text::new();
    let env = text.fixture.env();
    let story_path = text
        .fixture
        .vault
        .join("Saga/Истории/Глава 1")
        .join(STORY_FILE_NAME);
    let manifest_path = text.fixture.vault.join("Saga/Истории/Глава 1/Глава 1.json");

    // A story from before status existed.
    let mut doc: Value = serde_json::from_slice(&fs::read(&story_path).unwrap()).unwrap();
    let status_id = doc["text"]["properties"]["status"]
        .as_str()
        .unwrap()
        .to_owned();
    doc["text"]["properties"]
        .as_object_mut()
        .unwrap()
        .remove("status");
    let mut story_bytes = serde_json::to_vec_pretty(&doc).unwrap();
    story_bytes.push(b'\n');
    fs::write(&story_path, &story_bytes).unwrap();
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["properties"]
        .as_array_mut()
        .unwrap()
        .retain(|property| property["id"].as_str() != Some(status_id.as_str()));
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let before = text.fixture.tree();

    let request = |operation: &str, revision: String| AddTextStatusRequest {
        expected_generation: 1,
        operation_id: operation.to_owned(),
        story_id: text.created.story_id.clone(),
        expected_story_revision: revision,
        labels: BTreeMap::new(),
    };
    assert!(matches!(
        add_text_status(&env, &request("op-s1", stale())),
        Err(ProjectError::RevisionConflict { .. })
    ));
    assert_eq!(text.fixture.tree(), before, "nothing was written");

    let good = request("op-s2", raw_revision(&story_bytes));
    let done = add_text_status(&env, &good).unwrap();
    let again = add_text_status(&env, &good).unwrap();
    assert!(again.replayed);
    assert_eq!(again.property_id, done.property_id);
    assert!(matches!(
        add_text_status(&env, &request("op-s2", stale())),
        Err(ProjectError::OperationIdReused { .. })
    ));
}

#[test]
fn settings_of_a_workshop_or_story_of_an_unknown_version_are_refused() {
    let text = Text::new();
    let env = text.fixture.env();

    // Workshop: a newer file, still read, never rewritten.
    let ws_path = text.fixture.vault.join("Saga").join(WORKSHOP_FILE_NAME);
    let mut ws_doc: Value = serde_json::from_slice(&fs::read(&ws_path).unwrap()).unwrap();
    ws_doc["formatVersion"] = json!(9);
    let ws_bytes = serde_json::to_vec_pretty(&ws_doc).unwrap();
    fs::write(&ws_path, &ws_bytes).unwrap();
    let mut request = update_request(&text, "op-future-ws", "Хроники");
    request.expected_workshop_revision = raw_revision(&ws_bytes);
    assert_eq!(
        update_workshop(&env, &request),
        Err(ProjectError::WorkshopReadOnly { format_version: 9 })
    );
    assert_eq!(fs::read(&ws_path).unwrap(), ws_bytes);

    // Story: the same for its settings file.
    let st_path = text
        .fixture
        .vault
        .join("Saga/Истории/Глава 1")
        .join(STORY_FILE_NAME);
    let mut st_doc: Value = serde_json::from_slice(&fs::read(&st_path).unwrap()).unwrap();
    st_doc["formatVersion"] = json!(9);
    let st_bytes = serde_json::to_vec_pretty(&st_doc).unwrap();
    fs::write(&st_path, &st_bytes).unwrap();
    let mut levels = levels_request(
        &text,
        "op-future-st",
        level_inputs(&text, &["А", "Б", "В", "Г"]),
    );
    levels.expected_story_revision = raw_revision(&st_bytes);
    assert_eq!(
        update_text_levels(&env, Some(&text.connection), &levels),
        Err(ProjectError::StoryReadOnly { format_version: 9 })
    );
    assert_eq!(fs::read(&st_path).unwrap(), st_bytes);
}
