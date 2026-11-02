//! Read-only database/container discovery and filesystem ownership.
//!
//! Discovery deliberately runs before any SQLite projection is involved. The
//! durable manifest is a boundary marker even when it is broken: a malformed
//! nested manifest must not make its subtree appear to belong to an outer
//! database by accident.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use walkdir::{DirEntry, WalkDir};

use super::format::{
    parse_manifest, parse_record, parse_template, parse_view, DatabaseManifest, FormatError,
};
use super::validation::{validate_manifest, validate_record};
use crate::frontmatter;
use crate::paths;

pub const DATABASE_MANIFEST: &str = "ambd.json";

/// Returns true if a path is a candidate for a database manifest:
/// either `ambd.json`, or `<container_name>.json`, or `<container_name>.database`.
pub fn is_manifest_file_candidate(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if file_name == DATABASE_MANIFEST {
        return true;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    let Some(parent_name) = parent.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
        if stem == parent_name {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                return ext == "json" || ext == "database";
            }
        }
    }
    false
}

/// Find existing manifest path for a container:
/// 1. `<container_name>.json`
/// 2. `<container_name>.database`
/// 3. `ambd.json`
pub fn find_manifest_path(container: &Path) -> Option<PathBuf> {
    let name = container.file_name()?.to_string_lossy();
    let named_json = container.join(format!("{name}.json"));
    if named_json.is_file() {
        return Some(named_json);
    }
    let named_database = container.join(format!("{name}.database"));
    if named_database.is_file() {
        return Some(named_database);
    }
    let ambd_json = container.join(DATABASE_MANIFEST);
    if ambd_json.is_file() {
        return Some(ambd_json);
    }
    None
}

/// Returns the manifest path for creating or targeting a container.
/// If an existing manifest is found, returns that.
/// Otherwise returns `<container_name>.json`.
pub fn manifest_path_for_container(container: &Path) -> PathBuf {
    if let Some(existing) = find_manifest_path(container) {
        existing
    } else {
        let name = container
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "database".to_string());
        container.join(format!("{name}.json"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContainerKind {
    Attached,
    Standalone,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiagnosticSeverity {
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiagnosticCode {
    BrokenManifest,
    UnsupportedManifest,
    InvalidManifest,
    DuplicateDatabaseId,
    DuplicateDatabaseTitle,
    BrokenNote,
    InvalidNoteId,
    DuplicateNoteId,
    DuplicateNoteTitle,
    BrokenShard,
    OrphanShard,
    MissingShard,
    DatabaseIdMismatch,
    InvalidShardFilename,
    SymlinkEscape,
    NestedBoundary,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveryDiagnostic {
    pub code: DiagnosticCode,
    pub severity: DiagnosticSeverity,
    /// Always vault-relative and slash-normalized.
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredDatabase {
    pub database_id: String,
    pub name: String,
    pub icon: Option<String>,
    pub container_path: PathBuf,
    pub manifest_path: PathBuf,
    pub relative_container_path: String,
    pub kind: ContainerKind,
    pub attached_note_path: Option<PathBuf>,
    pub revision: String,
    pub read_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredNote {
    pub path: PathBuf,
    pub relative_path: String,
    pub note_id: Option<String>,
    pub title: String,
    pub owner_database_id: Option<String>,
    pub owner_container_path: Option<String>,
    pub parent_note_id: Option<String>,
    pub category_path: Vec<String>,
    pub depth: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiscoveryResult {
    pub databases: Vec<DiscoveredDatabase>,
    pub notes: Vec<DiscoveredNote>,
    pub diagnostics: Vec<DiscoveryDiagnostic>,
}

#[derive(Clone, Debug)]
struct ContainerBoundary {
    root: PathBuf,
    manifest_path: PathBuf,
    parsed: Option<super::format::ParsedJson<DatabaseManifest>>,
    validation_errors: Vec<String>,
    kind: ContainerKind,
    attached_note_path: Option<PathBuf>,
}

impl ContainerBoundary {
    fn database_id(&self) -> Option<&str> {
        self.parsed
            .as_ref()
            .map(|manifest| manifest.value.database_id.as_str())
    }

    fn is_usable(&self) -> bool {
        self.parsed.is_some() && self.validation_errors.is_empty()
    }

    fn is_attached_main(&self, path: &Path) -> bool {
        self.attached_note_path.as_deref() == Some(path)
    }
}

#[derive(Clone, Debug)]
struct NoteCandidate {
    path: PathBuf,
    relative_path: String,
    note_id: Option<String>,
    title: String,
}

/// Scan a vault for database manifests, notes and diagnostics without writing
/// either source files or rebuildable indexes.
pub fn discover_vault(vault: &Path) -> Result<DiscoveryResult, String> {
    let vault = vault
        .canonicalize()
        .map_err(|error| format!("Vault not accessible: {error}"))?;
    if !vault.is_dir() {
        return Err(format!("Vault is not a directory: {}", vault.display()));
    }

    let mut diagnostics = Vec::new();
    let mut boundaries = discover_boundaries(&vault, &mut diagnostics)?;
    boundaries.sort_by(|left, right| {
        relative_path(&vault, &left.root).cmp(&relative_path(&vault, &right.root))
    });

    let notes = discover_notes(&vault, &boundaries, &mut diagnostics)?;
    diagnose_database_duplicates(&vault, &boundaries, &mut diagnostics);
    diagnose_note_duplicates(&notes, &mut diagnostics);
    diagnose_shards(&vault, &boundaries, &notes, &mut diagnostics);

    let mut databases = boundaries
        .iter()
        .filter_map(|boundary| discovered_database(&vault, boundary))
        .collect::<Vec<_>>();
    databases.sort_by(|left, right| {
        left.relative_container_path
            .cmp(&right.relative_container_path)
    });

    Ok(DiscoveryResult {
        databases,
        notes,
        diagnostics,
    })
}

fn discover_boundaries(
    vault: &Path,
    diagnostics: &mut Vec<DiscoveryDiagnostic>,
) -> Result<Vec<ContainerBoundary>, String> {
    let mut boundaries = Vec::new();
    for entry in WalkDir::new(vault)
        .follow_links(false)
        .into_iter()
        .filter_entry(should_visit)
    {
        let entry = entry.map_err(|error| format!("Cannot scan vault: {error}"))?;
        let path = entry.path();
        if entry.file_type().is_symlink() {
            diagnose_symlink(vault, path, diagnostics);
            continue;
        }
        if !entry.file_type().is_file() || !is_manifest_file_candidate(path) {
            continue;
        }

        let is_ambd_json =
            path.file_name().and_then(|name| name.to_str()) == Some(DATABASE_MANIFEST);

        let root = path
            .parent()
            .ok_or_else(|| format!("Manifest has no parent: {}", path.display()))?
            .to_path_buf();
        if let Err(error) = paths::confine(vault, &root) {
            push_diagnostic(
                diagnostics,
                DiagnosticCode::SymlinkEscape,
                DiagnosticSeverity::Error,
                vault,
                path,
                error,
            );
            boundaries.push(ContainerBoundary {
                root,
                manifest_path: path.to_path_buf(),
                parsed: None,
                validation_errors: vec!["manifest container escapes vault".to_owned()],
                kind: ContainerKind::Standalone,
                attached_note_path: None,
            });
            continue;
        }

        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) => {
                if is_ambd_json {
                    push_diagnostic(
                        diagnostics,
                        DiagnosticCode::BrokenManifest,
                        DiagnosticSeverity::Error,
                        vault,
                        path,
                        error.to_string(),
                    );
                    boundaries.push(ContainerBoundary {
                        root,
                        manifest_path: path.to_path_buf(),
                        parsed: None,
                        validation_errors: vec![error.to_string()],
                        kind: ContainerKind::Standalone,
                        attached_note_path: None,
                    });
                }
                continue;
            }
        };

        if !is_ambd_json && !bytes.windows(15).any(|w| w == b"\"amby-database\"") {
            continue;
        }

        let (parsed, validation_errors) = match parse_manifest(&bytes) {
            Ok(parsed) => {
                let report = validate_manifest(&parsed.value);
                if !report.errors.is_empty() {
                    push_diagnostic(
                        diagnostics,
                        DiagnosticCode::InvalidManifest,
                        DiagnosticSeverity::Error,
                        vault,
                        path,
                        format!(
                            "manifest validation failed: {} issue(s)",
                            report.errors.len()
                        ),
                    );
                }
                for issue in &report.warnings {
                    push_diagnostic(
                        diagnostics,
                        DiagnosticCode::InvalidManifest,
                        DiagnosticSeverity::Warning,
                        vault,
                        path,
                        format!("{}: {}", issue.path, issue.message),
                    );
                }
                (
                    Some(parsed),
                    report
                        .errors
                        .iter()
                        .map(|issue| format!("{}: {}", issue.path, issue.message))
                        .collect(),
                )
            }
            Err(error @ FormatError::UnsupportedFormatVersion { .. }) => {
                push_diagnostic(
                    diagnostics,
                    DiagnosticCode::UnsupportedManifest,
                    DiagnosticSeverity::Error,
                    vault,
                    path,
                    error.to_string(),
                );
                (None, vec![error.to_string()])
            }
            Err(error) => {
                push_diagnostic(
                    diagnostics,
                    DiagnosticCode::BrokenManifest,
                    DiagnosticSeverity::Error,
                    vault,
                    path,
                    error.to_string(),
                );
                (None, vec![error.to_string()])
            }
        };

        let attached_note_path = attached_note_path(&root);
        let kind = if attached_note_path.is_some() {
            ContainerKind::Attached
        } else {
            ContainerKind::Standalone
        };
        if let Some(note_path) = &attached_note_path {
            if let Err(error) = paths::confine(vault, note_path) {
                push_diagnostic(
                    diagnostics,
                    DiagnosticCode::SymlinkEscape,
                    DiagnosticSeverity::Error,
                    vault,
                    note_path,
                    error,
                );
            }
        }
        inspect_container_links(vault, &root, diagnostics);
        if let Some(pos) = boundaries.iter().position(|b| b.root == root) {
            if !is_ambd_json {
                boundaries.remove(pos);
            } else {
                continue;
            }
        }
        boundaries.push(ContainerBoundary {
            root,
            manifest_path: path.to_path_buf(),
            parsed,
            validation_errors,
            kind,
            attached_note_path,
        });
    }
    Ok(boundaries)
}

fn discover_notes(
    vault: &Path,
    boundaries: &[ContainerBoundary],
    diagnostics: &mut Vec<DiscoveryDiagnostic>,
) -> Result<Vec<DiscoveredNote>, String> {
    let mut candidates = Vec::new();
    for entry in WalkDir::new(vault)
        .follow_links(false)
        .into_iter()
        .filter_entry(should_visit)
    {
        let entry = entry.map_err(|error| format!("Cannot scan vault: {error}"))?;
        let path = entry.path();
        if entry.file_type().is_symlink() {
            diagnose_symlink(vault, path, diagnostics);
            continue;
        }
        if !entry.file_type().is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("md")
            || path.file_name().and_then(|name| name.to_str()) == Some("Metadata.md")
        {
            continue;
        }

        let relative_path = relative_path(vault, path);
        let parsed = match frontmatter::read_markdown(path) {
            Ok(parsed) => parsed,
            Err(error) => {
                push_diagnostic(
                    diagnostics,
                    DiagnosticCode::BrokenNote,
                    DiagnosticSeverity::Error,
                    vault,
                    path,
                    error,
                );
                continue;
            }
        };
        if let Some(error) = parsed.identity_error.as_deref() {
            push_diagnostic(
                diagnostics,
                DiagnosticCode::InvalidNoteId,
                DiagnosticSeverity::Warning,
                vault,
                path,
                error,
            );
        }
        candidates.push(NoteCandidate {
            path: path.to_path_buf(),
            relative_path,
            note_id: parsed.note_id().map(str::to_owned),
            title: parsed
                .display_title
                .unwrap_or_else(|| crate::vault::scan::title_for(path, &parsed.body)),
        });
    }
    candidates.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

    let candidate_by_path = candidates
        .iter()
        .map(|candidate| (candidate.path.clone(), candidate))
        .collect::<HashMap<_, _>>();
    let mut result = candidates
        .iter()
        .map(|candidate| {
            let owner = resolve_owner(&candidate.path, boundaries, vault, diagnostics);
            let parent_path = find_parent_path(candidate, owner, &candidate_by_path);
            let parent_note_id = parent_path
                .as_ref()
                .and_then(|path| candidate_by_path.get(path))
                .and_then(|parent| parent.note_id.clone());
            let category_path = owner
                .map(|boundary| category_path(&boundary.root, &candidate.path))
                .unwrap_or_default();
            let depth = parent_path
                .as_ref()
                .map(|path| note_depth(path, &candidate_by_path) + 1)
                .unwrap_or(0);
            DiscoveredNote {
                path: candidate.path.clone(),
                relative_path: candidate.relative_path.clone(),
                note_id: candidate.note_id.clone(),
                title: candidate.title.clone(),
                owner_database_id: owner
                    .and_then(ContainerBoundary::database_id)
                    .map(str::to_owned),
                owner_container_path: owner.map(|boundary| relative_path(vault, &boundary.root)),
                parent_note_id,
                category_path,
                depth,
            }
        })
        .collect::<Vec<_>>();
    result.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(result)
}

fn resolve_owner<'a>(
    note_path: &Path,
    boundaries: &'a [ContainerBoundary],
    vault: &Path,
    diagnostics: &mut Vec<DiscoveryDiagnostic>,
) -> Option<&'a ContainerBoundary> {
    let mut containing = boundaries
        .iter()
        .filter(|boundary| note_path.starts_with(&boundary.root))
        .collect::<Vec<_>>();
    containing.sort_by_key(|boundary| std::cmp::Reverse(boundary.root.components().count()));

    for boundary in containing {
        if boundary.is_attached_main(note_path) {
            // An attached container's same-name main note is the row in its
            // outer database, not a row in the database it describes.
            if boundary.is_usable() {
                continue;
            }
            push_diagnostic(
                diagnostics,
                DiagnosticCode::NestedBoundary,
                DiagnosticSeverity::Error,
                vault,
                note_path,
                "attached database main note has a broken nested manifest",
            );
            return None;
        }
        if !boundary.is_usable() {
            push_diagnostic(
                diagnostics,
                DiagnosticCode::NestedBoundary,
                DiagnosticSeverity::Error,
                vault,
                note_path,
                "note is behind a broken database boundary and has no owner",
            );
            return None;
        }
        return Some(boundary);
    }
    None
}

fn find_parent_path<'a>(
    candidate: &NoteCandidate,
    owner: Option<&ContainerBoundary>,
    candidates: &'a HashMap<PathBuf, &'a NoteCandidate>,
) -> Option<PathBuf> {
    let root = owner.map(|boundary| boundary.root.as_path());
    let mut directory = candidate.path.parent()?.to_path_buf();
    while root.map(|root| directory.starts_with(root)).unwrap_or(true) {
        let name = directory.file_name()?.to_string_lossy();
        let main = directory.join(format!("{name}.md"));
        if main != candidate.path && candidates.contains_key(&main) {
            return Some(main);
        }
        if root == Some(directory.as_path()) {
            break;
        }
        directory = directory.parent()?.to_path_buf();
    }
    None
}

fn note_depth(path: &Path, candidates: &HashMap<PathBuf, &NoteCandidate>) -> usize {
    let mut depth = 0;
    let mut current = path.to_path_buf();
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current.clone()) {
            break;
        }
        let Some(candidate) = candidates.get(&current) else {
            break;
        };
        let Some(parent) = find_parent_path(candidate, None, candidates) else {
            break;
        };
        depth += 1;
        current = parent;
    }
    depth
}

fn category_path(root: &Path, note_path: &Path) -> Vec<String> {
    let Some(parent) = note_path.parent() else {
        return Vec::new();
    };
    let Ok(relative) = parent.strip_prefix(root) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Some(name) = component.as_os_str().to_str() else {
            continue;
        };
        current.push(name);
        if attached_note_path(&current).is_none() {
            result.push(name.to_owned());
        }
    }
    result
}

fn diagnose_database_duplicates(
    vault: &Path,
    boundaries: &[ContainerBoundary],
    diagnostics: &mut Vec<DiscoveryDiagnostic>,
) {
    let mut ids = HashMap::<String, String>::new();
    let mut titles = HashMap::<String, String>::new();
    for boundary in boundaries {
        let Some(parsed) = &boundary.parsed else {
            continue;
        };
        let relative = relative_path(vault, &boundary.manifest_path);
        if let Some(previous) = ids.insert(parsed.value.database_id.clone(), relative.clone()) {
            push_diagnostic(
                diagnostics,
                DiagnosticCode::DuplicateDatabaseId,
                DiagnosticSeverity::Error,
                vault,
                &boundary.manifest_path,
                format!("database ID is also declared by {previous}"),
            );
        }
        if let Some(previous) = titles.insert(parsed.value.name.clone(), relative) {
            push_diagnostic(
                diagnostics,
                DiagnosticCode::DuplicateDatabaseTitle,
                DiagnosticSeverity::Warning,
                vault,
                &boundary.manifest_path,
                format!("database title is also declared by {previous}"),
            );
        }
    }
}

fn diagnose_note_duplicates(notes: &[DiscoveredNote], diagnostics: &mut Vec<DiscoveryDiagnostic>) {
    let mut ids = HashMap::<(&str, &str), String>::new();
    let mut titles = HashMap::<(&str, &str), String>::new();
    for note in notes {
        let Some(owner) = note.owner_database_id.as_deref() else {
            continue;
        };
        if let Some(id) = note.note_id.as_deref() {
            if let Some(previous) = ids.insert((owner, id), note.relative_path.clone()) {
                diagnostics.push(DiscoveryDiagnostic {
                    code: DiagnosticCode::DuplicateNoteId,
                    severity: DiagnosticSeverity::Error,
                    path: note.relative_path.clone(),
                    message: format!("note ID is also used by {previous}"),
                });
            }
        }
        if let Some(previous) = titles.insert((owner, &note.title), note.relative_path.clone()) {
            diagnostics.push(DiscoveryDiagnostic {
                code: DiagnosticCode::DuplicateNoteTitle,
                severity: DiagnosticSeverity::Warning,
                path: note.relative_path.clone(),
                message: format!("note title is also used by {previous}"),
            });
        }
    }
}

fn diagnose_shards(
    vault: &Path,
    boundaries: &[ContainerBoundary],
    notes: &[DiscoveredNote],
    diagnostics: &mut Vec<DiscoveryDiagnostic>,
) {
    for boundary in boundaries.iter().filter(|boundary| boundary.is_usable()) {
        let Some(parsed_manifest) = &boundary.parsed else {
            continue;
        };
        for (directory, kind) in [
            ("records", ShardKind::Record),
            ("views", ShardKind::View),
            ("templates", ShardKind::Template),
        ] {
            let path = boundary.root.join(".ambd").join(directory);
            if let Err(error) = paths::confine(vault, &path) {
                if path.exists() || fs::symlink_metadata(&path).is_ok() {
                    push_diagnostic(
                        diagnostics,
                        DiagnosticCode::SymlinkEscape,
                        DiagnosticSeverity::Error,
                        vault,
                        &path,
                        error,
                    );
                }
                continue;
            }
            let Ok(entries) = fs::read_dir(&path) else {
                diagnose_missing_shards(vault, boundary, parsed_manifest, &path, kind, diagnostics);
                continue;
            };
            let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                let shard_path = entry.path();
                let file_type = match entry.file_type() {
                    Ok(file_type) => file_type,
                    Err(error) => {
                        push_diagnostic(
                            diagnostics,
                            DiagnosticCode::BrokenShard,
                            DiagnosticSeverity::Error,
                            vault,
                            &shard_path,
                            error.to_string(),
                        );
                        continue;
                    }
                };
                if file_type.is_symlink() {
                    diagnose_symlink(vault, &shard_path, diagnostics);
                    continue;
                }
                if !file_type.is_file()
                    || shard_path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        != Some("json")
                {
                    continue;
                }
                diagnose_one_shard(
                    vault,
                    parsed_manifest,
                    notes,
                    &shard_path,
                    kind,
                    diagnostics,
                );
            }
            diagnose_missing_shards(vault, boundary, parsed_manifest, &path, kind, diagnostics);
        }
    }
}

#[derive(Clone, Copy)]
enum ShardKind {
    Record,
    View,
    Template,
}

fn diagnose_one_shard(
    vault: &Path,
    manifest: &super::format::ParsedJson<DatabaseManifest>,
    notes: &[DiscoveredNote],
    path: &Path,
    kind: ShardKind,
    diagnostics: &mut Vec<DiscoveryDiagnostic>,
) {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            push_diagnostic(
                diagnostics,
                DiagnosticCode::BrokenShard,
                DiagnosticSeverity::Error,
                vault,
                path,
                error.to_string(),
            );
            return;
        }
    };
    match kind {
        ShardKind::Record => {
            let parsed = match parse_record(&bytes) {
                Ok(parsed) => parsed,
                Err(error) => {
                    push_diagnostic(
                        diagnostics,
                        DiagnosticCode::BrokenShard,
                        DiagnosticSeverity::Error,
                        vault,
                        path,
                        error.to_string(),
                    );
                    return;
                }
            };
            let filename = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default();
            let report = validate_record(&parsed.value, Some(&manifest.value));
            if parsed.value.database_id != manifest.value.database_id {
                push_diagnostic(
                    diagnostics,
                    DiagnosticCode::DatabaseIdMismatch,
                    DiagnosticSeverity::Error,
                    vault,
                    path,
                    "record databaseId does not match its container manifest",
                );
            }
            if parsed.value.note_id != filename {
                push_diagnostic(
                    diagnostics,
                    DiagnosticCode::InvalidShardFilename,
                    DiagnosticSeverity::Error,
                    vault,
                    path,
                    "record filename must match noteId",
                );
            }
            if !report.errors.is_empty() {
                push_diagnostic(
                    diagnostics,
                    DiagnosticCode::BrokenShard,
                    DiagnosticSeverity::Error,
                    vault,
                    path,
                    format!("record validation failed: {} issue(s)", report.errors.len()),
                );
            }
            let owned = notes.iter().any(|note| {
                note.note_id.as_deref() == Some(parsed.value.note_id.as_str())
                    && note.owner_database_id.as_deref()
                        == Some(manifest.value.database_id.as_str())
            });
            if !owned {
                push_diagnostic(
                    diagnostics,
                    DiagnosticCode::OrphanShard,
                    DiagnosticSeverity::Warning,
                    vault,
                    path,
                    "record shard has no currently owned note",
                );
            }
        }
        ShardKind::View => {
            let parsed = match parse_view(&bytes) {
                Ok(parsed) => parsed,
                Err(error) => {
                    push_diagnostic(
                        diagnostics,
                        DiagnosticCode::BrokenShard,
                        DiagnosticSeverity::Error,
                        vault,
                        path,
                        error.to_string(),
                    );
                    return;
                }
            };
            let report = super::validation::validate_view(&parsed.value, Some(&manifest.value));
            if parsed.value.database_id != manifest.value.database_id || !report.errors.is_empty() {
                push_diagnostic(
                    diagnostics,
                    DiagnosticCode::BrokenShard,
                    DiagnosticSeverity::Error,
                    vault,
                    path,
                    "view shard does not match or validate against its manifest",
                );
            }
        }
        ShardKind::Template => {
            let parsed = match parse_template(&bytes) {
                Ok(parsed) => parsed,
                Err(error) => {
                    push_diagnostic(
                        diagnostics,
                        DiagnosticCode::BrokenShard,
                        DiagnosticSeverity::Error,
                        vault,
                        path,
                        error.to_string(),
                    );
                    return;
                }
            };
            let report = super::validation::validate_template(&parsed.value, Some(&manifest.value));
            if parsed.value.database_id != manifest.value.database_id || !report.errors.is_empty() {
                push_diagnostic(
                    diagnostics,
                    DiagnosticCode::BrokenShard,
                    DiagnosticSeverity::Error,
                    vault,
                    path,
                    "template shard does not match or validate against its manifest",
                );
            }
        }
    }
}

fn diagnose_missing_shards(
    vault: &Path,
    boundary: &ContainerBoundary,
    manifest: &super::format::ParsedJson<DatabaseManifest>,
    directory: &Path,
    kind: ShardKind,
    diagnostics: &mut Vec<DiscoveryDiagnostic>,
) {
    let expected = match kind {
        ShardKind::Record => return,
        ShardKind::View => &manifest.value.view_order,
        ShardKind::Template => &manifest.value.template_order,
    };
    for id in expected {
        if matches!(kind, ShardKind::View) && manifest.value.views.iter().any(|v| &v.view_id == id)
        {
            continue;
        }
        let file = directory.join(format!("{id}.json"));
        if !file.is_file() {
            push_diagnostic(
                diagnostics,
                DiagnosticCode::MissingShard,
                DiagnosticSeverity::Warning,
                vault,
                &boundary.manifest_path,
                format!("referenced {} shard {id} is missing", kind_name(kind)),
            );
        }
    }
}

fn kind_name(kind: ShardKind) -> &'static str {
    match kind {
        ShardKind::Record => "record",
        ShardKind::View => "view",
        ShardKind::Template => "template",
    }
}

fn discovered_database(vault: &Path, boundary: &ContainerBoundary) -> Option<DiscoveredDatabase> {
    let parsed = boundary.parsed.as_ref()?;
    if !boundary.is_usable() {
        return None;
    }
    Some(DiscoveredDatabase {
        database_id: parsed.value.database_id.clone(),
        name: parsed.value.name.clone(),
        icon: parsed.value.icon.clone(),
        container_path: boundary.root.clone(),
        manifest_path: boundary.manifest_path.clone(),
        relative_container_path: relative_path(vault, &boundary.root),
        kind: boundary.kind,
        attached_note_path: boundary.attached_note_path.clone(),
        revision: parsed.revision.clone(),
        read_only: parsed.read_only.is_some(),
    })
}

fn attached_note_path(root: &Path) -> Option<PathBuf> {
    let name = root.file_name()?.to_str()?;
    let path = root.join(format!("{name}.md"));
    is_regular_file(&path).then_some(path)
}

fn inspect_container_links(vault: &Path, root: &Path, diagnostics: &mut Vec<DiscoveryDiagnostic>) {
    for relative in [
        ".ambd",
        ".ambd/records",
        ".ambd/views",
        ".ambd/templates",
        ".ambd/assets",
    ] {
        let path = root.join(relative);
        if (path.exists() || fs::symlink_metadata(&path).is_ok())
            && paths::confine(vault, &path).is_err()
        {
            let error = paths::confine(vault, &path).unwrap_err();
            push_diagnostic(
                diagnostics,
                DiagnosticCode::SymlinkEscape,
                DiagnosticSeverity::Error,
                vault,
                &path,
                error,
            );
        }
    }
}

fn diagnose_symlink(vault: &Path, path: &Path, diagnostics: &mut Vec<DiscoveryDiagnostic>) {
    if let Err(error) = paths::confine(vault, path) {
        push_diagnostic(
            diagnostics,
            DiagnosticCode::SymlinkEscape,
            DiagnosticSeverity::Error,
            vault,
            path,
            error,
        );
    }
}

fn should_visit(entry: &DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_dir() {
        return true;
    }
    let name = entry.file_name().to_string_lossy();
    !name.starts_with('.') && !crate::vault::scan::is_service_directory(name.as_ref())
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

fn relative_path(vault: &Path, path: &Path) -> String {
    path.strip_prefix(vault)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

fn push_diagnostic(
    diagnostics: &mut Vec<DiscoveryDiagnostic>,
    code: DiagnosticCode,
    severity: DiagnosticSeverity,
    vault: &Path,
    path: &Path,
    message: impl Into<String>,
) {
    diagnostics.push(DiscoveryDiagnostic {
        code,
        severity,
        path: relative_path(vault, path),
        message: message.into(),
    });
}

#[cfg(test)]
#[path = "discovery_test.rs"]
mod tests;
