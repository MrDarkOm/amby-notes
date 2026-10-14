//! Section presets: what a workshop peer database starts with, created through the real write path.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::database::format::raw_revision;

use super::create::{clear_step_hook, set_step_hook, Fault, Step};
use super::create_test::{workshop, Fixture};
use super::model::{CreateWorkshopSectionRequest, CreatedWorkshop, ProjectError};
use super::recovery::recover_pending_projects;
use crate::database::discovery::discover_vault;
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
    fixture.create_workshop(&workshop("Saga")).unwrap();

    let stories = manifest_json(&fixture, "Saga/Истории", "Истории");
    assert_eq!(
        stories["icon"].as_str(),
        Some("amby-icon:book-open:%2364748b")
    );
    let status = property(&stories, "Статус");
    assert_eq!(status["type"], "status");
    let synopsis = property(&stories, "Синопсис");
    assert_eq!(synopsis["type"], "text");

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

    // Characters should relate to Stories
    let stories_rel = property(&characters, "Истории");
    assert_eq!(stories_rel["type"], "relation");
    assert_eq!(
        stories_rel["config"]["targetDatabaseId"],
        stories["databaseId"]
    );

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

    // Locations should relate to Stories
    let loc_stories_rel = property(&locations, "Истории");
    assert_eq!(loc_stories_rel["type"], "relation");
    assert_eq!(
        loc_stories_rel["config"]["targetDatabaseId"],
        stories["databaseId"]
    );
}

#[test]
fn the_dossier_headings_come_from_the_page_template_of_the_database() {
    let fixture = Fixture::new();
    fixture.create_workshop(&workshop("Saga")).unwrap();
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
    let mut request = workshop("Saga");
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
    fixture.create_workshop(&request).unwrap();
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

    let mut clash = workshop("Other");
    clash.labels = BTreeMap::from([
        ("importance:main".to_owned(), "Same".to_owned()),
        ("importance:side".to_owned(), "same".to_owned()),
    ]);
    let before = fixture.tree();
    assert!(matches!(
        fixture.create_workshop(&clash),
        Err(ProjectError::InvalidName { .. })
    ));
    assert_eq!(fixture.tree(), before);
}

fn with_role(created: &CreatedWorkshop, name: &str, role: &str) -> CreateWorkshopSectionRequest {
    CreateWorkshopSectionRequest {
        expected_generation: 1,
        operation_id: format!("sec-{}", ulid::Ulid::generate()),
        workshop_id: created.workshop_id.clone(),
        expected_workshop_revision: created.file_revision.clone(),
        name: name.to_owned(),
        role: role.to_owned(),
        labels: BTreeMap::new(),
    }
}

#[test]
fn lazy_sections_can_be_added_from_their_preset() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let mut revision = created.file_revision.clone();

    for (role, name, icon) in [
        ("universes", "Вселенные", "globe"),
        ("arcs", "Арки", "git-branch"),
        ("anchors", "Зацепки", "anchor"),
        ("notes", "Заметки", "file-text"),
    ] {
        let mut request = with_role(&created, name, role);
        request.expected_workshop_revision = revision;
        let added = fixture.add_section(&request).unwrap();
        revision = added.workshop_revision;
        let manifest = manifest_json(&fixture, &format!("Saga/{name}"), name);
        assert_eq!(manifest["icon"], format!("amby-icon:{icon}:%2364748b"));
    }

    let databases = discover_vault(&fixture.vault).unwrap();
    assert!(
        databases.diagnostics.is_empty(),
        "{:?}",
        databases.diagnostics
    );
}

#[test]
fn a_failure_or_crash_around_a_preset_workshop_removes_manifests_templates_and_folders() {
    let steps = [
        Step::BeforeDatabase(1),
        Step::DatabaseCreated(1),
        Step::BeforeWorkshopFile,
    ];
    for crash in [false, true] {
        for target in &steps {
            let fixture = Fixture::new();
            let before = fixture.tree();
            let request = workshop("Saga");

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
            let outcome = fixture.create_workshop(&request);
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

            // The repeat makes one set with one template per dossier database.
            let done = fixture.create_workshop(&request).unwrap();
            for section in done
                .sections
                .iter()
                .filter(|section| section.role != "stories")
            {
                let container = fixture.vault.join(&section.container_path);
                assert_eq!(templates(&container).len(), 1, "{}", section.role);
                assert_eq!(
                    section.manifest_revision,
                    raw_revision(
                        &fs::read(container.join(format!("{}.json", section.name))).unwrap()
                    )
                );
            }
        }
    }
}

#[test]
fn a_template_the_user_has_edited_is_left_and_reported() {
    let fixture = Fixture::new();
    let request = workshop("Saga");
    set_step_hook(|step| (*step == Step::BeforeWorkshopFile).then_some(Fault::Crash));
    assert!(fixture.create_workshop(&request).is_err());
    clear_step_hook();

    let container = fixture.vault.join("Saga/Персонажи");
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

#[test]
fn a_relation_to_a_database_that_is_neither_planned_nor_on_disk_is_refused_before_any_write() {
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    // The stories database the arcs preset points at is gone from the disk.
    fs::remove_dir_all(fixture.vault.join("Saga/Истории")).unwrap();
    let before = fixture.tree();

    let outcome = fixture.add_section(&with_role(&created, "Арки", "arcs"));
    assert!(
        matches!(&outcome, Err(ProjectError::Failed { code, .. }) if code == "schemaBuild"),
        "{outcome:?}"
    );
    assert_eq!(fixture.tree(), before);
    assert!(
        fixture.journal_files().len() == 1,
        "only the workshop's own journal"
    );
}

#[test]
fn a_relation_between_databases_planned_together_needs_no_disk_lookup() {
    // The characters, locations and their "Stories" relation are planned before the stories
    // database exists on disk; the workshop is created whole.
    let fixture = Fixture::new();
    let created = fixture.create_workshop(&workshop("Saga")).unwrap();
    let characters = manifest_json(&fixture, "Saga/Персонажи", "Персонажи");
    let stories_id = created
        .sections
        .iter()
        .find(|section| section.role == "stories")
        .unwrap()
        .database_id
        .clone();
    assert_eq!(
        property(&characters, "Истории")["config"]["targetDatabaseId"],
        stories_id
    );
}
