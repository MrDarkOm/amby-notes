//! Discovery and the SQLite projection for Creative Workshop v3,
//! including sections-to-databases join, stories discovery and diagnostics.

use std::fs;
use std::path::PathBuf;

use rusqlite::Connection;
use serde_json::json;

use super::create::{create_story, create_workshop, Env};
use super::discovery::discover_projects;
use super::index::{is_built, load_catalog, rebuild_project_index};
use super::model::{
    CreateStoryRequest, CreateWorkshopRequest, CreatedStory, CreatedWorkshop, SectionState,
    WORKSHOP_FILE_NAME,
};
use crate::database::projection::rebuild_database_projection;
use crate::index::schema::init_schema;
use crate::watcher::WatcherState;

struct Vault {
    root: PathBuf,
    watcher: WatcherState,
    connection: Connection,
}

impl Vault {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("amby-workshop-index-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&path).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        init_schema(&connection).unwrap();
        Self {
            root: path.canonicalize().unwrap(),
            watcher: WatcherState::new(),
            connection,
        }
    }

    fn write_workshop(&self, folder: &str, value: serde_json::Value) -> Vec<u8> {
        let directory = self.root.join(folder);
        fs::create_dir_all(&directory).unwrap();
        let bytes = serde_json::to_vec_pretty(&value).unwrap();
        fs::write(directory.join(WORKSHOP_FILE_NAME), &bytes).unwrap();
        bytes
    }

    fn create_ws(&self, name: &str) -> CreatedWorkshop {
        create_workshop(
            &Env {
                vault: &self.root,
                watcher: &self.watcher,
            },
            &CreateWorkshopRequest {
                expected_generation: 1,
                operation_id: format!("op-{}", ulid::Ulid::generate()),
                name: name.to_owned(),
                parent_path: None,
                icon: None,
                tags: vec!["Комикс".to_owned()],
                labels: Default::default(),
            },
        )
        .unwrap()
    }

    fn create_st(&self, ws_id: &str, name: &str) -> CreatedStory {
        create_story(
            &Env {
                vault: &self.root,
                watcher: &self.watcher,
            },
            &CreateStoryRequest {
                expected_generation: 1,
                operation_id: format!("op-{}", ulid::Ulid::generate()),
                workshop_id: ws_id.to_owned(),
                title: name.to_owned(),
                labels: Default::default(),
                text_levels: None,
            },
        )
        .unwrap()
    }

    /// What the app does after a change: refresh databases, then workshops.
    fn refresh(&self) {
        rebuild_database_projection(&self.connection, &self.root).unwrap();
        rebuild_project_index(&self.connection, &self.root).unwrap();
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).ok();
    }
}

fn minimal_ws(id: &str, name: &str) -> serde_json::Value {
    json!({
        "formatVersion": 3,
        "workshopId": id,
        "name": name,
        "sections": []
    })
}

fn codes(vault: &Vault) -> Vec<String> {
    let mut codes = discover_projects(&vault.root)
        .unwrap()
        .diagnostics
        .into_iter()
        .map(|entry| entry.code)
        .collect::<Vec<_>>();
    codes.sort();
    codes
}

#[test]
fn a_workshop_at_vault_root_is_found() {
    let vault = Vault::new();
    vault.write_workshop("", minimal_ws("root", "Root"));
    vault.write_workshop("Inner", minimal_ws("inner", "Inner"));
    let found = discover_projects(&vault.root).unwrap();
    assert_eq!(found.workshops.len(), 2);
    assert_eq!(found.workshops[0].path, "");
    assert_eq!(found.workshops[1].path, "Inner");
}

#[test]
fn legacy_project_file_is_detected_as_diagnostic() {
    let vault = Vault::new();
    let legacy_dir = vault.root.join("OldProject");
    fs::create_dir_all(&legacy_dir).unwrap();
    fs::write(
        legacy_dir.join("amby-project.json"),
        json!({"formatVersion": 2, "kind": "story", "projectId": "p1", "name": "Old"}).to_string(),
    )
    .unwrap();

    let found = discover_projects(&vault.root).unwrap();
    assert!(found.workshops.is_empty());
    assert_eq!(found.diagnostics.len(), 1);
    assert_eq!(found.diagnostics[0].code, "legacyProjectFormat");
}

#[test]
fn damaged_and_duplicate_workshop_files_are_reported() {
    let vault = Vault::new();
    vault.write_workshop("A", minimal_ws("dup", "Original"));
    vault.write_workshop("B copy", minimal_ws("dup", "Copy"));

    fs::create_dir_all(vault.root.join("Broken")).unwrap();
    fs::write(
        vault.root.join("Broken").join(WORKSHOP_FILE_NAME),
        b"{ not json",
    )
    .unwrap();

    vault.write_workshop(
        "BadId",
        json!({"formatVersion": 3, "workshopId": "a/b", "name": "x"}),
    );
    vault.write_workshop(
        "Future",
        json!({"formatVersion": 9, "workshopId": "f1", "name": "Future", "sections": []}),
    );

    let found = discover_projects(&vault.root).unwrap();
    assert_eq!(found.workshops.len(), 2); // "A", "Future" ("B copy" duplicate skipped)
    assert_eq!(
        codes(&vault),
        [
            "duplicateWorkshopId",
            "invalidWorkshopFile",
            "invalidWorkshopFile",
            "unsupportedFormatVersion",
        ]
    );

    // The future-version workshop is listed but marked read-only.
    let future = found
        .workshops
        .iter()
        .find(|ws| ws.doc.workshop_id == "f1")
        .unwrap();
    assert!(!future.doc.is_known_version());
}

#[test]
fn service_hidden_and_reserved_folders_are_not_scanned() {
    let vault = Vault::new();
    for folder in [
        ".hidden",
        ".amby/x",
        ".trash/y",
        "assets/z",
        ".git/w",
        "Pal/.ambd/records",
    ] {
        vault.write_workshop(folder, minimal_ws(&format!("id-{}", folder.len()), "Ghost"));
    }
    vault.write_workshop("Visible", minimal_ws("v", "Visible"));
    let found = discover_projects(&vault.root).unwrap();
    assert_eq!(found.workshops.len(), 1);
    assert!(found.diagnostics.is_empty());
}

#[test]
fn the_projection_reflects_created_workshops_and_resolves_sections_by_database_id() {
    let vault = Vault::new();
    assert!(!is_built(&vault.connection).unwrap());
    let ws = vault.create_ws("Saga");
    let story = vault.create_st(&ws.workshop_id, "Глава 1");
    vault.refresh();

    let catalog = load_catalog(&vault.connection, &vault.root, 7).unwrap();
    assert_eq!(catalog.vault_generation, 7);
    assert!(catalog.diagnostics.is_empty(), "{:?}", catalog.diagnostics);
    assert_eq!(catalog.workshops.len(), 1);

    let workshop_entry = &catalog.workshops[0];
    assert_eq!(workshop_entry.workshop_id, ws.workshop_id);
    assert_eq!(workshop_entry.path, "Saga");
    assert_eq!(workshop_entry.tags, ["Комикс"]);
    assert_eq!(workshop_entry.file_revision, ws.file_revision);
    assert!(!workshop_entry.read_only);
    assert_eq!(workshop_entry.sections.len(), 3);
    assert_eq!(workshop_entry.stories.len(), 1);

    let story_summary = &workshop_entry.stories[0];
    assert_eq!(story_summary.story_id, story.story_id);
    assert_eq!(story_summary.name, "Глава 1");
    assert_eq!(story_summary.card_path, "Saga/Истории/Глава 1/Глава 1.md");
    assert_eq!(
        story_summary
            .text
            .as_ref()
            .unwrap()
            .properties
            .level
            .as_ref()
            .unwrap()
            .len(),
        26
    ); // ULID
}

#[test]
fn a_moved_database_keeps_working_and_a_deleted_one_is_shown_missing() {
    let vault = Vault::new();
    let ws = vault.create_ws("Saga");
    let before = fs::read(vault.root.join("Saga").join(WORKSHOP_FILE_NAME)).unwrap();

    // Move characters, remove locations
    fs::create_dir_all(vault.root.join("Elsewhere")).unwrap();
    fs::rename(
        vault.root.join("Saga/Персонажи"),
        vault.root.join("Elsewhere/Персонажи"),
    )
    .unwrap();
    fs::remove_dir_all(vault.root.join("Saga/Локации")).unwrap();
    vault.refresh();

    let catalog = load_catalog(&vault.connection, &vault.root, 1).unwrap();
    let ws_summary = &catalog.workshops[0];
    let state = |role: &str| {
        ws_summary
            .sections
            .iter()
            .find(|section| section.role.as_str() == role)
            .unwrap()
    };

    assert_eq!(state("stories").state, SectionState::Ok);
    assert_eq!(state("characters").state, SectionState::Moved);
    assert_eq!(
        state("characters").resolved_path.as_deref(),
        Some("Elsewhere/Персонажи")
    );
    assert_eq!(state("locations").state, SectionState::Missing);
    assert_eq!(state("locations").resolved_path, None);
    assert_eq!(ws_summary.sections.len(), 3, "the missing entry is kept");

    // Workshop manifest file was not modified
    assert_eq!(
        fs::read(vault.root.join("Saga").join(WORKSHOP_FILE_NAME)).unwrap(),
        before
    );
    assert_eq!(ws.sections.len(), 3);
}

#[test]
fn the_catalog_is_built_on_first_read_of_a_fresh_index() {
    let vault = Vault::new();
    vault.write_workshop("Early", minimal_ws("early", "Early"));
    assert!(!is_built(&vault.connection).unwrap());
    let catalog = load_catalog(&vault.connection, &vault.root, 1).unwrap();
    assert_eq!(catalog.workshops.len(), 1);
    assert!(is_built(&vault.connection).unwrap());
}

#[test]
fn unsafe_and_duplicate_sections_are_skipped_with_a_diagnostic_and_left_in_the_file() {
    let vault = Vault::new();
    let mut value = minimal_ws("w1", "Tale");
    value["sections"] = json!([
        {"id": "ok", "role": "custom", "databaseId": "db_1", "path": "Notes"},
        {"id": "esc", "role": "custom", "databaseId": "db_2", "path": "../Outside"},
        {"id": "abs", "role": "custom", "databaseId": "db_3", "path": "/etc"},
        {"id": "ok", "role": "custom", "databaseId": "db_4", "path": "Dup"},
        {"id": "norole", "databaseId": "db_5"},
        {"id": "nodb", "role": "custom"},
        "text",
    ]);
    let bytes = vault.write_workshop("Tale", value);
    let found = discover_projects(&vault.root).unwrap();
    assert_eq!(found.workshops[0].doc.sections.len(), 1);
    assert_eq!(
        codes(&vault),
        [
            "duplicateSectionId",
            "invalidSection",
            "invalidSection",
            "invalidSection",
            "unsafeSectionPath",
            "unsafeSectionPath"
        ]
    );
    assert_eq!(
        fs::read(vault.root.join("Tale").join(WORKSHOP_FILE_NAME)).unwrap(),
        bytes,
        "discovery never rewrites the file"
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_structure_file_is_ignored_with_a_warning() {
    let vault = Vault::new();
    let real = vault.write_workshop("Real", minimal_ws("r", "Real"));
    assert!(!real.is_empty());
    fs::create_dir_all(vault.root.join("Linked")).unwrap();
    std::os::unix::fs::symlink(
        vault.root.join("Real").join(WORKSHOP_FILE_NAME),
        vault.root.join("Linked").join(WORKSHOP_FILE_NAME),
    )
    .unwrap();
    let found = discover_projects(&vault.root).unwrap();
    assert_eq!(found.workshops.len(), 1);
    assert_eq!(codes(&vault), ["symlinkIgnored"]);
}

#[test]
fn a_rebuild_follows_what_the_watcher_reports() {
    let vault = Vault::new();
    vault.create_ws("History");
    vault.refresh();
    assert_eq!(
        load_catalog(&vault.connection, &vault.root, 1)
            .unwrap()
            .workshops
            .len(),
        1
    );

    // An external copy of the folder appears: same ID, so a duplicate, not a second workshop.
    fs::create_dir_all(vault.root.join("History copy")).unwrap();
    fs::copy(
        vault.root.join("History").join(WORKSHOP_FILE_NAME),
        vault.root.join("History copy").join(WORKSHOP_FILE_NAME),
    )
    .unwrap();
    // A new workshop dropped in by another tool.
    vault.write_workshop("Dropped", minimal_ws("dropped", "Dropped"));
    rebuild_project_index(&vault.connection, &vault.root).unwrap();
    let catalog = load_catalog(&vault.connection, &vault.root, 1).unwrap();
    assert_eq!(catalog.workshops.len(), 2);
    assert_eq!(catalog.diagnostics.len(), 1);
    assert_eq!(catalog.diagnostics[0].code, "duplicateWorkshopId");

    // The folder is renamed: the workshop follows its ID, not the path. Others are deleted.
    fs::rename(vault.root.join("Dropped"), vault.root.join("Renamed")).unwrap();
    fs::remove_dir_all(vault.root.join("History copy")).unwrap();
    fs::remove_dir_all(vault.root.join("History")).unwrap();
    let epoch = load_catalog(&vault.connection, &vault.root, 1)
        .unwrap()
        .index_epoch;
    rebuild_project_index(&vault.connection, &vault.root).unwrap();
    let catalog = load_catalog(&vault.connection, &vault.root, 1).unwrap();
    assert_ne!(
        catalog.index_epoch, epoch,
        "a rebuild publishes a new epoch"
    );
    assert_eq!(catalog.workshops.len(), 1);
    assert_eq!(catalog.workshops[0].workshop_id, "dropped");
    assert_eq!(catalog.workshops[0].path, "Renamed");
    assert!(catalog.diagnostics.is_empty());
}

#[test]
fn damaged_story_folders_are_reported_and_do_not_hide_the_healthy_ones() {
    let vault = Vault::new();
    let ws = vault.create_ws("Saga");
    let good = vault.create_st(&ws.workshop_id, "Хорошая");
    let no_card = vault.create_st(&ws.workshop_id, "Без карточки");
    let broken = vault.create_st(&ws.workshop_id, "Битая");
    let no_config = vault.create_st(&ws.workshop_id, "Без настроек");

    fs::remove_file(vault.root.join(&no_card.card_path)).unwrap();
    fs::write(
        vault.root.join(&broken.folder_path).join("amby-story.json"),
        b"{ not json",
    )
    .unwrap();
    fs::remove_file(
        vault
            .root
            .join(&no_config.folder_path)
            .join("amby-story.json"),
    )
    .unwrap();

    let found = discover_projects(&vault.root).unwrap();
    let stories = &found.workshops[0].stories;
    assert_eq!(stories.len(), 1, "{stories:?}");
    assert_eq!(stories[0].story_id, good.story_id);
    assert_eq!(
        codes(&vault),
        [
            "brokenManifest",
            "storyMissingConfigFile",
            "storyMissingMainFile"
        ]
    );
}
