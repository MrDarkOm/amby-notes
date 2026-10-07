//! Section presets: what a world section starts with, created through the real write path.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde_json::Value;

use super::create::{clear_step_hook, set_step_hook, Fault, Step};
use super::create_test::{section_request, story, Fixture};
use super::model::{CreateProjectSectionRequest, CreatedProject, ProjectError};
use super::recovery::recover_pending_projects;
use crate::database::discovery::discover_vault;
use crate::database::format::raw_revision;
use crate::database::rows::{create_database_row, CreateDatabaseRowRequest, DatabaseRowTemplate};

fn manifest_json(fixture: &Fixture, container: &str, name: &str) -> Value {
    let path = fixture.vault.join(container).join(format!("{name}.json"));
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn property<'a>(manifest: &'a Value, name: &str) -> &'a Value {
    manifest["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|property| property["name"] == name)
        .unwrap_or_else(|| panic!("no property {name}"))
}

fn option_names(property: &Value) -> Vec<String> {
    property["config"]["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|option| option["name"].as_str().unwrap().to_owned())
        .collect()
}

fn templates(container: &Path) -> Vec<String> {
    match fs::read_dir(container.join(".ambd/templates")) {
        Ok(entries) => entries
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[test]
fn the_base_world_sections_start_with_their_preset() {
    let fixture = Fixture::new();
    fixture.create(&story("Saga")).unwrap();

    let characters = manifest_json(&fixture, "Saga/Персонажи", "Персонажи");
    assert_eq!(
        characters["icon"].as_str(),
        Some("amby-icon:users:%2364748b")
    );
    let importance = property(&characters, "Значимость");
    assert_eq!(importance["type"], "select");
    assert_eq!(
        option_names(importance),
        ["Главные", "Второстепенные", "Эпизодические"]
    );
    let portrait = property(&characters, "Портрет");
    assert_eq!(portrait["type"], "files");
    assert!(ulid::Ulid::from_string(portrait["id"].as_str().unwrap()).is_ok());

    // One gallery, grouped by importance.
    let views = characters["views"].as_array().unwrap();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0]["layout"], "gallery");
    assert_eq!(views[0]["name"], "Галерея");
    assert_eq!(views[0]["group"]["field"]["propertyId"], importance["id"]);
    assert_eq!(characters["defaultViewId"], views[0]["viewId"]);

    let locations = manifest_json(&fixture, "Saga/Локации", "Локации");
    assert_eq!(
        locations["icon"].as_str(),
        Some("amby-icon:map-pin:%2364748b")
    );
    let kind = property(&locations, "Тип");
    assert_eq!(option_names(kind), ["Город", "Район", "Место", "Природа"]);
    assert_eq!(property(&locations, "Изображение")["type"], "files");
    assert_eq!(
        locations["views"][0]["group"]["field"]["propertyId"],
        kind["id"]
    );

    // Notes stay an empty table, and the text has its own schema, not a preset.
    let notes = manifest_json(&fixture, "Saga/Заметки", "Заметки");
    assert!(notes["properties"].as_array().unwrap().is_empty());
    assert_eq!(notes["views"][0]["layout"], "table");
    assert!(notes["icon"].is_null());
    let text = manifest_json(&fixture, "Saga/Текст", "Текст");
    assert!(text["icon"].is_null() && text["defaultTemplateId"].is_null());
}

#[test]
fn the_dossier_headings_come_from_the_page_template_of_the_database() {
    let fixture = Fixture::new();
    fixture.create(&story("Saga")).unwrap();
    let container = fixture.vault.join("Saga/Персонажи");
    let manifest = manifest_json(&fixture, "Saga/Персонажи", "Персонажи");
    let template_id = manifest["defaultTemplateId"].as_str().unwrap().to_owned();
    assert_eq!(manifest["templateOrder"], serde_json::json!([template_id]));
    assert_eq!(templates(&container), [format!("{template_id}.json")]);
    let file: Value = serde_json::from_slice(
        &fs::read(
            container
                .join(".ambd/templates")
                .join(format!("{template_id}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(file["name"], "Досье");
    assert_eq!(
        file["body"],
        "## Основное\n\n## Характеристика\n\n## Внешность\n\n## Биография\n\n"
    );
    assert_eq!(file["databaseId"], manifest["databaseId"]);

    // The existing row creation applies it; the database layer accepts everything as valid.
    let databases = discover_vault(&fixture.vault).unwrap();
    assert!(
        databases.diagnostics.is_empty(),
        "{:?}",
        databases.diagnostics
    );
    let database_id = manifest["databaseId"].as_str().unwrap().to_owned();
    let created = create_database_row(
        &fixture.vault,
        &fixture.watcher,
        &CreateDatabaseRowRequest {
            expected_generation: 1,
            database_id,
            title: "Алиса".to_owned(),
            template: DatabaseRowTemplate::Default,
        },
    )
    .unwrap();
    let note = fs::read_to_string(created.note_path).unwrap();
    assert!(
        note.contains("## Основное") && note.contains("## Биография"),
        "{note}"
    );

    // Locations get their own, shorter set.
    let locations = manifest_json(&fixture, "Saga/Локации", "Локации");
    let id = locations["defaultTemplateId"].as_str().unwrap();
    let file: Value = serde_json::from_slice(
        &fs::read(
            fixture
                .vault
                .join("Saga/Локации/.ambd/templates")
                .join(format!("{id}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(file["body"], "## Описание\n\n## История\n\n");
}

#[test]
fn names_follow_the_labels_of_the_active_language() {
    let fixture = Fixture::new();
    let mut request = story("Saga");
    request.labels = BTreeMap::from([
        ("section:characters".to_owned(), "Characters".to_owned()),
        ("preset:importance".to_owned(), "Importance".to_owned()),
        ("preset:portrait".to_owned(), "Portrait".to_owned()),
        ("importance:main".to_owned(), "Main".to_owned()),
        ("importance:side".to_owned(), "Supporting".to_owned()),
        ("importance:episode".to_owned(), "Minor".to_owned()),
        ("heading:basic".to_owned(), "Basics".to_owned()),
        ("heading:traits".to_owned(), "Traits".to_owned()),
        ("heading:appearance".to_owned(), "Appearance".to_owned()),
        ("heading:biography".to_owned(), "Biography".to_owned()),
        ("template:dossier".to_owned(), "Dossier".to_owned()),
        ("view:gallery".to_owned(), "Gallery".to_owned()),
    ]);
    fixture.create(&request).unwrap();
    let manifest = manifest_json(&fixture, "Saga/Characters", "Characters");
    assert_eq!(
        option_names(property(&manifest, "Importance")),
        ["Main", "Supporting", "Minor"]
    );
    assert_eq!(property(&manifest, "Portrait")["type"], "files");
    assert_eq!(manifest["views"][0]["name"], "Gallery");
    let id = manifest["defaultTemplateId"].as_str().unwrap();
    let file: Value = serde_json::from_slice(
        &fs::read(
            fixture
                .vault
                .join("Saga/Characters/.ambd/templates")
                .join(format!("{id}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(file["name"], "Dossier");
    assert!(file["body"].as_str().unwrap().starts_with("## Basics"));

    let mut clash = story("Other");
    clash.labels = BTreeMap::from([
        ("importance:main".to_owned(), "Same".to_owned()),
        ("importance:side".to_owned(), "same".to_owned()),
    ]);
    let before = fixture.tree();
    assert!(matches!(
        fixture.create(&clash),
        Err(ProjectError::InvalidName { .. })
    ));
    assert_eq!(fixture.tree(), before);
}

fn with_preset(created: &CreatedProject, name: &str, preset: &str) -> CreateProjectSectionRequest {
    CreateProjectSectionRequest {
        preset: Some(preset.to_owned()),
        ..section_request(created, name)
    }
}

#[test]
fn a_section_can_be_added_from_any_preset_and_only_from_a_known_one() {
    let fixture = Fixture::new();
    let created = fixture.create(&story("Saga")).unwrap();
    let mut revision = created.file_revision.clone();
    for (preset, name, icon) in [
        ("organizations", "Организации", "building-2"),
        ("items", "Предметы", "package"),
    ] {
        let mut request = with_preset(&created, name, preset);
        request.expected_project_revision = revision.clone();
        let added = fixture.add_section(&request).unwrap();
        revision = added.project_revision;
        let manifest = manifest_json(&fixture, &format!("Saga/{name}"), name);
        assert_eq!(manifest["icon"], format!("amby-icon:{icon}:%2364748b"));
        assert_eq!(manifest["views"][0]["layout"], "gallery");
        assert_eq!(property(&manifest, "Значимость")["type"], "select");
        assert_eq!(property(&manifest, "Изображение")["type"], "files");
        assert_eq!(
            added.section.manifest_revision,
            raw_revision(
                &fs::read(
                    fixture
                        .vault
                        .join("Saga")
                        .join(name)
                        .join(format!("{name}.json"))
                )
                .unwrap()
            )
        );
    }
    let databases = discover_vault(&fixture.vault).unwrap();
    assert!(
        databases.diagnostics.is_empty(),
        "{:?}",
        databases.diagnostics
    );

    let before = fixture.tree();
    let mut unknown = with_preset(&created, "Другое", "galaxy");
    unknown.expected_project_revision = revision.clone();
    assert!(matches!(
        fixture.add_section(&unknown),
        Err(ProjectError::UnsupportedPreset { .. })
    ));
    let mut text = with_preset(&created, "Ещё", "characters");
    text.role = Some("text".to_owned());
    text.expected_project_revision = revision;
    assert!(matches!(
        fixture.add_section(&text),
        Err(ProjectError::UnsupportedPreset { .. })
    ));
    assert_eq!(fixture.tree(), before);
}

#[test]
fn a_failure_or_crash_around_a_preset_section_removes_the_manifest_the_template_and_its_folders() {
    let steps = [
        Step::BeforeDatabase(0),
        Step::DatabaseCreated(0),
        Step::BeforeProjectFile,
    ];
    for crash in [false, true] {
        for target in &steps {
            let fixture = Fixture::new();
            let created = fixture.create(&story("Saga")).unwrap();
            let before = fixture.tree();
            let request = with_preset(&created, "Организации", "organizations");

            let target = target.clone();
            set_step_hook(move |step| {
                (*step == target).then(|| {
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
                recover_pending_projects(&fixture.vault).unwrap();
            }
            assert_eq!(
                fixture.tree(),
                before,
                "crash={crash}: no template, no .ambd, no manifest left"
            );

            // The repeat makes one section with one template, with the planned IDs.
            let done = fixture.add_section(&request).unwrap();
            let container = fixture.vault.join("Saga/Организации");
            assert_eq!(templates(&container).len(), 1);
            assert_eq!(
                done.section.manifest_revision,
                raw_revision(&fs::read(container.join("Организации.json")).unwrap())
            );
        }
    }
}

#[test]
fn a_template_the_user_has_edited_is_left_and_reported() {
    let fixture = Fixture::new();
    let created = fixture.create(&story("Saga")).unwrap();
    let request = with_preset(&created, "Организации", "organizations");
    set_step_hook(|step| (*step == Step::BeforeProjectFile).then_some(Fault::Crash));
    assert!(fixture.add_section(&request).is_err());
    clear_step_hook();

    let container = fixture.vault.join("Saga/Организации");
    let template = fs::read_dir(container.join(".ambd/templates"))
        .unwrap()
        .flatten()
        .next()
        .unwrap()
        .path();
    let mut edited = fs::read(&template).unwrap();
    edited.extend_from_slice(b"\n");
    fs::write(&template, &edited).unwrap();

    let report = recover_pending_projects(&fixture.vault).unwrap();
    assert_eq!(report.quarantined.len(), 1, "{report:?}");
    assert_eq!(
        fs::read(&template).unwrap(),
        edited,
        "the author's bytes are untouched"
    );
}
