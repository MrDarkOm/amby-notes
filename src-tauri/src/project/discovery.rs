//! Read-only discovery of creative workshops by `amby-workshop.json` and stories
//! inside the stories section.
//!
//! Workshops are flat peer environments. Discovery never writes and never trusts a damaged
//! file; it reports a diagnostic and leaves the data alone. Legacy v2 projects are reported
//! with `legacyProjectFormat` and never modified.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use walkdir::{DirEntry, WalkDir};

use super::format::{parse_story_file, parse_workshop_file, WorkshopDoc};
use super::model::{
    ProjectDiagnostic, LEGACY_PROJECT_FILE_NAME, ROLE_STORIES, STORY_FILE_NAME, WORKSHOP_FILE_NAME,
};
use crate::database::format::parse_manifest;
use crate::frontmatter::parse_markdown;

#[derive(Clone, Debug)]
pub struct DiscoveredStory {
    pub story_id: String,
    pub name: String,
    pub folder_path: String,
    pub card_path: String,
    pub card_note_id: Option<String>,
    pub database_id: Option<String>,
    pub file_revision: String,
    #[allow(dead_code)]
    pub format_version: u64,
    pub text_json: Option<String>,
}

#[derive(Clone, Debug)]
pub struct DiscoveredWorkshop {
    /// Vault-relative workshop folder ("" for the vault root).
    pub path: String,
    pub doc: WorkshopDoc,
    pub stories: Vec<DiscoveredStory>,
}

#[derive(Clone, Debug, Default)]
pub struct WorkshopDiscovery {
    pub workshops: Vec<DiscoveredWorkshop>,
    pub diagnostics: Vec<ProjectDiagnostic>,
}

fn should_visit(entry: &DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_dir() {
        return true;
    }
    let name = entry.file_name().to_string_lossy();
    !name.starts_with('.') && !crate::vault::scan::is_service_directory(name.as_ref())
}

fn relative(vault: &Path, path: &Path) -> String {
    path.strip_prefix(vault)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

fn diagnostic(
    code: &str,
    severity: &str,
    path: &str,
    workshop_id: Option<&str>,
    story_id: Option<&str>,
    detail: Option<String>,
) -> ProjectDiagnostic {
    ProjectDiagnostic {
        code: code.to_owned(),
        severity: severity.to_owned(),
        path: path.to_owned(),
        workshop_id: workshop_id.map(str::to_owned),
        story_id: story_id.map(str::to_owned),
        detail,
    }
}

pub fn discover_projects(vault: &Path) -> Result<WorkshopDiscovery, String> {
    let vault = vault
        .canonicalize()
        .map_err(|error| format!("Vault not accessible: {error}"))?;
    let mut found_workshops: Vec<(String, String, std::path::PathBuf)> = Vec::new();
    let mut diagnostics = Vec::new();

    for entry in WalkDir::new(&vault)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(should_visit)
    {
        let entry = entry.map_err(|error| format!("Cannot scan vault: {error}"))?;
        let file_name = entry.file_name().to_string_lossy();
        if file_name == LEGACY_PROJECT_FILE_NAME {
            let file = relative(&vault, entry.path());
            diagnostics.push(diagnostic(
                "legacyProjectFormat",
                "warning",
                &file,
                None,
                None,
                Some("Legacy format v2 project; open as regular folders and databases".to_owned()),
            ));
            continue;
        }
        if file_name != WORKSHOP_FILE_NAME {
            continue;
        }
        let file = relative(&vault, entry.path());
        if entry.file_type().is_symlink() {
            diagnostics.push(diagnostic(
                "symlinkIgnored",
                "warning",
                &file,
                None,
                None,
                None,
            ));
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let folder = relative(&vault, entry.path().parent().unwrap_or(&vault));
        found_workshops.push((folder, file, entry.path().to_path_buf()));
    }

    // Shallow folders first.
    found_workshops.sort_by(|left, right| {
        let depth = |path: &str| {
            if path.is_empty() {
                0
            } else {
                path.matches('/').count() + 1
            }
        };
        depth(&left.0)
            .cmp(&depth(&right.0))
            .then(left.0.cmp(&right.0))
    });

    let mut workshops: Vec<DiscoveredWorkshop> = Vec::new();
    let mut seen_workshop_ids: HashSet<String> = HashSet::new();
    let mut seen_story_ids: HashSet<String> = HashSet::new();

    for (folder, file, path) in found_workshops {
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                diagnostics.push(diagnostic(
                    "unreadableWorkshopFile",
                    "error",
                    &file,
                    None,
                    None,
                    Some(error.to_string()),
                ));
                continue;
            }
        };
        let doc = match parse_workshop_file(&bytes) {
            Ok(doc) => doc,
            Err(problem) => {
                diagnostics.push(diagnostic(
                    problem.code,
                    "error",
                    &file,
                    None,
                    None,
                    Some(problem.detail),
                ));
                continue;
            }
        };
        if !seen_workshop_ids.insert(doc.workshop_id.clone()) {
            diagnostics.push(diagnostic(
                "duplicateWorkshopId",
                "error",
                &file,
                Some(&doc.workshop_id),
                None,
                None,
            ));
            continue;
        }
        if !doc.is_known_version() {
            diagnostics.push(diagnostic(
                "unsupportedFormatVersion",
                "warning",
                &file,
                Some(&doc.workshop_id),
                None,
                Some(format!("formatVersion {}", doc.format_version)),
            ));
        }
        for skipped in &doc.skipped_sections {
            diagnostics.push(diagnostic(
                skipped.code,
                "warning",
                &file,
                Some(&doc.workshop_id),
                None,
                Some(skipped.detail.clone()),
            ));
        }

        let workshop_dir = path.parent().unwrap_or(&vault);
        let mut stories = Vec::new();

        // Discover stories inside the stories section
        if let Some(stories_section) = doc.sections.iter().find(|s| s.role == ROLE_STORIES) {
            let stories_dir = workshop_dir.join(&stories_section.path);
            if stories_dir.is_dir() {
                if let Ok(entries) = fs::read_dir(&stories_dir) {
                    let mut dir_entries: Vec<_> = entries.flatten().collect();
                    dir_entries.sort_by_key(|e| e.file_name());

                    for dir_entry in dir_entries {
                        let Ok(file_type) = dir_entry.file_type() else {
                            continue;
                        };
                        if !file_type.is_dir() {
                            continue;
                        }
                        let story_folder_name = dir_entry.file_name().to_string_lossy().to_string();
                        if story_folder_name.starts_with('.') {
                            continue;
                        }

                        let story_dir = dir_entry.path();
                        let story_rel_folder = relative(&vault, &story_dir);
                        let card_file = story_dir.join(format!("{story_folder_name}.md"));
                        let manifest_file = story_dir.join(format!("{story_folder_name}.json"));
                        let story_file = story_dir.join(STORY_FILE_NAME);

                        let card_exists = card_file.is_file();
                        let story_file_exists = story_file.is_file();
                        let manifest_exists = manifest_file.is_file();

                        if !card_exists && (story_file_exists || manifest_exists) {
                            diagnostics.push(diagnostic(
                                "storyMissingMainFile",
                                "warning",
                                &story_rel_folder,
                                Some(&doc.workshop_id),
                                None,
                                Some(format!("Missing {story_folder_name}.md")),
                            ));
                            continue;
                        }

                        if !card_exists {
                            continue;
                        }

                        // Read and parse amby-story.json
                        if !story_file_exists {
                            diagnostics.push(diagnostic(
                                "storyMissingConfigFile",
                                "warning",
                                &story_rel_folder,
                                Some(&doc.workshop_id),
                                None,
                                Some("Missing amby-story.json".to_owned()),
                            ));
                            continue;
                        }

                        let story_bytes = match fs::read(&story_file) {
                            Ok(b) => b,
                            Err(e) => {
                                diagnostics.push(diagnostic(
                                    "brokenManifest",
                                    "error",
                                    &relative(&vault, &story_file),
                                    Some(&doc.workshop_id),
                                    None,
                                    Some(e.to_string()),
                                ));
                                continue;
                            }
                        };

                        let story_doc = match parse_story_file(&story_bytes) {
                            Ok(doc) => doc,
                            Err(problem) => {
                                diagnostics.push(diagnostic(
                                    "brokenManifest",
                                    "error",
                                    &relative(&vault, &story_file),
                                    Some(&doc.workshop_id),
                                    None,
                                    Some(problem.detail),
                                ));
                                continue;
                            }
                        };

                        if !seen_story_ids.insert(story_doc.story_id.clone()) {
                            diagnostics.push(diagnostic(
                                "duplicateStoryId",
                                "error",
                                &relative(&vault, &story_file),
                                Some(&doc.workshop_id),
                                Some(&story_doc.story_id),
                                None,
                            ));
                            continue;
                        }

                        // Read database manifest
                        let database_id = if !manifest_exists {
                            diagnostics.push(diagnostic(
                                "brokenManifest",
                                "error",
                                &story_rel_folder,
                                Some(&doc.workshop_id),
                                Some(&story_doc.story_id),
                                Some(format!("Missing {story_folder_name}.json")),
                            ));
                            None
                        } else {
                            match fs::read(&manifest_file) {
                                Ok(manifest_bytes) => match parse_manifest(&manifest_bytes) {
                                    Ok(parsed_manifest) => Some(parsed_manifest.value.database_id),
                                    Err(e) => {
                                        diagnostics.push(diagnostic(
                                            "brokenManifest",
                                            "error",
                                            &relative(&vault, &manifest_file),
                                            Some(&doc.workshop_id),
                                            Some(&story_doc.story_id),
                                            Some(e.to_string()),
                                        ));
                                        None
                                    }
                                },
                                Err(e) => {
                                    diagnostics.push(diagnostic(
                                        "brokenManifest",
                                        "error",
                                        &relative(&vault, &manifest_file),
                                        Some(&doc.workshop_id),
                                        Some(&story_doc.story_id),
                                        Some(e.to_string()),
                                    ));
                                    None
                                }
                            }
                        };

                        // Read frontmatter of the card note to get note id and display title
                        let (card_note_id, display_title) = match fs::read_to_string(&card_file) {
                            Ok(content) => {
                                let parsed = parse_markdown(&content);
                                (parsed.note_id().map(str::to_owned), parsed.display_title)
                            }
                            Err(_) => (None, None),
                        };

                        let name = display_title.unwrap_or(story_folder_name);

                        stories.push(DiscoveredStory {
                            story_id: story_doc.story_id,
                            name,
                            folder_path: story_rel_folder,
                            card_path: relative(&vault, &card_file),
                            card_note_id,
                            database_id,
                            file_revision: story_doc.revision,
                            format_version: story_doc.format_version,
                            text_json: story_doc.text_json,
                        });
                    }
                }
            }
        }

        workshops.push(DiscoveredWorkshop {
            path: folder,
            doc,
            stories,
        });
    }

    workshops.sort_by(|left, right| left.path.cmp(&right.path));

    Ok(WorkshopDiscovery {
        workshops,
        diagnostics,
    })
}
