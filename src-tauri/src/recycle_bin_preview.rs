//! Read-only, bounded access to one archived payload. Never restores or indexes it.
use super::TrashEntry;
use crate::paths::confine_rel_no_symlinks;
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Component, Path};
use ulid::Ulid;

const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_CHILDREN: usize = 500;

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashPreviewItem {
    pub name: String,
    pub path: String,
    pub directory: bool,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashPreview {
    pub path: String,
    pub directory: bool,
    pub text: Option<String>,
    pub children: Vec<TrashPreviewItem>,
    pub truncated: bool,
}

pub fn read_preview(vault: &Path, id: &str, relative_path: &str) -> Result<TrashPreview, String> {
    id.parse::<Ulid>().map_err(|_| "Invalid trash identifier")?;
    let manifest = confine_rel_no_symlinks(vault, &format!(".amby/trash/{id}.json"))?;
    let mut manifest_bytes = Vec::new();
    fs::File::open(manifest)
        .map_err(|error| error.to_string())?
        .take(64 * 1024 + 1)
        .read_to_end(&mut manifest_bytes)
        .map_err(|error| error.to_string())?;
    if manifest_bytes.len() > 64 * 1024 {
        return Err("Trash manifest is too large".into());
    }
    let entry: TrashEntry =
        serde_json::from_slice(&manifest_bytes).map_err(|error| error.to_string())?;
    if entry.id != id
        || entry.name.is_empty()
        || entry.name.contains(['/', '\\'])
        || !matches!(
            Path::new(&entry.name).components().next(),
            Some(Component::Normal(_))
        )
    {
        return Err("Invalid trash manifest".into());
    }
    // Check the whole service path before using the payload itself as a scope. This also
    // rejects a linked manifest, container, or payload (including links inside the vault).
    let payload = confine_rel_no_symlinks(vault, &format!(".amby/trash/{id}/{}", entry.name))?;
    if relative_path.contains('\\') {
        return Err("Unsafe archive preview path".into());
    }
    let path = if relative_path.is_empty() {
        payload.clone()
    } else {
        confine_rel_no_symlinks(&payload, relative_path)?
    };
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    let mut preview = TrashPreview {
        path: relative_path.to_owned(),
        directory: metadata.is_dir(),
        text: None,
        children: Vec::new(),
        truncated: false,
    };
    if metadata.is_dir() {
        for (index, child) in fs::read_dir(&path)
            .map_err(|error| error.to_string())?
            .take(MAX_CHILDREN + 1)
            .enumerate()
        {
            if index == MAX_CHILDREN {
                preview.truncated = true;
                break;
            }
            let child = child.map_err(|error| error.to_string())?;
            let kind = child.file_type().map_err(|error| error.to_string())?;
            if kind.is_symlink() || !(kind.is_dir() || kind.is_file()) {
                continue;
            }
            if preview.children.len() == MAX_CHILDREN {
                preview.truncated = true;
                break;
            }
            let name = child.file_name().to_string_lossy().into_owned();
            let child_path = if relative_path.is_empty() {
                name.clone()
            } else {
                format!("{relative_path}/{name}")
            };
            preview.children.push(TrashPreviewItem {
                name,
                path: child_path,
                directory: kind.is_dir(),
            });
        }
        preview.children.sort_by(|a, b| {
            b.directory
                .cmp(&a.directory)
                .then_with(|| a.name.cmp(&b.name))
        });
    } else if metadata.is_file()
        && path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|ext| {
                [
                    "md",
                    "txt",
                    "json",
                    "canvas",
                    "excalidraw",
                    "csv",
                    "yaml",
                    "yml",
                ]
                .contains(&ext.to_ascii_lowercase().as_str())
            })
    {
        let mut bytes = Vec::new();
        fs::File::open(&path)
            .map_err(|error| error.to_string())?
            .take((MAX_TEXT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        preview.truncated = bytes.len() > MAX_TEXT_BYTES;
        bytes.truncate(MAX_TEXT_BYTES);
        let text = match std::str::from_utf8(&bytes) {
            Ok(text) => Some(text),
            Err(error) if preview.truncated && error.error_len().is_none() => {
                std::str::from_utf8(&bytes[..error.valid_up_to()]).ok()
            }
            Err(_) => None,
        };
        preview.text = text.filter(|text| !text.contains('\0')).map(str::to_owned);
    }
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recycle_bin::{list, move_to_trash};
    use crate::recycle_bin::{manifest_path, root};

    fn vault() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("amby-preview-{}", Ulid::generate()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn preview_keeps_bytes_and_manifest_and_does_not_restore_over_existing_note() {
        let vault = vault();
        let note = vault.join("Note.md");
        let bytes = b"\xef\xbb\xbf# Original\r\n";
        fs::write(&note, bytes).unwrap();
        move_to_trash(&vault, &note).unwrap();
        let entry = list(&vault).pop().unwrap();
        fs::write(&note, "new note").unwrap();
        let before = fs::read(manifest_path(&root(&vault), &entry.id)).unwrap();
        assert_eq!(
            read_preview(&vault, &entry.id, "")
                .unwrap()
                .text
                .unwrap()
                .as_bytes(),
            bytes
        );
        assert_eq!(fs::read(&note).unwrap(), b"new note");
        assert_eq!(
            fs::read(manifest_path(&root(&vault), &entry.id)).unwrap(),
            before
        );
        assert_eq!(
            fs::read(root(&vault).join(&entry.id).join("Note.md")).unwrap(),
            bytes
        );
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn browse_nested_bundle_and_reject_traversal_and_invalid_manifests() {
        let vault = vault();
        let folder = vault.join("Bundle");
        fs::create_dir_all(folder.join("Nested")).unwrap();
        fs::write(folder.join("Nested/Note.md"), "# Preview").unwrap();
        move_to_trash(&vault, &folder).unwrap();
        let entry = list(&vault).pop().unwrap();
        let preview = read_preview(&vault, &entry.id, "").unwrap();
        assert!(preview.directory);
        assert_eq!(preview.children[0].path, "Nested");
        assert_eq!(
            read_preview(&vault, &entry.id, "Nested/Note.md")
                .unwrap()
                .text
                .as_deref(),
            Some("# Preview")
        );
        for path in [
            "../other.md",
            "/etc/passwd",
            "Nested/../../other.md",
            "..\\other.md",
        ] {
            assert!(read_preview(&vault, &entry.id, path).is_err());
        }
        assert!(read_preview(&vault, "../bad", "").is_err());
        let mut invalid = entry.clone();
        invalid.name = "../other.md".into();
        fs::write(
            manifest_path(&root(&vault), &entry.id),
            serde_json::to_vec(&invalid).unwrap(),
        )
        .unwrap();
        assert!(read_preview(&vault, &entry.id, "").is_err());
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn caps_text_at_a_valid_utf8_boundary_and_does_not_decode_binary() {
        let vault = vault();
        let note = vault.join("Large.md");
        fs::write(&note, format!("x{}", "я".repeat(MAX_TEXT_BYTES))).unwrap();
        move_to_trash(&vault, &note).unwrap();
        let entry = list(&vault).pop().unwrap();
        let preview = read_preview(&vault, &entry.id, "").unwrap();
        assert!(preview.truncated);
        assert!(preview.text.unwrap().len() <= MAX_TEXT_BYTES);
        fs::write(root(&vault).join(&entry.id).join(&entry.name), [0xff, 0x00]).unwrap();
        assert!(read_preview(&vault, &entry.id, "").unwrap().text.is_none());
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn directory_preview_is_bounded_without_removing_any_children() {
        let vault = vault();
        let folder = vault.join("Folder");
        fs::create_dir(&folder).unwrap();
        for index in 0..=MAX_CHILDREN {
            fs::write(folder.join(format!("{index}.txt")), "kept").unwrap();
        }
        move_to_trash(&vault, &folder).unwrap();
        let entry = list(&vault).pop().unwrap();
        let preview = read_preview(&vault, &entry.id, "").unwrap();
        assert!(preview.truncated);
        assert_eq!(preview.children.len(), MAX_CHILDREN);
        assert_eq!(
            fs::read_dir(root(&vault).join(&entry.id).join("Folder"))
                .unwrap()
                .count(),
            MAX_CHILDREN + 1
        );
        fs::remove_dir_all(vault).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_payloads_and_manifest_and_skips_linked_children() {
        use std::os::unix::fs::symlink;
        let vault = vault();
        let folder = vault.join("Folder");
        fs::create_dir_all(&folder).unwrap();
        let outside = vault.join("Private.md");
        fs::write(&outside, "private").unwrap();
        symlink(&outside, folder.join("Link.md")).unwrap();
        super::super::move_exact_to_trash(&vault, &folder).unwrap();
        let entry = list(&vault).pop().unwrap();
        assert!(read_preview(&vault, &entry.id, "")
            .unwrap()
            .children
            .is_empty());
        assert!(read_preview(&vault, &entry.id, "Link.md").is_err());
        let payload = root(&vault).join(&entry.id).join(&entry.name);
        fs::remove_file(payload.join("Link.md")).unwrap();
        fs::remove_dir(&payload).unwrap();
        symlink(&outside, &payload).unwrap();
        assert!(read_preview(&vault, &entry.id, "").is_err());
        fs::remove_file(&payload).unwrap();
        fs::create_dir(&payload).unwrap();
        let manifest = manifest_path(&root(&vault), &entry.id);
        fs::remove_file(&manifest).unwrap();
        symlink(&outside, &manifest).unwrap();
        assert!(read_preview(&vault, &entry.id, "").is_err());
        fs::remove_dir_all(vault).unwrap();
    }
}
