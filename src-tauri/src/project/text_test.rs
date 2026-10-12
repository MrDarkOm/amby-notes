//! The text schema of a story and the page operations on it, through real files, the real
//! database layer and a real SQLite projection.

use std::collections::BTreeMap;
use std::fs;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::create::{clear_step_hook, set_step_hook, Fault, Step};
use super::create_test::{section_request, story, Fixture};
use super::discovery::discover_projects;
use super::index::{load_catalog, rebuild_project_index};
use super::journal::read_journal;
use super::model::{
    CreateProjectRequest, CreateProjectSectionRequest, CreateTextPageRequest, CreatedProject,
    MoveTextPageRequest, ProjectError, ProjectKind, SectionState, TextEntryState,
    PROJECT_FILE_NAME,
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
    created: CreatedProject,
    connection: Connection,
}

impl Text {
    fn new() -> Self {
        Self::from_request(story("Saga"))
    }

    /// A story created by `request`, which must be named "Saga" (the helpers read that folder).
    fn from_request(request: CreateProjectRequest) -> Self {
        let fixture = Fixture::new();
        let created = fixture.create(&request).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        init_schema(&connection).unwrap();
        let text = Self {
            fixture,
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
        let doc: Value = serde_json::from_slice(&self.fixture.project_bytes("Saga")).unwrap();
        doc["text"].clone()
    }

    fn manifest(&self) -> crate::database::format::DatabaseManifest {
        let path = self.fixture.vault.join("Saga/Текст/Текст.json");
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
                project_id: self.created.project_id.clone(),
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
            project_id: self.created.project_id.clone(),
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
    assert_eq!(names, ["Уровень", "Родитель", "Порядок", "Формат"]);

    let block = text.block();
    let properties = &block["properties"];
    for (key, name) in [
        ("level", "Уровень"),
        ("parent", "Родитель"),
        ("order", "Порядок"),
        ("format", "Формат"),
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
    let option_names = ["Книга", "Арка", "Глава", "Страница"];
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
    let file = String::from_utf8(text.fixture.project_bytes("Saga")).unwrap();
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
    let mut request = story("Saga");
    request.labels = BTreeMap::from([
        ("property:level".to_owned(), "Level".to_owned()),
        ("property:parent".to_owned(), "Parent".to_owned()),
        ("property:order".to_owned(), "Order".to_owned()),
        ("property:format".to_owned(), "Format".to_owned()),
        ("level:book".to_owned(), "Book".to_owned()),
        ("level:arc".to_owned(), "Arc".to_owned()),
        ("level:chapter".to_owned(), "Chapter".to_owned()),
        ("level:page".to_owned(), "Page".to_owned()),
        ("format:manuscript".to_owned(), "Manuscript".to_owned()),
        ("format:screenplay".to_owned(), "Screenplay".to_owned()),
        ("format:comic".to_owned(), "Comic".to_owned()),
        ("format:note".to_owned(), "Note".to_owned()),
    ]);
    fixture.create(&request).unwrap();
    let manifest = parse_manifest(&fs::read(fixture.vault.join("Saga/Текст/Текст.json")).unwrap())
        .unwrap()
        .value;
    let names = manifest
        .properties
        .iter()
        .map(|p| p.name().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(names, ["Level", "Parent", "Order", "Format"]);
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
    let mut clash = story("Saga");
    clash.labels = BTreeMap::from([
        ("level:book".to_owned(), "Part".to_owned()),
        ("level:arc".to_owned(), "part".to_owned()),
    ]);
    let before = other.tree();
    assert!(matches!(
        other.create(&clash),
        Err(ProjectError::InvalidName { .. })
    ));
    assert_eq!(other.tree(), before);
}

#[test]
fn a_story_without_base_sections_gets_the_schema_when_its_text_is_added() {
    let fixture = Fixture::new();
    let mut bare = story("Saga");
    bare.base_sections = false;
    let created = fixture.create(&bare).unwrap();
    let doc = serde_json::from_slice::<Value>(&fixture.project_bytes("Saga")).unwrap();
    assert!(doc.get("text").is_none());

    let mut request = section_request(&created, "Текст");
    request.role = Some("text".to_owned());
    let added = fixture.add_section(&request).unwrap();
    let doc = serde_json::from_slice::<Value>(&fixture.project_bytes("Saga")).unwrap();
    assert_eq!(doc["text"]["levels"].as_array().unwrap().len(), 4);
    assert_eq!(doc["sections"][0]["role"], "text");
    let manifest = parse_manifest(&fs::read(fixture.vault.join("Saga/Текст/Текст.json")).unwrap())
        .unwrap()
        .value;
    assert_eq!(manifest.properties.len(), 4);
    assert_eq!(
        added.section.manifest_revision,
        raw_revision(&fs::read(fixture.vault.join("Saga/Текст/Текст.json")).unwrap())
    );

    // One text per story.
    let mut second = CreateProjectSectionRequest {
        expected_project_revision: added.project_revision.clone(),
        ..section_request(&created, "Ещё текст")
    };
    second.role = Some("text".to_owned());
    assert!(matches!(
        fixture.add_section(&second),
        Err(ProjectError::UnsupportedRole { .. })
    ));
}

#[test]
fn a_failure_or_crash_while_creating_the_text_keeps_the_same_schema_on_repeat() {
    for crash in [false, true] {
        let fixture = Fixture::new();
        let mut bare = story("Saga");
        bare.base_sections = false;
        let created = fixture.create(&bare).unwrap();
        let before = fixture.tree();
        let mut request = section_request(&created, "Текст");
        request.role = Some("text".to_owned());

        set_step_hook(move |step| {
            (*step == Step::BeforeProjectFile).then(|| {
                if crash {
                    Fault::Crash
                } else {
                    Fault::Fail("injected".to_owned())
                }
            })
        });
        let outcome = fixture.add_section(&request);
        clear_step_hook();
        assert!(outcome.is_err());
        if crash {
            // The journal remembers the planned schema; activation removes only what is ours.
            recover_pending_projects(&fixture.vault).unwrap();
        }
        assert_eq!(fixture.tree(), before, "crash={crash}: nothing left behind");

        // A repeat of the same intent makes one schema, with its ULIDs fixed by the journal.
        let done = fixture.add_section(&request).unwrap();
        let doc = serde_json::from_slice::<Value>(&fixture.project_bytes("Saga")).unwrap();
        assert_eq!(doc["text"]["levels"].as_array().unwrap().len(), 4);
        let manifest =
            parse_manifest(&fs::read(fixture.vault.join("Saga/Текст/Текст.json")).unwrap())
                .unwrap();
        assert_eq!(manifest.value.properties.len(), 4);
        assert_eq!(done.section.manifest_revision, manifest.revision);
    }
}

#[test]
fn unknown_kinds_and_unknown_fields_of_the_text_block_survive_a_rewrite() {
    let text = Text::new();
    let path = text.fixture.vault.join("Saga").join(PROJECT_FILE_NAME);
    let mut doc: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    doc["text"]["formats"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "01JZ", "kind": "audio-drama", "tempo": 3}));
    doc["text"]["x-future"] = json!({"keep": true});
    let mut bytes = serde_json::to_vec_pretty(&doc).unwrap();
    bytes.push(b'\n');
    fs::write(&path, &bytes).unwrap();

    let mut request = section_request(&text.created, "Организации");
    request.expected_project_revision = raw_revision(&bytes);
    text.fixture.add_section(&request).unwrap();
    let after: Value = serde_json::from_slice(&text.fixture.project_bytes("Saga")).unwrap();
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
    let summary = catalog.projects[0].text.as_ref().unwrap();
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
        ["Книга", "Арка", "Глава", "Страница"]
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
    let before = text.fixture.project_bytes("Saga");
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
    let manifest_bytes = fs::read(text.fixture.vault.join("Saga/Текст/Текст.json")).unwrap();
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
    let levels = &catalog.projects[0].text.as_ref().unwrap().levels;
    assert_eq!(levels.len(), 4, "the entry stays, so the order is not lost");
    assert_eq!(levels[1].state, TextEntryState::Dangling);
    assert_eq!(levels[1].name, None);
    assert_eq!(levels[0].state, TextEntryState::Ok);
    assert!(catalog
        .diagnostics
        .iter()
        .any(|entry| entry.code == "danglingTextLevel"
            && entry.detail.as_deref() == Some(removed.as_str())));
    assert_eq!(text.fixture.project_bytes("Saga"), before);

    // A new page cannot take the missing level.
    let refused = create_page(
        &text.fixture.env(),
        &text.connection,
        &CreateTextPageRequest {
            expected_generation: 1,
            project_id: text.created.project_id.clone(),
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
    let before = text.fixture.project_bytes("Saga");
    let manifest = text.manifest();
    let manifest_bytes = fs::read(text.fixture.vault.join("Saga/Текст/Текст.json")).unwrap();
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
    let summary = catalog.projects[0].text.as_ref().unwrap();
    assert!(summary.properties.order.is_none() && summary.properties.level.is_some());
    assert!(catalog.diagnostics.iter().any(
        |entry| entry.code == "missingTextProperty" && entry.detail.as_deref() == Some("order")
    ));
    assert_eq!(text.fixture.project_bytes("Saga"), before);
    let refused = text.fixture.env();
    let page = create_page(
        &refused,
        &text.connection,
        &CreateTextPageRequest {
            expected_generation: 1,
            project_id: text.created.project_id.clone(),
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
    fs::remove_dir_all(text.fixture.vault.join("Saga/Текст")).unwrap();
    text.refresh();
    let catalog = load_catalog(&text.connection, &text.fixture.vault, 1).unwrap();
    let project = &catalog.projects[0];
    assert!(project
        .sections
        .iter()
        .any(|section| section.role.as_deref() == Some("text")
            && section.state == SectionState::Missing));
    let summary = project.text.as_ref().unwrap();
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
    assert_eq!(found.projects[0].doc.kind, ProjectKind::Story);
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
                project_id: text.created.project_id.clone(),
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
            project_id: text.created.project_id.clone(),
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
        request(&|r| r.project_id = "nope".to_owned()),
        Err(ProjectError::ProjectNotFound { .. })
    ));
    assert!(matches!(
        request(&|r| r.title = "a/b".to_owned()),
        Err(ProjectError::Failed { .. })
    ));
    assert_eq!(text.fixture.tree(), before);

    // A story without a text schema, and a project of an unknown version, take no pages.
    let mut bare = story("Bare");
    bare.base_sections = false;
    let bare = text.fixture.create(&bare).unwrap();
    let none = create_page(
        &text.fixture.env(),
        &text.connection,
        &CreateTextPageRequest {
            expected_generation: 1,
            project_id: bare.project_id,
            title: "Глава".to_owned(),
            parent_note_id: None,
            level_id: text.level(2),
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
        project_id: text.created.project_id.clone(),
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
    let text_manifest_bytes = fs::read(text.fixture.vault.join("Saga/Текст/Текст.json")).unwrap();
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
    assert_eq!(reference.database_name.as_deref(), Some("Текст"));
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

fn story_with_levels(names: &[&str]) -> CreateProjectRequest {
    let mut request = story("Saga");
    request.text_levels = Some(names.iter().map(|name| (*name).to_owned()).collect());
    request
}

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
        project_id: text.created.project_id.clone(),
        title: "Страница".to_owned(),
        parent_note_id: parent.map(str::to_owned),
        level_id: text.level(level),
        format_id: None,
        order_key: key.to_owned(),
    }
}

#[test]
fn a_story_is_created_with_the_levels_the_author_chose() {
    let text = Text::from_request(story_with_levels(&[" Часть ", "Глава", "Сцена"]));
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
    let file = String::from_utf8(text.fixture.project_bytes("Saga")).unwrap();
    assert!(
        !file.contains("Сцена"),
        "names are not stored in the structure file"
    );

    let catalog = load_catalog(&text.connection, &text.fixture.vault, 1).unwrap();
    let summary = catalog.projects[0].text.as_ref().unwrap();
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
    let text = Text::from_request(story_with_levels(&["Страница"]));
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
fn a_request_without_levels_hashes_as_it_did_before_the_field_existed() {
    // An operation journaled by an older build is still the same request when it is repeated.
    let fixture = Fixture::new();
    let request = story("Saga");
    fixture.create(&request).unwrap();
    let journal = read_journal(&fixture.vault, &request.operation_id)
        .unwrap()
        .unwrap();
    let old_payload = json!({
        "kind": "story",
        "name": "Saga",
        "parentPath": null,
        "icon": null,
        "tags": [],
        "groups": [["work", "Произведение"], ["world", "Мир"]],
        "sections": [
            ["text", "work", "Текст"],
            ["notes", "work", "Заметки"],
            ["characters", "world", "Персонажи"],
            ["locations", "world", "Локации"],
        ],
        "labels": {},
    });
    assert_eq!(
        journal.request_revision,
        raw_revision(&serde_json::to_vec(&old_payload).unwrap())
    );
}

#[test]
fn repeating_a_create_with_levels_replays_and_another_list_under_the_same_id_is_refused() {
    let fixture = Fixture::new();
    let request = story_with_levels(&["Книга", "Сцена"]);
    let first = fixture.create(&request).unwrap();
    let before = fixture.tree();

    let again = fixture.create(&request).unwrap();
    assert!(again.replayed);
    assert_eq!(
        CreatedProject {
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
        fixture.create(&other),
        Err(ProjectError::OperationIdReused { .. })
    ));
    other.text_levels = None;
    assert!(matches!(
        fixture.create(&other),
        Err(ProjectError::OperationIdReused { .. })
    ));
    assert_eq!(fixture.tree(), before);
}

#[test]
fn a_text_section_added_later_takes_the_levels_too() {
    let fixture = Fixture::new();
    let mut bare = story("Saga");
    bare.base_sections = false;
    let created = fixture.create(&bare).unwrap();
    let mut request = section_request(&created, "Текст");
    request.role = Some("text".to_owned());
    request.text_levels = Some(vec!["Глава".to_owned(), "Сцена".to_owned()]);

    let added = fixture.add_section(&request).unwrap();
    let again = fixture.add_section(&request).unwrap();
    assert!(again.replayed);
    assert_eq!(again.section.database_id, added.section.database_id);

    let doc: Value = serde_json::from_slice(&fixture.project_bytes("Saga")).unwrap();
    assert_eq!(doc["text"]["levels"].as_array().unwrap().len(), 2);
    let manifest =
        parse_manifest(&fs::read(fixture.vault.join("Saga/Текст/Текст.json")).unwrap()).unwrap();
    let level = manifest
        .value
        .properties
        .iter()
        .find(|p| p.id() == doc["text"]["properties"]["level"].as_str())
        .unwrap();
    let names = doc["text"]["levels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            level
                .find_option_name(entry["id"].as_str().unwrap())
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(names, ["Глава", "Сцена"]);

    let mut other = request.clone();
    other.text_levels = Some(vec!["Глава".to_owned()]);
    assert!(matches!(
        fixture.add_section(&other),
        Err(ProjectError::OperationIdReused { .. })
    ));
}

fn assert_levels_refused(
    fixture: &Fixture,
    outcome: Result<CreatedProject, ProjectError>,
    why: &str,
) {
    assert!(
        matches!(&outcome, Err(ProjectError::InvalidName { field, .. }) if field == "textLevels"),
        "{why}: {outcome:?}"
    );
    assert!(fixture.tree().is_empty(), "{why}: nothing was written");
    assert!(fixture.journal_files().is_empty(), "{why}: no journal");
}

#[test]
fn a_bad_list_of_levels_is_refused_before_anything_is_written() {
    let fixture = Fixture::new();
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
        let outcome = fixture.create(&story_with_levels(&names));
        assert_levels_refused(&fixture, outcome, why);
    }

    // Six levels are the most there can be.
    let six = Fixture::new();
    six.create(&story_with_levels(&seven[..6])).unwrap();
}

#[test]
fn levels_are_refused_where_no_text_is_created() {
    let fixture = Fixture::new();
    // A universe, and a story without its base sections, have no text to give levels to.
    let mut universe = story_with_levels(&["Глава"]);
    universe.kind = ProjectKind::Collection;
    assert_levels_refused(&fixture, fixture.create(&universe), "a universe");
    let mut bare = story_with_levels(&["Глава"]);
    bare.base_sections = false;
    assert_levels_refused(&fixture, fixture.create(&bare), "a story without sections");

    // A section that is not the text.
    let host = Fixture::new();
    let created = host.create(&story("Saga")).unwrap();
    let before = host.tree();
    let mut request = section_request(&created, "Организации");
    request.text_levels = Some(vec!["Глава".to_owned()]);
    assert!(matches!(
        host.add_section(&request),
        Err(ProjectError::InvalidName { field, .. }) if field == "textLevels"
    ));
    assert_eq!(host.tree(), before);

    // A bad list for the text section is refused the same way.
    let mut text = section_request(&created, "Текст 2");
    text.role = Some("text".to_owned());
    text.text_levels = Some(Vec::new());
    assert!(matches!(
        host.add_section(&text),
        Err(ProjectError::InvalidName { field, .. }) if field == "textLevels"
    ));
    assert_eq!(host.tree(), before);
}

#[test]
fn chosen_levels_survive_a_failure_or_a_crash_and_the_cleanup_leaves_nothing() {
    let steps = [
        Step::FolderCreated,
        Step::BeforeDatabase(0),
        Step::DatabaseCreated(0),
        Step::DatabaseCreated(1),
        Step::BeforeProjectFile,
    ];
    for crash in [false, true] {
        for target in steps.clone() {
            let fixture = Fixture::new();
            fs::write(fixture.vault.join("Existing.md"), b"# keep\n").unwrap();
            let before = fixture.tree();
            let request = story_with_levels(&["Часть", "Сцена"]);

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
            let outcome = fixture.create(&request);
            clear_step_hook();
            assert!(outcome.is_err(), "{target:?} crash={crash}");
            if crash {
                // The journal remembers the planned manifest, so cleanup can prove it is ours.
                let report = recover_pending_projects(&fixture.vault).unwrap();
                assert!(report.quarantined.is_empty(), "{target:?}: {report:?}");
            }
            assert_eq!(
                fixture.tree(),
                before,
                "{target:?} crash={crash}: the vault is as before"
            );
            assert!(fixture.journal_files().is_empty());

            let created = fixture.create(&request).unwrap();
            assert!(!created.replayed);
            let doc: Value = serde_json::from_slice(&fixture.project_bytes("Saga")).unwrap();
            assert_eq!(doc["text"]["levels"].as_array().unwrap().len(), 2);
        }
    }
}

#[test]
fn a_repeat_after_an_unrecovered_crash_reuses_the_planned_levels() {
    let fixture = Fixture::new();
    let request = story_with_levels(&["Часть", "Сцена"]);
    set_step_hook(|step| (*step == Step::DatabaseCreated(0)).then_some(Fault::Crash));
    assert!(fixture.create(&request).is_err());
    clear_step_hook();

    // The journal of the dead process holds the plan, IDs of the levels included.
    let planned = read_journal(&fixture.vault, &request.operation_id)
        .unwrap()
        .unwrap()
        .plan
        .text_block
        .unwrap();
    assert_eq!(planned["levels"].as_array().unwrap().len(), 2);

    // Repeating the same intent cleans up after the crash and finishes with the planned IDs.
    fixture.create(&request).unwrap();
    let doc: Value = serde_json::from_slice(&fixture.project_bytes("Saga")).unwrap();
    assert_eq!(doc["text"]["levels"], planned["levels"]);
}
