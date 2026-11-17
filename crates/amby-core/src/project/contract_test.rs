//! The contract between this backend and the interface, kept honest by a real workshop.
//!
//! The test builds a workshop through the real write path (one initialization, stories, a universe, pages born
//! linked, a page named by a story's text, anchors and arcs bound to text pages), reads the catalog
//! and every row back through the real index and query, and compares the result with
//! `src/components/workspace/creative/workshop/real-workshop.fixture.json`. A Vitest test feeds
//! that same file to the interface's own model, so the keys and shapes the interface reads
//! (`storiesPropertyId`, `universePropertyId`, `cardNoteId`, a relation's `targetNoteIds`) are
//! the ones this backend really writes, not ones a mock invented.
//!
//! IDs are random, so the file holds stable names for them (`ID:...`). When the output changes on
//! purpose, regenerate it: `UPDATE_CREATIVE_FIXTURE=1 cargo test --lib contract_test`.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use rusqlite::Connection;
use serde_json::{json, Map, Value};

use super::create::init_workshop;
use super::create_test::{op, story, Fixture};
use super::index::{load_catalog, rebuild_project_index};
use super::links::create_entity;
use super::model::{
    CreateTextPageRequest, CreateWorkshopEntityRequest, CreatedStory, CreatedWorkshop,
    InitWorkshopRequest,
};
use super::notebooks::list_notebooks_of;
use super::text::create_page;
use crate::database::format::raw_revision;
use crate::database::model::{
    DatabasePageRequest, DatabaseQueryRequest, DatabaseQuerySource, DatabaseQuerySpec,
};
use crate::database::mutations::{create_database_property, CreateDatabasePropertyRequest};
use crate::database::projection::rebuild_database_projection;
use crate::database::query::query_database;
use crate::database::rows::{create_database_row, CreateDatabaseRowRequest, DatabaseRowTemplate};
use crate::index::schema::init_schema;

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../src/components/workspace/creative/workshop/real-workshop.fixture.json")
}

fn is_ulid_char(byte: u8) -> bool {
    byte.is_ascii_digit()
        || (byte.is_ascii_uppercase() && !matches!(byte, b'I' | b'L' | b'O' | b'U'))
}

/// Every 26-character ULID in `text`.
fn ulids_in(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut start = 0;
    while start < bytes.len() {
        if !is_ulid_char(bytes[start]) {
            start += 1;
            continue;
        }
        let mut end = start;
        while end < bytes.len() && is_ulid_char(bytes[end]) {
            end += 1;
        }
        if end - start == 26 {
            found.push(text[start..end].to_owned());
        }
        start = end;
    }
    found
}

/// Names for the IDs the test knows the meaning of. An ID without a name is a mistake of the
/// test (or a new ID in the output), never silently numbered: numbering by order of appearance
/// would depend on the random IDs.
#[derive(Default)]
struct Names(BTreeMap<String, String>);

impl Names {
    fn give(&mut self, id: &str, name: impl Into<String>) {
        let name = name.into();
        if let Some(previous) = self.0.insert(id.to_owned(), format!("ID:{name}")) {
            panic!("{id} named twice: {previous} and {name}");
        }
    }

    fn rename(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for id in ulids_in(text) {
            let name = self
                .0
                .get(&id)
                .unwrap_or_else(|| panic!("an ID without a name in the output: {id} in {text}"));
            out = out.replace(&id, name);
        }
        out
    }

    fn value(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.rename(text)),
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| self.value(item)).collect())
            }
            Value::Object(map) => {
                let mut renamed = Map::new();
                for (key, item) in map {
                    renamed.insert(self.rename(key), self.value(item));
                }
                Value::Object(renamed)
            }
            other => other.clone(),
        }
    }
}

struct Built {
    fixture: Fixture,
    created: CreatedWorkshop,
    houses: BTreeMap<&'static str, CreatedStory>,
}

fn rows_of(connection: &Connection, database_id: &str) -> Vec<crate::database::model::DatabaseRow> {
    query_database(
        connection,
        &DatabaseQueryRequest {
            expected_generation: 1,
            database_id: database_id.to_owned(),
            source: DatabaseQuerySource::Inline {
                spec: DatabaseQuerySpec {
                    filter: None,
                    sorts: Vec::new(),
                },
            },
            page: DatabasePageRequest {
                limit: 200,
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
    .rows
}

fn patch_note(path: &str, key: &str, ids: &[&str]) {
    let content = fs::read_to_string(path).unwrap();
    let sequence = serde_yaml::Value::Sequence(
        ids.iter()
            .map(|id| serde_yaml::Value::String((*id).to_owned()))
            .collect(),
    );
    let updated =
        crate::frontmatter::replace_yaml_binding_lossless(&content, key, &sequence).unwrap();
    fs::write(path, updated).unwrap();
}

fn build() -> Built {
    let fixture = Fixture::new();
    // The workshop as the interface makes it: one initialization, all seven bases with every link.
    let created = init_workshop(
        &fixture.env(),
        &InitWorkshopRequest {
            expected_generation: 1,
            operation_id: op("init"),
            path: "Saga".to_owned(),
            labels: BTreeMap::new(),
        },
    )
    .unwrap();
    let mut houses = BTreeMap::new();
    for title in ["Дом", "Лес", "Одна"] {
        houses.insert(
            title,
            fixture
                .create_story(&story(&created.workshop_id, title))
                .unwrap(),
        );
    }
    Built {
        fixture,
        created,
        houses,
    }
}

fn section_database(built: &Built, role: &str) -> String {
    let file: Value = serde_json::from_slice(&built.fixture.workshop_bytes("Saga")).unwrap();
    file["sections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|section| section["role"] == role)
        .unwrap()["databaseId"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn the_interface_reads_the_catalog_and_rows_this_backend_really_writes() {
    let built = build();
    let fixture = &built.fixture;
    let universes_db = section_database(&built, "universes");
    let characters_db = section_database(&built, "characters");
    let locations_db = section_database(&built, "locations");
    let stories_db = section_database(&built, "stories");
    let notes_db = section_database(&built, "notes");
    let anchors_db = section_database(&built, "anchors");
    let arcs_db = section_database(&built, "arcs");

    // A universe, and two of the stories in it (the relation lives in the story's card).
    let universe = create_database_row(
        &fixture.vault,
        &fixture.watcher,
        &CreateDatabaseRowRequest {
            expected_generation: 1,
            database_id: universes_db.clone(),
            title: "Мир".to_owned(),
            template: DatabaseRowTemplate::Default,
        },
    )
    .unwrap();
    for title in ["Дом", "Лес"] {
        let card = fixture.vault.join(&built.houses[title].card_path);
        patch_note(card.to_str().unwrap(), "Вселенная", &[&universe.note_id]);
    }

    // Pages: linked at birth, linked to two stories, linked to none, named only by a text.
    let entity = |section: &str, title: &str, story: Option<&str>| {
        create_entity(
            &fixture.env(),
            &CreateWorkshopEntityRequest {
                expected_generation: 1,
                workshop_id: built.created.workshop_id.clone(),
                section_id: section.to_owned(),
                title: title.to_owned(),
                story_id: story.map(|name| built.houses[name].story_id.clone()),
                notebook: None,
                universe_id: None,
            },
        )
        .unwrap()
    };
    let anna = entity("characters", "Анна", Some("Дом"));
    let boris = entity("characters", "Борис", Some("Дом"));
    let vera = entity("characters", "Вера", Some("Лес"));
    let gleb = entity("characters", "Глеб", Some("Одна"));
    let zoya = entity("characters", "Зоя", None);
    let eva = entity("characters", "Ева", None);
    let lake = entity("locations", "Озеро", Some("Дом"));
    // Anchors and arcs: two in a story by their own relation, one named only by a text, one free.
    let finale = entity("anchors", "Финал", Some("Дом"));
    let meeting = entity("anchors", "Встреча", Some("Дом"));
    let escape = entity("anchors", "Побег", None);
    let loose_anchor = entity("anchors", "Свободный", None);
    let love = entity("arcs", "Любовь", Some("Дом"));
    let revenge = entity("arcs", "Месть", None);
    // An event of the universe: an anchor born with its "Universe" value, in no story. The anchors
    // also name arcs, and an arc names its characters.
    let flood = create_entity(
        &fixture.env(),
        &CreateWorkshopEntityRequest {
            expected_generation: 1,
            workshop_id: built.created.workshop_id.clone(),
            section_id: "anchors".to_owned(),
            title: "Потоп".to_owned(),
            story_id: None,
            notebook: None,
            universe_id: Some(universe.note_id.clone()),
        },
    )
    .unwrap();
    patch_note(&meeting.note_path, "Арки", &[&love.note_id]);
    patch_note(
        &finale.note_path,
        "Арки",
        &[&love.note_id, &revenge.note_id],
    );
    patch_note(
        &love.note_path,
        "Персонажи",
        &[&anna.note_id, &boris.note_id],
    );

    // Notes in notebooks: nested ones, an empty one, one in the root, one in no story.
    let notes_folder = fixture.vault.join("Saga/Заметки");
    for folder in ["Идеи/Сюжеты", "Пустой"] {
        fs::create_dir_all(notes_folder.join(folder)).unwrap();
    }
    let note = |title: &str, story: Option<&str>, notebook: &[&str]| {
        create_entity(
            &fixture.env(),
            &CreateWorkshopEntityRequest {
                expected_generation: 1,
                workshop_id: built.created.workshop_id.clone(),
                section_id: "notes".to_owned(),
                title: title.to_owned(),
                story_id: story.map(|name| built.houses[name].story_id.clone()),
                notebook: Some(notebook.iter().map(|name| (*name).to_owned()).collect()),
                universe_id: None,
            },
        )
        .unwrap()
    };
    let draft = note("Заготовка", Some("Дом"), &["Идеи"]);
    let twist = note("Поворот", Some("Лес"), &["Идеи", "Сюжеты"]);
    let loose = note("Корневая", Some("Дом"), &[]);
    let nobody = note("Ничья", None, &["Идеи"]);
    patch_note(
        &boris.note_path,
        "Истории",
        &[
            &built.houses["Дом"].card_note_id,
            &built.houses["Лес"].card_note_id,
        ],
    );

    // The text of "Лес" names Zoya through a relation the author added to its pages.
    let forest = &built.houses["Лес"];
    let connection = Connection::open_in_memory().unwrap();
    init_schema(&connection).unwrap();
    let text_manifest = fixture.vault.join("Saga/Истории/Лес/Лес.json");
    let manifest_revision = raw_revision(&fs::read(&text_manifest).unwrap());
    let cast = create_database_property(
        &fixture.vault,
        &fixture.watcher,
        &CreateDatabasePropertyRequest {
            expected_generation: 1,
            database_id: forest.database_id.clone(),
            expected_manifest_revision: manifest_revision,
            name: "Кто".to_owned(),
            property_type: "relation".to_owned(),
            relation_target_database_id: Some(characters_db.clone()),
            relation_two_way: Some(false),
            ..Default::default()
        },
    )
    .unwrap();
    let story_file: Value =
        serde_json::from_slice(&fixture.story_bytes("Saga/Истории/Лес")).unwrap();
    let level_id = story_file["text"]["levels"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let page = create_page(
        &fixture.env(),
        &connection,
        &CreateTextPageRequest {
            expected_generation: 1,
            story_id: forest.story_id.clone(),
            title: "Глава".to_owned(),
            parent_note_id: None,
            level_id,
            format_id: None,
            order_key: "a0".to_owned(),
        },
    )
    .unwrap();
    patch_note(&page.note_path, "Кто", &[&zoya.note_id]);
    patch_note(&page.note_path, "Якоря", &[&escape.note_id]);

    // The text of "Дом": a book with two chapters; the chapters are bound to anchors and arcs.
    let house = &built.houses["Дом"];
    let house_file: Value =
        serde_json::from_slice(&fixture.story_bytes("Saga/Истории/Дом")).unwrap();
    let house_levels: Vec<String> = house_file["text"]["levels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|level| level["id"].as_str().unwrap().to_owned())
        .collect();
    let house_page = |title: &str, level: usize, parent: Option<&str>, order: &str| {
        create_page(
            &fixture.env(),
            &connection,
            &CreateTextPageRequest {
                expected_generation: 1,
                story_id: house.story_id.clone(),
                title: title.to_owned(),
                parent_note_id: parent.map(str::to_owned),
                level_id: house_levels[level].clone(),
                format_id: None,
                order_key: order.to_owned(),
            },
        )
        .unwrap()
    };
    let book = house_page("Книга", 0, None, "a0");
    // A child names its parent through the projection, which has to know the parent first.
    crate::index::sync::sync_vault(&connection, &fixture.vault).unwrap();
    rebuild_database_projection(&connection, &fixture.vault).unwrap();
    let chapter_one = house_page("Глава 1", 1, Some(&book.note_id), "a0");
    let chapter_two = house_page("Глава 2", 1, Some(&book.note_id), "a1");
    patch_note(&chapter_one.note_path, "Якоря", &[&meeting.note_id]);
    patch_note(
        &chapter_one.note_path,
        "Арки",
        &[&love.note_id, &revenge.note_id],
    );
    patch_note(
        &chapter_two.note_path,
        "Якоря",
        &[&finale.note_id, &meeting.note_id],
    );
    patch_note(&chapter_two.note_path, "Арки", &[&love.note_id]);

    crate::index::sync::sync_vault(&connection, &fixture.vault).unwrap();
    rebuild_database_projection(&connection, &fixture.vault).unwrap();
    rebuild_project_index(&connection, &fixture.vault).unwrap();
    let catalog = load_catalog(&connection, &fixture.vault, 1).unwrap();
    assert!(catalog.diagnostics.is_empty(), "{:?}", catalog.diagnostics);
    let mut summary = serde_json::to_value(&catalog.workshops[0]).unwrap();

    // Names for every ID the output may hold.
    let mut names = Names::default();
    names.give(&built.created.workshop_id, "workshop");
    for (role, id) in [
        ("universes", &universes_db),
        ("characters", &characters_db),
        ("locations", &locations_db),
        ("stories", &stories_db),
    ] {
        names.give(id, format!("db:{role}"));
    }
    let file: Value = serde_json::from_slice(&fixture.workshop_bytes("Saga")).unwrap();
    for section in file["sections"].as_array().unwrap() {
        let role = section["role"].as_str().unwrap();
        for (field, label) in [
            ("storiesPropertyId", "stories"),
            ("universePropertyId", "universe"),
            ("arcsPropertyId", "arcs"),
            ("charactersPropertyId", "characters"),
        ] {
            if let Some(id) = section[field].as_str() {
                names.give(id, format!("prop:{label}:{role}"));
            }
        }
    }
    names.give(&universe.note_id, "note:Мир");
    names.give(&notes_db, "db:notes");
    names.give(&anchors_db, "db:anchors");
    names.give(&arcs_db, "db:arcs");
    for (title, id) in [
        ("Финал", &finale.note_id),
        ("Встреча", &meeting.note_id),
        ("Побег", &escape.note_id),
        ("Свободный", &loose_anchor.note_id),
        ("Потоп", &flood.note_id),
        ("Любовь", &love.note_id),
        ("Месть", &revenge.note_id),
        ("Книга", &book.note_id),
        ("Глава 1", &chapter_one.note_id),
        ("Глава 2", &chapter_two.note_id),
    ] {
        names.give(id, format!("note:{title}"));
    }
    for (title, id) in [
        ("Заготовка", &draft.note_id),
        ("Поворот", &twist.note_id),
        ("Корневая", &loose.note_id),
        ("Ничья", &nobody.note_id),
    ] {
        names.give(id, format!("note:{title}"));
    }
    for (title, id) in [
        ("Анна", &anna.note_id),
        ("Борис", &boris.note_id),
        ("Вера", &vera.note_id),
        ("Глеб", &gleb.note_id),
        ("Зоя", &zoya.note_id),
        ("Ева", &eva.note_id),
        ("Озеро", &lake.note_id),
    ] {
        names.give(id, format!("note:{title}"));
    }
    for (title, created) in &built.houses {
        names.give(&created.story_id, format!("story:{title}"));
        names.give(&created.card_note_id, format!("card:{title}"));
        names.give(&created.database_id, format!("db:text:{title}"));
        // The text properties and the options the pages of this story hold.
        let block: Value =
            serde_json::from_slice(&fixture.story_bytes(&format!("Saga/Истории/{title}"))).unwrap();
        for (key, id) in block["text"]["properties"].as_object().unwrap() {
            names.give(id.as_str().unwrap(), format!("prop:text:{title}:{key}"));
        }
        for (index, level) in block["text"]["levels"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            names.give(
                level["id"].as_str().unwrap(),
                format!("option:level:{title}:{index}"),
            );
        }
        for format in block["text"]["formats"].as_array().unwrap() {
            names.give(
                format["id"].as_str().unwrap(),
                format!("option:format:{title}:{}", format["kind"].as_str().unwrap()),
            );
        }
    }
    names.give(&page.note_id, "note:Глава");
    names.give(&cast.property_id, "prop:text:Лес:cast");

    // The catalog: what the interface reads, minus what is random or irrelevant here.
    summary["fileRevision"] = json!("REV");
    for story in summary["stories"].as_array_mut().unwrap() {
        story["fileRevision"] = json!("REV");
        story["textJson"] = json!("");
        // Option IDs of the status property are only names for the status dots.
        story["text"]["statusOptions"] = json!([]);
    }
    let mut rows = Map::new();
    let mut database_ids = vec![
        universes_db,
        characters_db,
        locations_db,
        stories_db,
        notes_db.clone(),
        anchors_db.clone(),
        arcs_db.clone(),
    ];
    database_ids.extend(
        built
            .houses
            .values()
            .map(|created| created.database_id.clone()),
    );
    for database_id in database_ids {
        let mut list = rows_of(&connection, &database_id);
        list.sort_by(|a, b| {
            a.title
                .cmp(&b.title)
                .then(a.relative_path.cmp(&b.relative_path))
        });
        rows.insert(
            database_id,
            Value::Array(
                list.into_iter()
                    .map(|row| {
                        json!({
                            "noteId": row.note_id,
                            "title": row.title,
                            "relativePath": row.relative_path,
                            "categoryPath": row.category_path,
                            "values": serde_json::from_str::<Value>(&row.values_json).unwrap(),
                        })
                    })
                    .collect(),
            ),
        );
    }
    // The notebooks as the listing reads them from the disk; the vault's own path is a name and
    // the separators are the same on every system.
    let listing = list_notebooks_of(&connection, &fixture.vault, &notes_db).unwrap();
    let vault_prefix = fixture.vault.to_string_lossy().into_owned();
    let mut notebooks = serde_json::to_value(&listing).unwrap();
    notebooks["containerPath"] = json!(notebooks["containerPath"]
        .as_str()
        .unwrap()
        .replace(&vault_prefix, "VAULT")
        .replace('\\', "/"));
    for entry in notebooks["notebooks"].as_array_mut().unwrap() {
        entry["path"] = json!(entry["path"]
            .as_str()
            .unwrap()
            .replace(&vault_prefix, "VAULT")
            .replace('\\', "/"));
    }
    let produced = names.value(&json!({
        "workshop": summary,
        "rows": rows,
        "notebooks": { notes_db.clone(): notebooks },
    }));
    let text = serde_json::to_string_pretty(&produced).unwrap() + "\n";

    let path = fixture_path();
    if std::env::var_os("UPDATE_CREATIVE_FIXTURE").is_some() {
        fs::write(&path, &text).unwrap();
    }
    // A Windows checkout may turn the fixture's line endings into CRLF.
    let recorded = fs::read_to_string(&path)
        .unwrap_or_default()
        .replace("\r\n", "\n");
    assert_eq!(
        recorded, text,
        "the interface's fixture is out of date; run `UPDATE_CREATIVE_FIXTURE=1 cargo test --lib contract_test`"
    );

    // The pages carry the relation the way the interface reads it.
    let characters = &produced["rows"]["ID:db:characters"];
    let anna_values = characters
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["title"] == "Анна")
        .unwrap();
    assert_eq!(
        anna_values["values"]["ID:prop:stories:characters"]["targetNoteIds"],
        json!(["ID:card:Дом"])
    );

    // The text pages carry anchors and arcs the way the interface reads them, and the sections
    // name the properties by ID.
    let chapter = produced["rows"]["ID:db:text:Дом"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["title"] == "Глава 2")
        .unwrap();
    assert_eq!(
        chapter["values"]["ID:prop:text:Дом:anchors"]["targetNoteIds"],
        json!(["ID:note:Финал", "ID:note:Встреча"])
    );
    assert_eq!(
        chapter["values"]["ID:prop:text:Дом:arcs"]["targetNoteIds"],
        json!(["ID:note:Любовь"])
    );
    // An event of the universe carries the universe, an anchor its arcs and an arc its characters,
    // each under the property the workshop file names.
    let row_of = |database: &str, title: &str| {
        produced["rows"][database]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["title"] == title)
            .unwrap()
            .clone()
    };
    assert_eq!(
        row_of("ID:db:anchors", "Потоп")["values"]["ID:prop:universe:anchors"]["targetNoteIds"],
        json!(["ID:note:Мир"])
    );
    assert_eq!(
        row_of("ID:db:anchors", "Финал")["values"]["ID:prop:arcs:anchors"]["targetNoteIds"],
        json!(["ID:note:Любовь", "ID:note:Месть"])
    );
    assert_eq!(
        row_of("ID:db:arcs", "Любовь")["values"]["ID:prop:characters:arcs"]["targetNoteIds"],
        json!(["ID:note:Анна", "ID:note:Борис"])
    );
    let sections = produced["workshop"]["sections"].as_array().unwrap();
    let section = |role: &str| sections.iter().find(|s| s["role"] == role).unwrap();
    assert_eq!(
        section("anchors")["arcsPropertyId"],
        json!("ID:prop:arcs:anchors")
    );
    assert_eq!(
        section("anchors")["universePropertyId"],
        json!("ID:prop:universe:anchors")
    );
    assert_eq!(
        section("arcs")["charactersPropertyId"],
        json!("ID:prop:characters:arcs")
    );
    let stories = produced["workshop"]["stories"].as_array().unwrap();
    let properties =
        |name: &str| &stories.iter().find(|s| s["name"] == name).unwrap()["text"]["properties"];
    assert_eq!(
        properties("Дом")["anchors"],
        json!("ID:prop:text:Дом:anchors")
    );
    // A workshop made whole gives every text its relations at birth, the last story included.
    assert_eq!(
        properties("Одна")["anchors"],
        json!("ID:prop:text:Одна:anchors")
    );
    assert_eq!(properties("Одна")["arcs"], json!("ID:prop:text:Одна:arcs"));
}
