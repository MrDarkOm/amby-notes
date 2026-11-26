//! The dossier layout of a section's template (`ambyDossier`, docs/road/creative-visual.md §3):
//! read and written through the database manifest the template lives in, unknown fields kept,
//! no text of the author's template ever lost.

use std::fs;

use serde_json::Value;

use super::create_test::{workshop, Fixture};
use super::dossier_template::{get_dossier_template, update_dossier_template};
use super::links_test::{entry, manifest, workshop_file};
use super::model::{DossierLayout, DossierSection, ProjectError, UpdateDossierTemplateRequest};
use crate::database::format::raw_revision;

const CHARACTERS: &str = "Saga/Персонажи";

fn saga() -> (Fixture, String) {
    let fixture = Fixture::new();
    fixture.create_workshop(&workshop("Saga")).unwrap();
    let database_id = entry(&workshop_file(&fixture, "Saga"), "characters")["databaseId"]
        .as_str()
        .unwrap()
        .to_owned();
    (fixture, database_id)
}

fn manifest_path(fixture: &Fixture) -> std::path::PathBuf {
    fixture.vault.join(CHARACTERS).join("Персонажи.json")
}

fn characters(fixture: &Fixture) -> Value {
    manifest(fixture, CHARACTERS, "Персонажи")
}

fn property_id(fixture: &Fixture, name: &str) -> String {
    characters(fixture)["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|property| property["name"] == name)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn section(id: &str, title: &str, hint: &str, fields: &[String]) -> DossierSection {
    DossierSection {
        id: id.to_owned(),
        title: title.to_owned(),
        hint: hint.to_owned(),
        fields: fields.to_vec(),
    }
}

fn request(
    database_id: &str,
    template_id: &str,
    revision: &str,
    sections: Vec<DossierSection>,
) -> UpdateDossierTemplateRequest {
    UpdateDossierTemplateRequest {
        expected_generation: 1,
        database_id: database_id.to_owned(),
        template_id: template_id.to_owned(),
        expected_manifest_revision: revision.to_owned(),
        dossier: DossierLayout {
            version: 1,
            sections,
        },
    }
}

/// Rewrites the characters manifest by hand, as another app or an older Amby would.
fn edit_manifest(fixture: &Fixture, edit: impl FnOnce(&mut Value)) -> String {
    let path = manifest_path(fixture);
    let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    edit(&mut value);
    let bytes = serde_json::to_vec_pretty(&value).unwrap();
    fs::write(&path, &bytes).unwrap();
    raw_revision(&bytes)
}

#[test]
fn the_template_of_a_section_is_read_with_its_body_and_no_layout_yet() {
    let (fixture, database_id) = saga();
    let template = get_dossier_template(&fixture.vault, &database_id).unwrap();
    assert_eq!(template.database_id, database_id);
    assert!(template.body.contains("## Внешность"));
    assert!(template.dossier.is_none());
    assert_eq!(
        template.manifest_revision,
        raw_revision(&fs::read(manifest_path(&fixture)).unwrap())
    );
}

#[test]
fn a_layout_is_written_into_the_template_and_its_headings_into_the_body() {
    let (fixture, database_id) = saga();
    let template = get_dossier_template(&fixture.vault, &database_id).unwrap();
    let role = property_id(&fixture, "Роль");
    let before = characters(&fixture);

    let updated = update_dossier_template(
        &fixture.env(),
        &request(
            &database_id,
            &template.template_id,
            &template.manifest_revision,
            vec![
                section("basic", "Основное", "Возраст, занятие", &[role.clone()]),
                section("look", "Внешность", "Как выглядит", &[]),
                section("voice", "Голос", "", &[]),
            ],
        ),
    )
    .unwrap();

    let after = characters(&fixture);
    let stored = &after["templates"][0];
    assert_eq!(stored["ambyDossier"]["version"], 1);
    assert_eq!(stored["ambyDossier"]["sections"][0]["title"], "Основное");
    assert_eq!(
        stored["ambyDossier"]["sections"][0]["fields"][0],
        role.as_str()
    );
    assert_eq!(stored["ambyDossier"]["sections"][2]["hint"], "");
    assert_eq!(
        stored["body"], "## Основное\n\n## Внешность\n\n## Голос\n\n",
        "sections the old body had no text under are plain headings, in the new order"
    );
    // Nothing else of the manifest changed.
    assert_eq!(after["properties"], before["properties"]);
    assert_eq!(after["views"], before["views"]);
    assert_eq!(stored["templateId"], before["templates"][0]["templateId"]);
    assert_eq!(
        updated.template.manifest_revision,
        raw_revision(&fs::read(manifest_path(&fixture)).unwrap())
    );
    let read = get_dossier_template(&fixture.vault, &database_id).unwrap();
    assert_eq!(read.dossier, updated.template.dossier);
}

#[test]
fn the_text_of_the_old_template_is_kept_under_its_section_or_at_the_end() {
    let (fixture, database_id) = saga();
    let revision = edit_manifest(&fixture, |manifest| {
        let template = &mut manifest["templates"][0];
        template["body"] = Value::from(
            "Вступление.\n\n## Основное\nКто это.\n\n## Внешность\nРост, глаза.\n\n## Биография\nПрошлое.\n",
        );
        template["x-other-app"] = Value::from(7);
        template["ambyDossier"] = serde_json::json!({
            "version": 1,
            "sections": [
                { "id": "basic", "title": "Основное", "hint": "", "fields": [] },
                { "id": "look", "title": "Внешность", "hint": "", "fields": [] },
                { "id": "bio", "title": "Биография", "hint": "", "fields": [] }
            ]
        });
    });
    let template = get_dossier_template(&fixture.vault, &database_id).unwrap();
    assert_eq!(template.manifest_revision, revision);

    // "Внешность" is renamed (same id), "Основное" moves after it, "Биография" is dropped.
    update_dossier_template(
        &fixture.env(),
        &request(
            &database_id,
            &template.template_id,
            &revision,
            vec![
                section("look", "Облик", "", &[]),
                section("basic", "Основное", "", &[]),
            ],
        ),
    )
    .unwrap();

    let stored = &characters(&fixture)["templates"][0];
    assert_eq!(
        stored["body"],
        "Вступление.\n\n## Облик\nРост, глаза.\n\n## Основное\nКто это.\n\n## Биография\nПрошлое.\n",
        "the renamed section keeps its text; a dropped section's text stays, at the end"
    );
    assert_eq!(stored["x-other-app"], 7, "fields of other apps survive");
}

#[test]
fn a_bad_layout_is_refused_before_anything_is_written() {
    let (fixture, database_id) = saga();
    let template = get_dossier_template(&fixture.vault, &database_id).unwrap();
    let tree = fixture.tree();
    let attempt = |sections: Vec<DossierSection>| {
        update_dossier_template(
            &fixture.env(),
            &request(
                &database_id,
                &template.template_id,
                &template.manifest_revision,
                sections,
            ),
        )
    };
    let cases = vec![
        vec![],
        vec![section("a", "  ", "", &[])],
        vec![section("a", "Имя", "", &[]), section("b", "имя", "", &[])],
        vec![
            section("a", "Имя", "", &[]),
            section("a", "Другое", "", &[]),
        ],
        vec![section("a", "Две\nстроки", "", &[])],
        vec![section("a", "Имя", "", &["no-such-property".to_owned()])],
        (0..31)
            .map(|index| section(&format!("s{index}"), &format!("Раздел {index}"), "", &[]))
            .collect(),
    ];
    for sections in cases {
        let outcome = attempt(sections.clone());
        assert!(
            matches!(outcome, Err(ProjectError::InvalidName { .. })),
            "{sections:?}: {outcome:?}"
        );
    }
    assert_eq!(fixture.tree(), tree);
}

#[test]
fn a_stale_revision_or_an_unknown_template_is_refused() {
    let (fixture, database_id) = saga();
    let template = get_dossier_template(&fixture.vault, &database_id).unwrap();
    let tree = fixture.tree();
    let sections = vec![section("a", "Имя", "", &[])];
    assert!(matches!(
        update_dossier_template(
            &fixture.env(),
            &request(
                &database_id,
                &template.template_id,
                "stale",
                sections.clone()
            ),
        ),
        Err(ProjectError::RevisionConflict { .. })
    ));
    assert!(matches!(
        update_dossier_template(
            &fixture.env(),
            &request(
                &database_id,
                "no-such-template",
                &template.manifest_revision,
                sections
            ),
        ),
        Err(ProjectError::Failed { .. })
    ));
    assert_eq!(fixture.tree(), tree);
}
