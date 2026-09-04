//! Database-specific watcher classification.
//!
//! This layer only classifies paths and coalesces invalidations. It never
//! parses a shard while the module is disabled and it never treats an external
//! filesystem event as permission to mutate durable files.

use std::collections::BTreeSet;
use std::path::Path;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseChangeKind {
    Manifest,
    Record,
    View,
    Template,
    Note,
    Container,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseChangedPayload {
    pub kind: DatabaseChangeKind,
    /// Vault-relative, slash-normalized changed path.
    pub path: String,
    /// Vault-relative container path when the changed path is database-related.
    pub container_path: String,
    pub generation: u64,
    pub requires_full_rebuild: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CoalescedChanges {
    pub containers: BTreeSet<String>,
    pub changed_paths: BTreeSet<String>,
    pub requires_full_rebuild: bool,
}

/// Classify a path using only its path shape. A later projection pass must
/// re-check the actual manifest and fingerprints before publishing anything.
pub fn classify_path(vault: &Path, path: &Path, generation: u64) -> Option<DatabaseChangedPayload> {
    let relative = path.strip_prefix(vault).ok()?;
    let components = relative
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>();
    if components.iter().any(|component| {
        matches!(
            *component,
            ".amby" | ".obsidian" | ".git" | ".trash" | "assets"
        )
    }) {
        return None;
    }
    let normalized = components.join("/");
    let manifest_index = components
        .iter()
        .position(|component| *component == "ambd.json");
    let ambd_index = components
        .iter()
        .position(|component| *component == ".ambd");
    let (kind, container_path, requires_full_rebuild) = if let Some(manifest_index) = manifest_index
    {
        (
            DatabaseChangeKind::Manifest,
            parent_path(&components[..manifest_index]),
            true,
        )
    } else if let Some(index) = ambd_index {
        let container = components.get(..index)?;
        let Some(scope) = components.get(index + 1) else {
            return Some(DatabaseChangedPayload {
                kind: DatabaseChangeKind::Container,
                path: normalized,
                container_path: parent_path(container),
                generation,
                requires_full_rebuild: true,
            });
        };
        let kind = match *scope {
            "records" => DatabaseChangeKind::Record,
            "views" => DatabaseChangeKind::View,
            "templates" => DatabaseChangeKind::Template,
            "assets" => return None,
            _ => DatabaseChangeKind::Container,
        };
        (
            kind,
            parent_path(container),
            matches!(kind, DatabaseChangeKind::Container),
        )
    } else if path.extension().and_then(|extension| extension.to_str()) == Some("md") {
        let parent = path.parent()?;
        let relative_parent = parent.strip_prefix(vault).ok()?;
        (
            DatabaseChangeKind::Note,
            relative_parent.to_string_lossy().replace('\\', "/"),
            true,
        )
    } else {
        return None;
    };
    Some(DatabaseChangedPayload {
        kind,
        path: normalized,
        container_path,
        generation,
        requires_full_rebuild,
    })
}

pub fn coalesce(changes: impl IntoIterator<Item = DatabaseChangedPayload>) -> CoalescedChanges {
    let mut result = CoalescedChanges::default();
    for change in changes {
        result.containers.insert(change.container_path);
        result.changed_paths.insert(change.path);
        result.requires_full_rebuild |= change.requires_full_rebuild;
    }
    result
}

fn parent_path(components: &[&str]) -> String {
    components.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn vault() -> PathBuf {
        PathBuf::from("/vault")
    }

    #[test]
    fn classifies_manifest_shards_and_notes_without_exposing_absolute_paths() {
        let vault = vault();
        let cases = [
            (
                "Characters/ambd.json",
                DatabaseChangeKind::Manifest,
                "Characters",
            ),
            (
                "Characters/.ambd/records/01.json",
                DatabaseChangeKind::Record,
                "Characters",
            ),
            (
                "Characters/.ambd/views/01.json",
                DatabaseChangeKind::View,
                "Characters",
            ),
            (
                "Characters/.ambd/templates/01.json",
                DatabaseChangeKind::Template,
                "Characters",
            ),
            (
                "Characters/Alice.md",
                DatabaseChangeKind::Note,
                "Characters",
            ),
        ];
        for (path, kind, container) in cases {
            let change = classify_path(&vault, &vault.join(path), 7).unwrap();
            assert_eq!(change.kind, kind);
            assert_eq!(change.path, path);
            assert_eq!(change.container_path, container);
            assert_eq!(change.generation, 7);
            assert!(!change.path.starts_with('/'));
        }
    }

    #[test]
    fn ignores_non_database_service_paths_and_database_assets() {
        let vault = vault();
        for path in [
            "assets/image.png",
            ".amby/notes.db",
            "Characters/.ambd/assets/image.png",
            ".obsidian/workspace.json",
        ] {
            assert!(
                classify_path(&vault, &vault.join(path), 1).is_none(),
                "{path}"
            );
        }
    }

    #[test]
    fn coalesces_container_changes_and_retains_full_rebuild_requirement() {
        let vault = vault();
        let changes = [
            classify_path(&vault, &vault.join("Database/.ambd/records/a.json"), 1).unwrap(),
            classify_path(&vault, &vault.join("Database/ambd.json"), 1).unwrap(),
        ];
        let result = coalesce(changes);
        assert_eq!(
            result.containers.into_iter().collect::<Vec<_>>(),
            ["Database"]
        );
        assert_eq!(result.changed_paths.len(), 2);
        assert!(result.requires_full_rebuild);
    }

    #[test]
    fn a_container_directory_event_invalidates_the_whole_container() {
        let vault = vault();
        let change = classify_path(&vault, &vault.join("Database/.ambd"), 2).unwrap();
        assert_eq!(change.kind, DatabaseChangeKind::Container);
        assert!(change.requires_full_rebuild);
        assert_eq!(change.container_path, "Database");
    }
}
