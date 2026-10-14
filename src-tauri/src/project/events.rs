//! Watcher classification for workshop discovery. Path shape only: a later
//! `refresh_projects` re-reads the files and publishes the truth.

use std::path::Path;

use super::model::{
    ProjectChangedPayload, LEGACY_PROJECT_FILE_NAME, STORY_FILE_NAME, WORKSHOP_FILE_NAME,
};

/// A path can change which workshops exist when it is a structure file, or a
/// folder that was created, removed or renamed (a whole workshop or story may have moved
/// with it, and then the event never names the file inside).
pub fn classify_path(
    vault: &Path,
    path: &Path,
    kind: &str,
    generation: u64,
) -> Option<ProjectChangedPayload> {
    let relative = path.strip_prefix(vault).ok()?;
    let components = relative
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>();
    if components.is_empty()
        || components.iter().any(|component| {
            component.starts_with('.') || crate::vault::scan::is_service_directory(component)
        })
    {
        return None;
    }
    let name = *components.last()?;
    let kind = if name == WORKSHOP_FILE_NAME
        || name == STORY_FILE_NAME
        || name == LEGACY_PROJECT_FILE_NAME
    {
        "file"
    } else if matches!(kind, "create" | "remove" | "rename") && !name.contains('.') {
        "folder"
    } else {
        return None;
    };
    Some(ProjectChangedPayload {
        kind,
        path: components.join("/"),
        generation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn classifies_structure_files_and_folder_events_only() {
        let vault = PathBuf::from("/vault");
        let file =
            classify_path(&vault, &vault.join("Pal/amby-workshop.json"), "modify", 3).unwrap();
        assert_eq!(
            (file.kind, file.path.as_str(), file.generation),
            ("file", "Pal/amby-workshop.json", 3)
        );
        let story_file = classify_path(
            &vault,
            &vault.join("Pal/Истории/Tale/amby-story.json"),
            "modify",
            3,
        )
        .unwrap();
        assert_eq!(story_file.kind, "file");
        let legacy_file =
            classify_path(&vault, &vault.join("Old/amby-project.json"), "modify", 3).unwrap();
        assert_eq!(legacy_file.kind, "file");
        let folder = classify_path(&vault, &vault.join("Pal"), "rename", 3).unwrap();
        assert_eq!(folder.kind, "folder");
        for (path, kind) in [
            ("Pal/note.md", "modify"),
            ("Pal/folder", "modify"),
            ("Pal/.amby/config.json", "modify"),
        ] {
            assert!(
                classify_path(&vault, &vault.join(path), kind, 3).is_none(),
                "{path} should be ignored"
            );
        }
    }
}
