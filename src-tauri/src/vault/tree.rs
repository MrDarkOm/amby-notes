use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use super::scan::*;
use crate::index::IndexedNote;

#[derive(Serialize, Clone, Debug, PartialEq, Eq, specta::Type)]
pub struct TreeItem {
    pub id: String,
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeItem>>,
}

pub fn filesystem_timestamps(path: &Path) -> (Option<u64>, Option<u64>) {
    let Ok(metadata) = fs::metadata(path) else {
        return (None, None);
    };
    let to_unix_seconds = |time: std::io::Result<std::time::SystemTime>| {
        time.ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs())
    };
    (
        to_unix_seconds(metadata.created()),
        to_unix_seconds(metadata.modified()),
    )
}

fn note_map(notes: &[IndexedNote], vault: &Path) -> HashMap<String, IndexedNote> {
    notes
        .iter()
        .filter_map(|note| {
            let rel = Path::new(&note.path).strip_prefix(vault).ok()?;
            Some((normalize_rel_path(rel), note.clone()))
        })
        .collect()
}

fn read_visible_entries(dir: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            !name.starts_with('.') && name != "assets"
        })
        .collect();
    entries.sort_by_key(|e| {
        let path = e.path();
        let is_file = path.is_file() as u8;
        let name = e.file_name().to_string_lossy().to_lowercase();
        (is_file, name)
    });
    Ok(entries)
}

fn tree_item_for_note(path: &Path, note: &IndexedNote, children: Vec<TreeItem>) -> TreeItem {
    let (created, filesystem_modified) = filesystem_timestamps(path);
    TreeItem {
        id: note.id.clone(),
        path: path_string(path),
        name: file_stem(path),
        item_type: "file".to_string(),
        icon: "file".to_string(),
        created,
        modified: note.modified.or(filesystem_modified),
        children: if children.is_empty() {
            None
        } else {
            Some(children)
        },
    }
}

pub fn is_standalone_database_dir(path: &Path) -> bool {
    if !is_database_dir(path) {
        return false;
    }
    let manifest_path = crate::database::discovery::manifest_path_for_container(path);
    if let Ok(bytes) = fs::read(&manifest_path) {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if value.get("format").and_then(|v| v.as_str()) == Some("amby-database")
                || value.get("databaseId").is_some()
            {
                return true;
            }
            if let Some(kind) = value
                .get("containerKind")
                .or_else(|| value.get("kind"))
                .and_then(|v| v.as_str())
            {
                return kind == "standalone";
            }
        }
    }
    let legacy_manifest = path.join("ambd.json");
    if legacy_manifest.is_file() {
        if let Ok(bytes) = fs::read(&legacy_manifest) {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if value.get("format").and_then(|v| v.as_str()) == Some("amby-database")
                    || value.get("databaseId").is_some()
                {
                    return true;
                }
                if let Some(kind) = value
                    .get("containerKind")
                    .or_else(|| value.get("kind"))
                    .and_then(|v| v.as_str())
                {
                    return kind == "standalone";
                }
            }
        }
    }
    true
}

fn scan_tree_dir(
    vault: &Path,
    dir: &Path,
    notes: &HashMap<String, IndexedNote>,
    in_bundle: bool,
) -> Result<Vec<TreeItem>, String> {
    let mut items = Vec::new();
    for entry in read_visible_entries(dir)? {
        let path = entry.path();
        let raw_name = entry.file_name().to_string_lossy().to_string();
        if in_bundle
            && (file_stem(&path) == file_name(dir)
                || raw_name == "Metadata.md"
                || raw_name == "ambd.json"
                || raw_name == ".ambd")
        {
            continue;
        }
        if path.is_dir() {
            if is_standalone_database_dir(&path) {
                let manifest_path = crate::database::discovery::manifest_path_for_container(&path);
                let (database_id, database_name, database_icon) =
                    if let Ok(bytes) = fs::read(&manifest_path) {
                        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                            let id = value
                                .get("databaseId")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| format!("database:{}", path_string(&path)));
                            let name = value
                                .get("name")
                                .and_then(|v| v.as_str())
                                .filter(|s| !s.trim().is_empty())
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| file_name(&path));
                            let icon = value
                                .get("icon")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            (id, name, icon)
                        } else {
                            (
                                format!("database:{}", path_string(&path)),
                                file_name(&path),
                                None,
                            )
                        }
                    } else {
                        (
                            format!("database:{}", path_string(&path)),
                            file_name(&path),
                            None,
                        )
                    };
                let children = scan_tree_dir(vault, &path, notes, true)?;
                let (created, modified) = filesystem_timestamps(&manifest_path);
                let (folder_created, folder_modified) = filesystem_timestamps(&path);
                let stem = file_name(&path);
                let has_layers = path.join(format!("{stem}.md")).is_file()
                    || path.join(format!("{stem}.canvas")).is_file()
                    || path.join(format!("{stem}.excalidraw")).is_file();
                items.push(TreeItem {
                    id: database_id,
                    path: path_string(&path),
                    name: database_name,
                    item_type: "database".to_string(),
                    icon: database_icon.unwrap_or_else(|| {
                        if has_layers {
                            "superdatabase".to_string()
                        } else {
                            "database".to_string()
                        }
                    }),
                    created: created.or(folder_created),
                    modified: modified.or(folder_modified),
                    children: if children.is_empty() {
                        None
                    } else {
                        Some(children)
                    },
                });
            } else if is_bundle_dir(&path) {
                let name = file_name(&path);
                let main_md = path.join(format!("{name}.md"));
                let main_canvas = path.join(format!("{name}.canvas"));
                let main_sketch = path.join(format!("{name}.excalidraw"));

                if main_md.is_file() {
                    let rel = main_md
                        .strip_prefix(vault)
                        .map(normalize_rel_path)
                        .map_err(|e| e.to_string())?;
                    if let Some(note) = notes.get(&rel) {
                        let children = scan_tree_dir(vault, &path, notes, true)?;
                        items.push(tree_item_for_note(&main_md, note, children));
                    }
                } else if main_canvas.is_file() {
                    let children = scan_tree_dir(vault, &path, notes, true)?;
                    let (created, modified) = filesystem_timestamps(&main_canvas);
                    items.push(TreeItem {
                        id: format!("canvas:{}", path_string(&main_canvas)),
                        path: path_string(&main_canvas),
                        name: file_stem(&main_canvas),
                        item_type: "canvas".to_string(),
                        icon: "supercanvas".to_string(),
                        created,
                        modified,
                        children: if children.is_empty() {
                            None
                        } else {
                            Some(children)
                        },
                    });
                } else if main_sketch.is_file() {
                    let children = scan_tree_dir(vault, &path, notes, true)?;
                    let (created, modified) = filesystem_timestamps(&main_sketch);
                    items.push(TreeItem {
                        id: format!("sketch:{}", path_string(&main_sketch)),
                        path: path_string(&main_sketch),
                        name: file_stem(&main_sketch),
                        item_type: "sketch".to_string(),
                        icon: "supersketch".to_string(),
                        created,
                        modified,
                        children: if children.is_empty() {
                            None
                        } else {
                            Some(children)
                        },
                    });
                }
            } else if is_database_dir(&path) {
                let manifest_path = crate::database::discovery::manifest_path_for_container(&path);
                let (database_id, database_name, database_icon) =
                    if let Ok(bytes) = fs::read(&manifest_path) {
                        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                            let id = value
                                .get("databaseId")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| format!("database:{}", path_string(&path)));
                            let name = value
                                .get("name")
                                .and_then(|v| v.as_str())
                                .filter(|s| !s.trim().is_empty())
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| file_name(&path));
                            let icon = value
                                .get("icon")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            (id, name, icon)
                        } else {
                            (
                                format!("database:{}", path_string(&path)),
                                file_name(&path),
                                None,
                            )
                        }
                    } else {
                        (
                            format!("database:{}", path_string(&path)),
                            file_name(&path),
                            None,
                        )
                    };
                let children = scan_tree_dir(vault, &path, notes, true)?;
                let (created, modified) = filesystem_timestamps(&manifest_path);
                let (folder_created, folder_modified) = filesystem_timestamps(&path);
                items.push(TreeItem {
                    id: database_id,
                    path: path_string(&path),
                    name: database_name,
                    item_type: "database".to_string(),
                    icon: database_icon.unwrap_or_else(|| "database".to_string()),
                    created: created.or(folder_created),
                    modified: modified.or(folder_modified),
                    children: if children.is_empty() {
                        None
                    } else {
                        Some(children)
                    },
                });
            } else {
                let children = scan_tree_dir(vault, &path, notes, false)?;
                let (created, modified) = filesystem_timestamps(&path);
                items.push(TreeItem {
                    id: format!("folder:{}", path_string(&path)),
                    path: path_string(&path),
                    name: raw_name,
                    item_type: "folder".to_string(),
                    icon: "folder".to_string(),
                    created,
                    modified,
                    children: Some(children),
                });
            }
        } else if is_markdown(&path) {
            let rel = path
                .strip_prefix(vault)
                .map(normalize_rel_path)
                .map_err(|e| e.to_string())?;
            if let Some(note) = notes.get(&rel) {
                items.push(tree_item_for_note(&path, note, Vec::new()));
            }
        } else if is_canvas(&path) {
            let is_layer_sidecar = in_bundle && file_stem(&path) == file_name(dir);
            if !is_layer_sidecar {
                let (created, modified) = filesystem_timestamps(&path);
                items.push(TreeItem {
                    id: format!("canvas:{}", path_string(&path)),
                    path: path_string(&path),
                    name: file_stem(&path),
                    item_type: "canvas".to_string(),
                    icon: "canvas".to_string(),
                    created,
                    modified,
                    children: None,
                });
            }
        } else if is_sketch(&path) {
            let is_layer_sidecar = in_bundle && file_stem(&path) == file_name(dir);
            if !is_layer_sidecar {
                let (created, modified) = filesystem_timestamps(&path);
                items.push(TreeItem {
                    id: format!("sketch:{}", path_string(&path)),
                    path: path_string(&path),
                    name: file_stem(&path),
                    item_type: "sketch".to_string(),
                    icon: "sketch".to_string(),
                    created,
                    modified,
                    children: None,
                });
            }
        }
    }
    Ok(items)
}

pub fn build_tree(vault: &Path, notes: &[IndexedNote]) -> Result<Vec<TreeItem>, String> {
    scan_tree_dir(vault, vault, &note_map(notes, vault), false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_vault(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("amby-tree-{name}-{nanos}"));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn test_scan_standalone_database() {
        let vault = temp_vault("db-test");

        // 1. Create a standalone database directory with ambd.json
        let db_dir = vault.join("Projects");
        fs::create_dir_all(&db_dir).unwrap();
        let manifest = serde_json::json!({
            "format": "amby-database-manifest",
            "formatVersion": 1,
            "databaseId": "01JTESTDATABASEID00000000001",
            "name": "Projects",
            "icon": "database",
            "created": 1700000000,
            "modified": 1700000000,
            "properties": [],
            "views": []
        });
        fs::write(
            db_dir.join("ambd.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        // 2. Add a child note inside the database directory
        let note_path = db_dir.join("Task 1.md");
        fs::write(
            &note_path,
            "---\namby-id: 01JNOTEID00000000000000001\n---\nTask content",
        )
        .unwrap();

        let notes = vec![IndexedNote {
            id: "01JNOTEID00000000000000001".to_string(),
            path: path_string(&note_path),
            title: "Task 1".to_string(),
            modified: Some(1700000000),
            word_count: 2,
        }];

        let tree = build_tree(&vault, &notes).unwrap();
        assert_eq!(tree.len(), 1);
        let db_item = &tree[0];
        assert_eq!(db_item.id, "01JTESTDATABASEID00000000001");
        assert_eq!(db_item.name, "Projects");
        assert_eq!(db_item.item_type, "database");
        assert_eq!(db_item.icon, "database");

        let children = db_item
            .children
            .as_ref()
            .expect("database should have children");
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].id, "01JNOTEID00000000000000001");
        assert_eq!(children[0].name, "Task 1");
        assert_eq!(children[0].item_type, "file");

        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn test_scan_standalone_database_with_named_json() {
        let vault = temp_vault("db-named-json-test");

        // 1. Create a standalone database directory with Projects.json
        let db_dir = vault.join("Projects");
        fs::create_dir_all(&db_dir).unwrap();
        let manifest = serde_json::json!({
            "format": "amby-database",
            "formatVersion": 1,
            "databaseId": "01JTESTDATABASEID00000000002",
            "name": "Projects",
            "icon": "folder-kanban",
            "created": 1700000000,
            "modified": 1700000000,
            "properties": [],
            "views": []
        });
        fs::write(
            db_dir.join("Projects.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        // 2. Add child notes
        let note_path = db_dir.join("Row Note.md");
        fs::write(
            &note_path,
            "---\namby-id: 01JNOTEID00000000000000002\n---\nRow content",
        )
        .unwrap();

        let notes = vec![IndexedNote {
            id: "01JNOTEID00000000000000002".to_string(),
            path: path_string(&note_path),
            title: "Row Note".to_string(),
            modified: Some(1700000000),
            word_count: 2,
        }];

        let tree = build_tree(&vault, &notes).unwrap();
        assert_eq!(tree.len(), 1);
        let db_item = &tree[0];
        assert_eq!(db_item.id, "01JTESTDATABASEID00000000002");
        assert_eq!(db_item.name, "Projects");
        assert_eq!(db_item.item_type, "database");
        assert_eq!(db_item.icon, "folder-kanban");

        // Children should only contain the row note, Projects.json must be excluded
        let children = db_item
            .children
            .as_ref()
            .expect("database should have children");
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].id, "01JNOTEID00000000000000002");
        assert_eq!(children[0].name, "Row Note");

        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn test_scan_standalone_database_with_attached_note_layer() {
        let vault = temp_vault("db-attached-layer-test");

        let db_dir = vault.join("Tasks");
        fs::create_dir_all(&db_dir).unwrap();
        let manifest = serde_json::json!({
            "format": "amby-database",
            "formatVersion": 1,
            "containerKind": "standalone",
            "databaseId": "01JTESTDATABASEID00000000003",
            "name": "Tasks",
            "icon": null,
            "properties": [],
            "views": []
        });
        fs::write(
            db_dir.join("Tasks.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        // Attach a note layer: Tasks.md
        let note_path = db_dir.join("Tasks.md");
        fs::write(
            &note_path,
            "---\namby-id: 01JNOTEID00000000000000003\n---\nTasks body",
        )
        .unwrap();

        let notes = vec![IndexedNote {
            id: "01JNOTEID00000000000000003".to_string(),
            path: path_string(&note_path),
            title: "Tasks".to_string(),
            modified: Some(1700000000),
            word_count: 2,
        }];

        let tree = build_tree(&vault, &notes).unwrap();
        assert_eq!(tree.len(), 1);
        let db_item = &tree[0];
        assert_eq!(db_item.id, "01JTESTDATABASEID00000000003");
        assert_eq!(db_item.name, "Tasks");
        assert_eq!(db_item.item_type, "database");
        assert_eq!(db_item.icon, "superdatabase");
        // Tasks.md is a layer of Tasks, so children should be None (empty)
        assert!(db_item.children.is_none());

        let _ = fs::remove_dir_all(&vault);
    }
}
