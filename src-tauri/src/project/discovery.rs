//! Read-only discovery of creative projects by `amby-project.json`.
//!
//! Membership follows folder nesting: a story belongs to the nearest collection
//! above it. Discovery never writes and never trusts a damaged file; it reports
//! a diagnostic and leaves the data alone.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use walkdir::{DirEntry, WalkDir};

use super::format::{parse_project_file, ProjectDoc};
use super::model::{ProjectDiagnostic, ProjectKind, PROJECT_FILE_NAME};

#[derive(Clone, Debug)]
pub struct DiscoveredProject {
    /// Vault-relative project folder ("" for the vault root).
    pub path: String,
    pub doc: ProjectDoc,
    /// The nearest collection above this project, by folder nesting.
    pub collection_id: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ProjectDiscovery {
    pub projects: Vec<DiscoveredProject>,
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
    project_id: Option<&str>,
    detail: Option<String>,
) -> ProjectDiagnostic {
    ProjectDiagnostic {
        code: code.to_owned(),
        severity: severity.to_owned(),
        path: path.to_owned(),
        project_id: project_id.map(str::to_owned),
        detail,
    }
}

/// True when `ancestor` is a strict folder ancestor of `path` (both
/// vault-relative; "" is the vault root).
fn is_ancestor(ancestor: &str, path: &str) -> bool {
    if ancestor == path {
        return false;
    }
    ancestor.is_empty() || path.starts_with(&format!("{ancestor}/"))
}

pub fn discover_projects(vault: &Path) -> Result<ProjectDiscovery, String> {
    let vault = vault
        .canonicalize()
        .map_err(|error| format!("Vault not accessible: {error}"))?;
    let mut found: Vec<(String, String, Result<ProjectDoc, ProjectDiagnostic>)> = Vec::new();
    let mut diagnostics = Vec::new();

    for entry in WalkDir::new(&vault)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(should_visit)
    {
        let entry = entry.map_err(|error| format!("Cannot scan vault: {error}"))?;
        if entry.file_name().to_string_lossy() != PROJECT_FILE_NAME {
            continue;
        }
        let file = relative(&vault, entry.path());
        if entry.file_type().is_symlink() {
            diagnostics.push(diagnostic("symlinkIgnored", "warning", &file, None, None));
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let folder = relative(&vault, entry.path().parent().unwrap_or(&vault));
        let parsed = fs::read(entry.path())
            .map_err(|error| {
                diagnostic(
                    "unreadableProjectFile",
                    "error",
                    &file,
                    None,
                    Some(error.to_string()),
                )
            })
            .and_then(|bytes| {
                parse_project_file(&bytes).map_err(|problem| {
                    diagnostic(problem.code, "error", &file, None, Some(problem.detail))
                })
            });
        found.push((folder, file, parsed));
    }
    // Shallow folders first, so an ancestor is always decided before its children.
    found.sort_by(|left, right| {
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

    let mut projects: Vec<DiscoveredProject> = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();
    for (folder, file, parsed) in found {
        let doc = match parsed {
            Ok(doc) => doc,
            Err(problem) => {
                diagnostics.push(problem);
                continue;
            }
        };
        if !seen_ids.insert(doc.project_id.clone()) {
            // A copied folder repeats the ID. The first one by path keeps it;
            // the copy is not a second project.
            diagnostics.push(diagnostic(
                "duplicateProjectId",
                "error",
                &file,
                Some(&doc.project_id),
                None,
            ));
            continue;
        }
        if !doc.is_known_version() {
            diagnostics.push(diagnostic(
                "unsupportedFormatVersion",
                "warning",
                &file,
                Some(&doc.project_id),
                Some(format!("formatVersion {}", doc.format_version)),
            ));
        }
        for skipped in &doc.skipped_sections {
            diagnostics.push(diagnostic(
                skipped.code,
                "warning",
                &file,
                Some(&doc.project_id),
                Some(skipped.detail.clone()),
            ));
        }
        let ancestors = projects
            .iter()
            .filter(|candidate| is_ancestor(&candidate.path, &folder))
            .collect::<Vec<_>>();
        let nearest_collection = ancestors
            .iter()
            .filter(|candidate| candidate.doc.kind == ProjectKind::Collection)
            .max_by_key(|candidate| candidate.path.len())
            .map(|candidate| candidate.doc.project_id.clone());
        let collection_id = match doc.kind {
            ProjectKind::Story => nearest_collection,
            ProjectKind::Collection => {
                if let Some(outer) = ancestors
                    .iter()
                    .filter(|candidate| candidate.doc.kind == ProjectKind::Collection)
                    .max_by_key(|candidate| candidate.path.len())
                {
                    diagnostics.push(diagnostic(
                        "nestedCollection",
                        "warning",
                        &file,
                        Some(&doc.project_id),
                        Some(outer.path.clone()),
                    ));
                }
                None
            }
        };
        if doc.kind == ProjectKind::Story
            && ancestors
                .iter()
                .any(|candidate| candidate.doc.kind == ProjectKind::Story)
        {
            diagnostics.push(diagnostic(
                "storyInsideStory",
                "warning",
                &file,
                Some(&doc.project_id),
                None,
            ));
        }
        projects.push(DiscoveredProject {
            path: folder,
            doc,
            collection_id,
        });
    }
    projects.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(ProjectDiscovery {
        projects,
        diagnostics,
    })
}
