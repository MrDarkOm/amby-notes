use super::assets::{classify_ext, sanitize_stem};
use super::path_ops::file_name;
use super::scan::is_markdown;
use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Tree node used only by the scan-helper tests below.
#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct TreeItem {
    id: String,
    path: String,
    name: String,
    item_type: String,
    icon: String,
    children: Option<Vec<TreeItem>>,
}

#[cfg(test)]
fn is_bundle_dir(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let Some(name) = dir.file_name().map(|s| s.to_string_lossy().to_string()) else {
        return false;
    };
    dir.join(format!("{name}.md")).is_file()
}

#[cfg(test)]
fn bundle_main_note(dir: &Path) -> Result<PathBuf, String> {
    let name = file_name(dir)?;
    Ok(dir.join(format!("{name}.md")))
}

#[cfg(test)]
fn sort_entries(entries: &mut Vec<fs::DirEntry>) {
    entries.sort_by_key(|e| {
        let path = e.path();
        let is_file = path.is_file() as u8;
        let name = e.file_name().to_string_lossy().to_lowercase();
        (is_file, name)
    });
}

#[cfg(test)]
fn read_visible_entries(dir: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .collect();
    sort_entries(&mut entries);
    Ok(entries)
}

#[cfg(test)]
fn tree_item_for_note(path: &Path, children: Option<Vec<TreeItem>>) -> TreeItem {
    let name = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    TreeItem {
        id: path_string(path),
        path: path_string(path),
        name,
        item_type: "file".to_string(),
        icon: "file".to_string(),
        children,
    }
}

#[cfg(test)]
fn scan_bundle_children(bundle_dir: &Path) -> Result<Vec<TreeItem>, String> {
    let main_note = bundle_main_note(bundle_dir)?;
    let mut items = Vec::new();

    for entry in read_visible_entries(bundle_dir)? {
        let path = entry.path();
        let raw_name = entry.file_name().to_string_lossy().to_string();

        if path == main_note || raw_name == "assets" {
            continue;
        }

        if path.is_dir() {
            if is_bundle_dir(&path) {
                let main = bundle_main_note(&path)?;
                let children = scan_bundle_children(&path)?;
                items.push(tree_item_for_note(
                    &main,
                    if children.is_empty() {
                        None
                    } else {
                        Some(children)
                    },
                ));
            } else {
                let children = scan_dir(&path)?;
                if !children.is_empty() {
                    items.push(TreeItem {
                        id: path_string(&path),
                        path: path_string(&path),
                        name: raw_name,
                        item_type: "folder".to_string(),
                        icon: "folder".to_string(),
                        children: Some(children),
                    });
                }
            }
        } else if is_markdown(&path) && raw_name != "Metadata.md" {
            items.push(tree_item_for_note(&path, None));
        }
    }

    Ok(items)
}

#[cfg(test)]
fn scan_dir(dir: &Path) -> Result<Vec<TreeItem>, String> {
    let mut items = Vec::new();

    for entry in read_visible_entries(dir)? {
        let path = entry.path();
        let raw_name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
            if is_bundle_dir(&path) {
                let main = bundle_main_note(&path)?;
                let children = scan_bundle_children(&path)?;
                items.push(tree_item_for_note(
                    &main,
                    if children.is_empty() {
                        None
                    } else {
                        Some(children)
                    },
                ));
            } else {
                items.push(TreeItem {
                    id: path_string(&path),
                    path: path_string(&path),
                    name: raw_name,
                    item_type: "folder".to_string(),
                    icon: "folder".to_string(),
                    children: Some(scan_dir(&path)?),
                });
            }
        } else if is_markdown(&path) {
            items.push(tree_item_for_note(&path, None));
        } else if is_canvas_file(&path) {
            // Standalone canvas (bundle layer sidecars are hidden by scan_bundle_children).
            items.push(TreeItem {
                id: format!("canvas:{}", path_string(&path)),
                path: path_string(&path),
                name: file_stem(&path).unwrap_or_else(|_| raw_name.clone()),
                item_type: "canvas".to_string(),
                icon: "canvas".to_string(),
                children: None,
            });
        }
    }

    Ok(items)
}

fn is_canvas_file(path: &std::path::Path) -> bool {
    path.extension().is_some_and(|ext| ext == "canvas")
}

fn temp_vault(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("amby-{name}-{nanos}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn scan_hides_bundle_sidecars_and_exposes_child_notes() {
    let vault = temp_vault("scan");
    fs::write(vault.join("Loose.md"), "").unwrap();
    fs::create_dir(vault.join("Parent")).unwrap();
    fs::write(vault.join("Parent").join("Parent.md"), "").unwrap();
    fs::write(vault.join("Parent").join("Child.md"), "").unwrap();
    fs::write(vault.join("Parent").join("Parent.canvas"), "{}").unwrap();
    fs::write(vault.join("Parent").join("Metadata.md"), "").unwrap();
    fs::create_dir(vault.join("Parent").join("assets")).unwrap();
    fs::write(vault.join("Parent/assets/image.png"), "").unwrap();
    // Standalone canvas (not a note's layer sidecar) should surface in the tree.
    fs::write(vault.join("Board.canvas"), "{}").unwrap();

    let tree = scan_dir(&vault).unwrap();
    let parent = tree.iter().find(|item| item.name == "Parent").unwrap();
    assert_eq!(parent.item_type, "file");
    assert_eq!(
        parent.id,
        path_string(&vault.join("Parent").join("Parent.md"))
    );
    let children = parent.children.as_ref().unwrap();
    // Only Child.md is exposed; Parent.canvas (layer sidecar) stays hidden.
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].name, "Child");

    let board = tree.iter().find(|item| item.name == "Board").unwrap();
    assert_eq!(board.item_type, "canvas");
    assert_eq!(board.icon, "canvas");
}

#[test]
fn ensure_bundle_transforms_simple_note() {
    let vault = temp_vault("ensure");
    let note = vault.join("Doc.md");
    fs::write(&note, "hello").unwrap();

    let (main, changes) = ensure_bundle_path(&note).unwrap();

    assert!(!note.exists());
    assert_eq!(main, vault.join("Doc").join("Doc.md"));
    assert_eq!(fs::read_to_string(&main).unwrap(), "hello");
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].old_path, path_string(&note));
    assert_eq!(changes[0].new_path, path_string(&main));
}

#[test]
fn failed_child_creation_does_not_promote_the_parent_note() {
    let vault = temp_vault("child-conflict");
    let parent = vault.join("Untitled.md");
    fs::write(&parent, "parent").unwrap();

    let error = create_note_impl(&parent, "Untitled").err().unwrap();

    assert!(error.contains("same name"));
    assert_eq!(fs::read_to_string(&parent).unwrap(), "parent");
    assert!(!vault.join("Untitled").exists());
}

#[test]
fn standalone_note_cannot_duplicate_a_bundle_name() {
    let vault = temp_vault("bundle-name-conflict");
    fs::create_dir(vault.join("Parent")).unwrap();
    fs::write(vault.join("Parent").join("Parent.md"), "parent").unwrap();

    let error = create_note_impl(&vault, "Parent").err().unwrap();

    assert!(error.contains("already exists"));
    assert!(!vault.join("Parent.md").exists());
}

#[test]
fn invalid_layer_does_not_promote_a_note() {
    let vault = temp_vault("invalid-layer");
    let note = vault.join("Note.md");
    fs::write(&note, "note").unwrap();

    let error = create_layer_impl(&note, "unknown").err().unwrap();

    assert!(error.contains("Unknown layer kind"));
    assert!(note.exists());
    assert!(!vault.join("Note").exists());
}

#[test]
fn deleting_a_layer_keeps_a_vault_local_recoverable_copy() {
    let vault = temp_vault("delete-layer");
    let bundle = vault.join("Note");
    fs::create_dir(&bundle).unwrap();
    let note = bundle.join("Note.md");
    let layer = bundle.join("Note.canvas");
    fs::write(&note, "note").unwrap();
    fs::write(&layer, "canvas data").unwrap();

    delete_layer_impl(&vault, &note, "canvas").unwrap();

    assert!(!layer.exists());
    let entry = crate::recycle_bin::list(&vault).pop().unwrap();
    crate::recycle_bin::restore(&vault, &entry.id).unwrap();
    assert_eq!(fs::read_to_string(&layer).unwrap(), "canvas data");
}

#[test]
fn moving_note_onto_note_creates_target_bundle() {
    let vault = temp_vault("move");
    let source = vault.join("A.md");
    let target = vault.join("B.md");
    fs::write(&source, "a").unwrap();
    fs::write(&target, "b").unwrap();

    let result = move_item_impl(&source, &target).unwrap();

    assert!(vault.join("B").join("B.md").exists());
    assert!(vault.join("B").join("A.md").exists());
    assert!(result
        .path_changes
        .iter()
        .any(|change| change.old_path == path_string(&target)
            && change.new_path == path_string(&vault.join("B").join("B.md"))));
    assert!(result
        .path_changes
        .iter()
        .any(|change| change.old_path == path_string(&source)
            && change.new_path == path_string(&vault.join("B").join("A.md"))));
}

#[test]
fn failed_move_restores_a_promoted_target_note() {
    let vault = temp_vault("failed-move");
    let missing_source = vault.join("Missing.md");
    let target = vault.join("Target.md");
    fs::write(&target, "target").unwrap();

    let error = move_item_impl(&missing_source, &target).err().unwrap();

    assert!(error.contains("Source not found"));
    assert_eq!(fs::read_to_string(&target).unwrap(), "target");
    assert!(!vault.join("Target").exists());
}

#[test]
fn renaming_bundle_renames_container_main_note_and_sidecars() {
    let vault = temp_vault("rename");
    fs::create_dir(vault.join("Old")).unwrap();
    fs::write(vault.join("Old").join("Old.md"), "").unwrap();
    fs::write(vault.join("Old").join("Old.canvas"), "").unwrap();
    fs::write(vault.join("Old").join("Old.excalidraw"), "").unwrap();
    fs::write(vault.join("Old").join("Child.md"), "").unwrap();

    let result = rename_item_impl(&vault.join("Old").join("Old.md"), "New").unwrap();

    assert!(vault.join("New").join("New.md").exists());
    assert!(vault.join("New").join("New.canvas").exists());
    assert!(vault.join("New").join("New.excalidraw").exists());
    assert!(vault.join("New").join("Child.md").exists());
    assert!(!vault.join("Old").exists());
    assert_eq!(
        result.primary_path,
        Some(path_string(&vault.join("New").join("New.md")))
    );
    assert!(result.path_changes.iter().any(|change| change.old_path
        == path_string(&vault.join("Old").join("Child.md"))
        && change.new_path == path_string(&vault.join("New").join("Child.md"))));
    assert!(result.path_changes.iter().any(|change| change.old_path
        == path_string(&vault.join("Old").join("Old.canvas"))
        && change.new_path == path_string(&vault.join("New").join("New.canvas"))));
    assert!(result.path_changes.iter().any(|change| change.old_path
        == path_string(&vault.join("Old").join("Old.excalidraw"))
        && change.new_path == path_string(&vault.join("New").join("New.excalidraw"))));
}

#[test]
fn rename_rejects_distinct_file_and_folder_collisions() {
    let vault = temp_vault("rename-collisions");
    let first_file = vault.join("First.md");
    let second_file = vault.join("Second.md");
    fs::write(&first_file, "first").unwrap();
    fs::write(&second_file, "second").unwrap();
    let first_folder = vault.join("First");
    let second_folder = vault.join("Second");
    fs::create_dir(&first_folder).unwrap();
    fs::create_dir(&second_folder).unwrap();

    assert!(rename_item_impl(&first_file, "Second").is_err());
    assert!(rename_item_impl(&first_folder, "Second").is_err());
    assert_eq!(fs::read_to_string(&first_file).unwrap(), "first");
    assert_eq!(fs::read_to_string(&second_file).unwrap(), "second");
    assert!(first_folder.is_dir());
    assert!(second_folder.is_dir());
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn case_only_file_and_folder_renames_use_a_temporary_sibling() {
    let vault = temp_vault("case-only-items");
    let file = vault.join("Note.md");
    let folder = vault.join("Folder");
    fs::write(&file, "note").unwrap();
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("Child.md"), "child").unwrap();

    rename_item_impl(&file, "note").unwrap();
    rename_item_impl(&folder, "folder").unwrap();

    assert_eq!(fs::read_to_string(vault.join("note.md")).unwrap(), "note");
    assert_eq!(
        fs::read_to_string(vault.join("folder").join("Child.md")).unwrap(),
        "child"
    );
    let names = fs::read_dir(&vault)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    assert!(names.contains(&"note.md".to_string()));
    assert!(names.contains(&"folder".to_string()));
    assert!(!names.contains(&"Note.md".to_string()));
    assert!(!names.contains(&"Folder".to_string()));
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn case_only_bundle_rename_keeps_main_and_sidecars_consistent() {
    let vault = temp_vault("case-only-bundle");
    fs::create_dir(vault.join("Note")).unwrap();
    fs::write(vault.join("Note").join("Note.md"), "main").unwrap();
    fs::write(vault.join("Note").join("Note.canvas"), "canvas").unwrap();
    fs::write(vault.join("Note").join("Note.excalidraw"), "excalidraw").unwrap();

    let result = rename_item_impl(&vault.join("Note").join("Note.md"), "note").unwrap();

    assert_eq!(
        result.primary_path,
        Some(path_string(&vault.join("note").join("note.md")))
    );
    assert_eq!(
        fs::read_to_string(vault.join("note").join("note.md")).unwrap(),
        "main"
    );
    assert_eq!(
        fs::read_to_string(vault.join("note").join("note.canvas")).unwrap(),
        "canvas"
    );
    assert_eq!(
        fs::read_to_string(vault.join("note").join("note.excalidraw")).unwrap(),
        "excalidraw"
    );
}

#[test]
fn bundle_rename_conflict_is_rejected_before_any_file_moves() {
    let vault = temp_vault("rename-conflict");
    fs::create_dir(vault.join("Old")).unwrap();
    fs::write(vault.join("Old").join("Old.md"), "main").unwrap();
    fs::write(vault.join("Old").join("New.md"), "child").unwrap();

    let error = rename_item_impl(&vault.join("Old").join("Old.md"), "New")
        .err()
        .unwrap();

    assert!(error.contains("Target already exists"));
    assert_eq!(
        fs::read_to_string(vault.join("Old").join("Old.md")).unwrap(),
        "main"
    );
    assert_eq!(
        fs::read_to_string(vault.join("Old").join("New.md")).unwrap(),
        "child"
    );
    assert!(!vault.join("New").exists());
}

#[test]
fn rollback_bundle_rename_restores_every_bundle_file() {
    let vault = temp_vault("rollback-rename");
    fs::create_dir(vault.join("Old")).unwrap();
    fs::write(vault.join("Old").join("Old.md"), "main").unwrap();
    fs::write(vault.join("Old").join("Old.canvas"), "canvas").unwrap();
    fs::write(vault.join("Old").join("Child.md"), "child").unwrap();
    let original = vault.join("Old").join("Old.md");

    let result = rename_item_impl(&original, "New").unwrap();
    rollback_rename_item(&original, &result).unwrap();

    assert_eq!(
        fs::read_to_string(vault.join("Old").join("Old.md")).unwrap(),
        "main"
    );
    assert_eq!(
        fs::read_to_string(vault.join("Old").join("Old.canvas")).unwrap(),
        "canvas"
    );
    assert_eq!(
        fs::read_to_string(vault.join("Old").join("Child.md")).unwrap(),
        "child"
    );
    assert!(!vault.join("New").exists());
}

#[test]
fn rollback_move_restores_standalone_target_from_temporary_bundle() {
    let vault = temp_vault("rollback-move");
    let source = vault.join("A.md");
    let target = vault.join("B.md");
    fs::write(&source, "source").unwrap();
    fs::write(&target, "target").unwrap();

    let result = move_item_impl(&source, &target).unwrap();
    rollback_move_item(&source, &target, &result).unwrap();

    assert_eq!(fs::read_to_string(&source).unwrap(), "source");
    assert_eq!(fs::read_to_string(&target).unwrap(), "target");
    assert!(!vault.join("B").exists());
}

#[test]
fn rollback_move_restores_an_entire_super_note() {
    let vault = temp_vault("rollback-super-note-move");
    let bundle = vault.join("A");
    let target = vault.join("Target");
    fs::create_dir(&bundle).unwrap();
    fs::create_dir(&target).unwrap();
    let main = bundle.join("A.md");
    fs::write(&main, "main").unwrap();
    fs::write(bundle.join("A.canvas"), "canvas").unwrap();
    fs::write(bundle.join("Child.md"), "child").unwrap();

    let result = move_item_impl(&main, &target).unwrap();
    rollback_move_item(&main, &target, &result).unwrap();

    assert_eq!(fs::read_to_string(&main).unwrap(), "main");
    assert_eq!(
        fs::read_to_string(bundle.join("A.canvas")).unwrap(),
        "canvas"
    );
    assert_eq!(
        fs::read_to_string(bundle.join("Child.md")).unwrap(),
        "child"
    );
    assert!(!target.join("A").exists());
}

#[test]
fn rollback_super_note_move_restores_a_promoted_target_note() {
    let vault = temp_vault("rollback-super-note-to-note");
    let bundle = vault.join("A");
    fs::create_dir(&bundle).unwrap();
    let main = bundle.join("A.md");
    let target = vault.join("B.md");
    fs::write(&main, "main").unwrap();
    fs::write(bundle.join("A.canvas"), "canvas").unwrap();
    fs::write(&target, "target").unwrap();

    let result = move_item_impl(&main, &target).unwrap();
    rollback_move_item(&main, &target, &result).unwrap();

    assert_eq!(fs::read_to_string(&main).unwrap(), "main");
    assert_eq!(
        fs::read_to_string(bundle.join("A.canvas")).unwrap(),
        "canvas"
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), "target");
    assert!(!vault.join("B").exists());
}

#[test]
fn preview_move_matches_bundle_conversion_paths() {
    let vault = temp_vault("move-preview");
    let source = vault.join("A.md");
    let target = vault.join("B.md");
    fs::write(&source, "source").unwrap();
    fs::write(&target, "target").unwrap();

    let preview = preview_move_item(&source, &target).unwrap();

    assert!(preview
        .path_changes
        .iter()
        .any(|change| change.old_path == path_string(&source)
            && change.new_path == path_string(&vault.join("B").join("A.md"))));
    assert!(preview
        .path_changes
        .iter()
        .any(|change| change.old_path == path_string(&target)
            && change.new_path == path_string(&vault.join("B").join("B.md"))));
    assert!(source.exists());
    assert!(target.exists());
}

#[test]
fn test_sanitize_ext() {
    assert_eq!(sanitize_ext(".PNG"), "png");
    assert_eq!(sanitize_ext("jpeg"), "jpeg");
    assert_eq!(sanitize_ext("../evil"), "bin");
    assert_eq!(sanitize_ext("..\\evil"), "bin");
    assert_eq!(sanitize_ext("/bin/sh"), "bin");
    assert_eq!(sanitize_ext("verylongextensionexceedinglimit"), "bin");
    assert_eq!(sanitize_ext(""), "bin");
    assert_eq!(sanitize_ext("tar.gz"), "bin");
}

#[test]
fn test_sanitize_stem() {
    assert_eq!(sanitize_stem("My Note Asset"), "My-Note-Asset");
    assert_eq!(sanitize_stem("../../../etc/passwd"), "etc-passwd");
    assert_eq!(sanitize_stem("   ---   "), "asset");
    assert_eq!(sanitize_stem(""), "asset");
}

#[test]
fn test_svg_is_classified_as_file_attachment() {
    assert_eq!(classify_ext("svg"), "file");
    assert_eq!(classify_ext("png"), "image");
    assert_eq!(classify_ext("jpg"), "image");
    assert_eq!(classify_ext("pdf"), "file");
}

#[test]
fn test_sniff_image_format() {
    assert_eq!(
        sniff_image_format(b"\x89PNG\r\n\x1a\nExtraPayload"),
        Some("png")
    );
    assert_eq!(sniff_image_format(b"\xFF\xD8\xFF\xE0..."), Some("jpg"));
    assert_eq!(sniff_image_format(b"GIF89a..."), Some("gif"));
    assert_eq!(
        sniff_image_format(b"RIFF\x00\x00\x00\x00WEBPVP8..."),
        Some("webp")
    );
    assert_eq!(sniff_image_format(b"BM\x00\x00\x00\x00"), Some("bmp"));
    assert_eq!(sniff_image_format(b"<svg xmlns=..."), None);
    assert_eq!(sniff_image_format(b"plain text"), None);
}
