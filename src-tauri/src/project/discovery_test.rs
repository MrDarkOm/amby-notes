//! Discovery and the SQLite projection, including the sections-to-databases join
//! and the effect of filesystem changes the watcher reports.

use std::fs;
use std::path::PathBuf;

use rusqlite::Connection;
use serde_json::json;

use super::create::{create_project, Env};
use super::discovery::discover_projects;
use super::index::{is_built, load_catalog, rebuild_project_index};
use super::model::{
    CreateProjectRequest, CreatedProject, ProjectKind, SectionState, PROJECT_FILE_NAME,
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
            std::env::temp_dir().join(format!("amby-project-index-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&path).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        init_schema(&connection).unwrap();
        Self {
            root: path.canonicalize().unwrap(),
            watcher: WatcherState::new(),
            connection,
        }
    }

    fn write_project(&self, folder: &str, value: serde_json::Value) -> Vec<u8> {
        let directory = self.root.join(folder);
        fs::create_dir_all(&directory).unwrap();
        let bytes = serde_json::to_vec_pretty(&value).unwrap();
        fs::write(directory.join(PROJECT_FILE_NAME), &bytes).unwrap();
        bytes
    }

    fn create(&self, name: &str, kind: ProjectKind, parent: Option<&str>) -> CreatedProject {
        create_project(
            &Env {
                vault: &self.root,
                watcher: &self.watcher,
            },
            &CreateProjectRequest {
                expected_generation: 1,
                operation_id: format!("op-{}", ulid::Ulid::generate()),
                kind,
                name: name.to_owned(),
                parent_path: parent.map(str::to_owned),
                icon: None,
                tags: vec!["Комикс".to_owned()],
                base_sections: true,
                labels: Default::default(),
                text_levels: None,
            },
        )
        .unwrap()
    }

    /// What the app does after a change: refresh databases, then projects.
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

fn minimal(kind: &str, id: &str, name: &str) -> serde_json::Value {
    json!({"formatVersion": 2, "kind": kind, "projectId": id, "name": name})
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
fn membership_follows_folder_nesting() {
    let vault = Vault::new();
    vault.write_project("Palooverse", minimal("collection", "c1", "Palooverse"));
    vault.write_project("Palooverse/First", minimal("story", "s1", "First"));
    vault.write_project("Palooverse/Deep/Second", minimal("story", "s2", "Second"));
    vault.write_project("Loose", minimal("story", "s3", "Loose"));
    vault.write_project("Singles", minimal("collection", "c2", "Singles"));
    vault.write_project("Singles/Tale", minimal("story", "s4", "Tale"));

    let found = discover_projects(&vault.root).unwrap();
    assert!(found.diagnostics.is_empty(), "{:?}", found.diagnostics);
    let owner = |id: &str| {
        found
            .projects
            .iter()
            .find(|project| project.doc.project_id == id)
            .unwrap()
            .collection_id
            .clone()
    };
    assert_eq!(owner("s1").as_deref(), Some("c1"));
    assert_eq!(
        owner("s2").as_deref(),
        Some("c1"),
        "any depth below the collection"
    );
    assert_eq!(
        owner("s3"),
        None,
        "a story outside a collection stands alone"
    );
    assert_eq!(owner("s4").as_deref(), Some("c2"));
    assert_eq!(owner("c1"), None);
}

#[test]
fn a_project_at_the_vault_root_is_found() {
    let vault = Vault::new();
    vault.write_project("", minimal("story", "root", "Root"));
    vault.write_project("Inner", minimal("story", "inner", "Inner"));
    let found = discover_projects(&vault.root).unwrap();
    assert_eq!(found.projects.len(), 2);
    assert_eq!(found.projects[0].path, "");
}

#[test]
fn damaged_duplicate_and_unsupported_files_are_reported_not_trusted() {
    let vault = Vault::new();
    vault.write_project("Palooverse", minimal("collection", "c1", "Palooverse"));
    vault.write_project("Palooverse/Inner", minimal("collection", "c2", "Nested"));
    vault.write_project("A", minimal("story", "dup", "Original"));
    vault.write_project("B copy", minimal("story", "dup", "Copy"));
    vault.write_project("Palooverse/Tale", minimal("story", "t1", "Tale"));
    vault.write_project(
        "Palooverse/Tale/Chapter",
        minimal("story", "t2", "Inside story"),
    );
    fs::create_dir_all(vault.root.join("Broken")).unwrap();
    fs::write(
        vault.root.join("Broken").join(PROJECT_FILE_NAME),
        b"{ not json",
    )
    .unwrap();
    vault.write_project(
        "NoKind",
        json!({"formatVersion": 2, "projectId": "k", "name": "x"}),
    );
    vault.write_project(
        "BadId",
        json!({"formatVersion": 2, "kind": "story", "projectId": "a/b", "name": "x"}),
    );
    vault.write_project(
        "Future",
        json!({"formatVersion": 9, "kind": "story", "projectId": "f1", "name": "Future"}),
    );

    let found = discover_projects(&vault.root).unwrap();
    let mut ids = found
        .projects
        .iter()
        .map(|project| project.doc.project_id.as_str())
        .collect::<Vec<_>>();
    ids.sort_unstable();
    assert_eq!(ids, ["c1", "c2", "dup", "f1", "t1", "t2"]);
    assert_eq!(ids.iter().filter(|id| **id == "dup").count(), 1);
    let kept = found
        .projects
        .iter()
        .find(|project| project.doc.project_id == "dup")
        .unwrap();
    assert_eq!(
        kept.path, "A",
        "the first folder by path keeps a duplicated ID"
    );

    assert_eq!(
        codes(&vault),
        [
            "duplicateProjectId",
            "invalidProjectFile",
            "invalidProjectFile",
            "invalidProjectFile",
            "nestedCollection",
            "storyInsideStory",
            "unsupportedFormatVersion",
        ]
    );
    // The future-version project is listed but marked read-only.
    let future = found
        .projects
        .iter()
        .find(|project| project.doc.project_id == "f1")
        .unwrap();
    assert!(!future.doc.is_known_version());
    let nested = found
        .projects
        .iter()
        .find(|project| project.doc.project_id == "c2")
        .unwrap();
    assert_eq!(nested.collection_id, None);
}

#[test]
fn unsafe_and_duplicate_sections_are_skipped_with_a_diagnostic_and_left_in_the_file() {
    let vault = Vault::new();
    let mut value = minimal("story", "s1", "Tale");
    value["sections"] = json!([
        {"id": "ok", "databaseId": "db_1", "path": "Notes"},
        {"id": "esc", "databaseId": "db_2", "path": "../Outside"},
        {"id": "abs", "databaseId": "db_3", "path": "/etc"},
        {"id": "ok", "databaseId": "db_4", "path": "Dup"},
        {"id": "nodb"},
        "text",
    ]);
    let bytes = vault.write_project("Tale", value);
    let found = discover_projects(&vault.root).unwrap();
    let doc = &found.projects[0].doc;
    assert_eq!(doc.sections.len(), 1);
    assert_eq!(
        codes(&vault),
        [
            "duplicateSectionId",
            "invalidSection",
            "invalidSection",
            "unsafeSectionPath",
            "unsafeSectionPath"
        ]
    );
    assert_eq!(
        fs::read(vault.root.join("Tale").join(PROJECT_FILE_NAME)).unwrap(),
        bytes
    );
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
        vault.write_project(
            folder,
            minimal("story", &format!("id-{}", folder.len()), "Ghost"),
        );
    }
    vault.write_project("Visible", minimal("story", "v", "Visible"));
    let found = discover_projects(&vault.root).unwrap();
    assert_eq!(found.projects.len(), 1);
    assert!(found.diagnostics.is_empty());
}

#[cfg(unix)]
#[test]
fn a_symlinked_structure_file_is_ignored_with_a_warning() {
    let vault = Vault::new();
    let real = vault.write_project("Real", minimal("story", "r", "Real"));
    assert!(!real.is_empty());
    fs::create_dir_all(vault.root.join("Linked")).unwrap();
    std::os::unix::fs::symlink(
        vault.root.join("Real").join(PROJECT_FILE_NAME),
        vault.root.join("Linked").join(PROJECT_FILE_NAME),
    )
    .unwrap();
    let found = discover_projects(&vault.root).unwrap();
    assert_eq!(found.projects.len(), 1);
    assert_eq!(codes(&vault), ["symlinkIgnored"]);
}

#[test]
fn the_projection_reflects_created_projects_and_resolves_sections_by_database_id() {
    let vault = Vault::new();
    assert!(!is_built(&vault.connection).unwrap());
    let universe = vault.create("Palooverse", ProjectKind::Collection, None);
    let tale = vault.create("History", ProjectKind::Story, Some("Palooverse"));
    vault.refresh();

    let catalog = load_catalog(&vault.connection, &vault.root, 7).unwrap();
    assert_eq!(catalog.vault_generation, 7);
    assert!(catalog.diagnostics.is_empty());
    assert_eq!(catalog.projects.len(), 2);
    let story = catalog
        .projects
        .iter()
        .find(|project| project.project_id == tale.project_id)
        .unwrap();
    assert_eq!(
        story.collection_id.as_deref(),
        Some(universe.project_id.as_str())
    );
    assert_eq!(story.path, "Palooverse/History");
    assert_eq!(story.tags, ["Комикс"]);
    assert_eq!(story.file_revision, tale.file_revision);
    assert!(!story.read_only);
    assert_eq!(story.groups.len(), 2);
    assert_eq!(story.sections.len(), 4);
    for (section, created) in story.sections.iter().zip(&tale.sections) {
        assert_eq!(section.state, SectionState::Ok);
        assert_eq!(
            section.resolved_path.as_deref(),
            Some(created.container_path.as_str())
        );
        assert_eq!(
            section.database_name.as_deref(),
            Some(created.name.as_str())
        );
    }
}

#[test]
fn a_moved_database_keeps_working_and_a_deleted_one_is_shown_missing_without_touching_the_file() {
    let vault = Vault::new();
    let tale = vault.create("History", ProjectKind::Story, None);
    let before = fs::read(vault.root.join("History").join(PROJECT_FILE_NAME)).unwrap();

    // The author moves the Notes database to another folder, and removes Locations.
    fs::create_dir_all(vault.root.join("Elsewhere")).unwrap();
    fs::rename(
        vault.root.join("History/Заметки"),
        vault.root.join("Elsewhere/Заметки"),
    )
    .unwrap();
    fs::remove_dir_all(vault.root.join("History/Локации")).unwrap();
    vault.refresh();

    let catalog = load_catalog(&vault.connection, &vault.root, 1).unwrap();
    let story = &catalog.projects[0];
    let state = |role: &str| {
        story
            .sections
            .iter()
            .find(|section| section.role.as_deref() == Some(role))
            .unwrap()
    };
    assert_eq!(state("text").state, SectionState::Ok);
    assert_eq!(state("notes").state, SectionState::Moved);
    assert_eq!(
        state("notes").resolved_path.as_deref(),
        Some("Elsewhere/Заметки")
    );
    assert_eq!(state("locations").state, SectionState::Missing);
    assert_eq!(state("locations").resolved_path, None);
    assert_eq!(story.sections.len(), 4, "the missing entry is kept");
    assert_eq!(
        fs::read(vault.root.join("History").join(PROJECT_FILE_NAME)).unwrap(),
        before
    );
    assert_eq!(tale.sections.len(), 4);
}

#[test]
fn a_rebuild_follows_what_the_watcher_reports() {
    let vault = Vault::new();
    vault.create("History", ProjectKind::Story, None);
    vault.refresh();
    assert_eq!(
        load_catalog(&vault.connection, &vault.root, 1)
            .unwrap()
            .projects
            .len(),
        1
    );

    // An external copy of the folder appears: same ID, so it is a duplicate, not a second project.
    fs::create_dir_all(vault.root.join("History copy")).unwrap();
    fs::copy(
        vault.root.join("History").join(PROJECT_FILE_NAME),
        vault.root.join("History copy").join(PROJECT_FILE_NAME),
    )
    .unwrap();
    // A new project dropped in by another tool.
    vault.write_project("Dropped", minimal("story", "dropped", "Dropped"));
    rebuild_project_index(&vault.connection, &vault.root).unwrap();
    let catalog = load_catalog(&vault.connection, &vault.root, 1).unwrap();
    assert_eq!(catalog.projects.len(), 2);
    assert_eq!(catalog.diagnostics.len(), 1);
    assert_eq!(catalog.diagnostics[0].code, "duplicateProjectId");

    // The folder is renamed: the project follows its ID, not the path.
    fs::rename(vault.root.join("Dropped"), vault.root.join("Renamed")).unwrap();
    // Another is deleted.
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
    assert_eq!(catalog.projects.len(), 1);
    assert_eq!(catalog.projects[0].project_id, "dropped");
    assert_eq!(catalog.projects[0].path, "Renamed");
    assert!(catalog.diagnostics.is_empty());
}

#[test]
fn the_catalog_is_built_on_first_read_of_a_fresh_index() {
    let vault = Vault::new();
    vault.write_project("Early", minimal("story", "early", "Early"));
    assert!(!is_built(&vault.connection).unwrap());
    let catalog = load_catalog(&vault.connection, &vault.root, 1).unwrap();
    assert_eq!(catalog.projects.len(), 1);
    assert!(is_built(&vault.connection).unwrap());
}
