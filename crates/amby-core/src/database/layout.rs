//! Explicit, backed-up conversion to the single-manifest database layout.
//! Scanning is read-only. Only the notification's action invokes `upgrade`.
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use walkdir::WalkDir;

use super::discovery::{discover_vault, manifest_path_for_container};
use super::format::{parse_manifest, parse_template, parse_view, raw_revision, MAX_JSON_BYTES};
use crate::{frontmatter, paths};

const JOURNALS: &str = ".amby/migrations/database-layout-v2";

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LayoutStatus {
    pub pending_databases: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct FileBackup {
    source: String,
    revision: String,
    destination: Option<String>,
    destination_existed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Journal {
    version: u32,
    status: String,
    container: String,
    updated_revision: String,
    files: Vec<FileBackup>,
}

struct Plan {
    journal: Journal,
    originals: Vec<Option<Vec<u8>>>,
    updated: Vec<u8>,
}

fn relative(vault: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(vault)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "Database layout path is outside the vault".to_owned())
}

fn checked(vault: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if relative.is_empty()
        || rel.is_absolute()
        || rel
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Unsafe database layout path".to_owned());
    }
    let mut path = vault.to_path_buf();
    for part in rel.components() {
        path.push(part);
        if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err("Database layout cannot traverse a symbolic link".to_owned());
        }
    }
    paths::confine(vault, &path)
}

pub fn scan(vault: &Path) -> Result<LayoutStatus, String> {
    let discovery = discover_vault(vault)?;
    let mut pending = 0;
    for database in discovery.databases {
        let parsed =
            parse_manifest(&fs::read(&database.manifest_path).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
        if parsed.value.format_version == 1 {
            pending += 1;
        }
    }
    let journals = checked(vault, JOURNALS)?;
    if journals.exists() {
        for entry in fs::read_dir(&journals).map_err(|error| error.to_string())? {
            let path = entry
                .map_err(|error| error.to_string())?
                .path()
                .join("plan.json");
            let path = checked(vault, &relative(vault, &path)?)?;
            if !path.exists() {
                continue;
            }
            let journal: Journal =
                serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
            if journal.version != 1 {
                return Err("Unsupported database layout journal".to_owned());
            }
            if journal.status == "inProgress" {
                pending += 1;
            }
        }
    }
    Ok(LayoutStatus {
        pending_databases: pending,
    })
}

fn regular_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().is_symlink() {
            return Err("Legacy database files contain a symbolic link".to_owned());
        }
        if entry.file_type().is_file() {
            files.push(entry.into_path());
        } else if !entry.file_type().is_dir() {
            return Err("Legacy database files contain an unsupported entry".to_owned());
        }
    }
    files.sort();
    Ok(files)
}

// Unknown fields may contain decimals outside serde_json's exact numeric range. Refuse
// conversion instead of rounding such a value while embedding a legacy document.
fn ensure_lossless_numbers(bytes: &[u8]) -> Result<(), String> {
    let mut index = 0;
    let mut quoted = false;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' if quoted => {
                index += 2;
                continue;
            }
            b'"' => quoted = !quoted,
            b'-' | b'0'..=b'9' if !quoted => {
                let start = index;
                while index < bytes.len()
                    && matches!(bytes[index], b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')
                {
                    index += 1;
                }
                let raw =
                    std::str::from_utf8(&bytes[start..index]).map_err(|error| error.to_string())?;
                let number: serde_json::Number =
                    serde_json::from_str(raw).map_err(|error| error.to_string())?;
                let original = super::validation::canonical_decimal(raw).map_err(|_| {
                    "Unsupported numeric precision in database configuration".to_owned()
                })?;
                let encoded =
                    super::validation::canonical_decimal(&number.to_string()).map_err(|_| {
                        "Unsupported numeric precision in database configuration".to_owned()
                    })?;
                if original != encoded {
                    return Err("Conversion would round an unknown numeric field".to_owned());
                }
                continue;
            }
            _ => {}
        }
        index += 1;
    }
    Ok(())
}

fn plan(vault: &Path, container: &Path) -> Result<Plan, String> {
    let source = manifest_path_for_container(container);
    let source = checked(vault, &relative(vault, &source)?)?;
    let original = fs::read(&source).map_err(|error| error.to_string())?;
    ensure_lossless_numbers(&original)?;
    let parsed = parse_manifest(&original).map_err(|error| error.to_string())?;
    if !parsed.is_writable() || parsed.value.format_version != 1 {
        return Err("Database layout is not eligible for conversion".to_owned());
    }
    if !regular_files(&container.join(".ambd/records"))?.is_empty() {
        return Err("Legacy record values require a separate reviewed conversion".to_owned());
    }
    let destination = container.join(format!(
        "{}.json",
        container
            .file_name()
            .ok_or("Database container has no name")?
            .to_string_lossy()
    ));
    for candidate in [
        container.join("ambd.json"),
        container.join(format!(
            "{}.database",
            container
                .file_name()
                .ok_or("Database container has no name")?
                .to_string_lossy()
        )),
    ] {
        if candidate != source && candidate.exists() {
            return Err("Multiple database manifests require review before conversion".to_owned());
        }
    }
    if destination != source && destination.exists() {
        return Err("Database manifest destination already exists".to_owned());
    }
    let mut value: Value = serde_json::from_slice(&original).map_err(|error| error.to_string())?;
    if let Some(path) = value.pointer("/cover/relativePath").and_then(Value::as_str) {
        if let Some(tail) = path.strip_prefix(".ambd/assets/") {
            value["cover"]["relativePath"] = json!(format!("assets/{tail}"));
        }
    }
    let mut templates = parsed.value.templates()?;
    let mut views = parsed.value.views.clone();
    let mut files = vec![FileBackup {
        source: relative(vault, &source)?,
        revision: raw_revision(&original),
        destination: Some(relative(vault, &destination)?),
        destination_existed: destination == source,
    }];
    let mut originals = vec![Some(original)];
    for (directory, template) in [("templates", true), ("views", false)] {
        for path in regular_files(&container.join(".ambd").join(directory))? {
            let path = checked(vault, &relative(vault, &path)?)?;
            let bytes = fs::read(&path).map_err(|error| error.to_string())?;
            ensure_lossless_numbers(&bytes)?;
            if template {
                let item = parse_template(&bytes).map_err(|error| error.to_string())?;
                if !item.is_writable() || item.value.database_id != parsed.value.database_id {
                    return Err("Legacy template cannot be safely converted".to_owned());
                }
                if templates
                    .iter()
                    .any(|old| old.template_id == item.value.template_id)
                {
                    return Err("Duplicate legacy template identity".to_owned());
                }
                templates.push(item.value);
            } else {
                let item = parse_view(&bytes).map_err(|error| error.to_string())?;
                if !item.is_writable() || item.value.database_id != parsed.value.database_id {
                    return Err("Legacy view cannot be safely converted".to_owned());
                }
                if views.iter().any(|old| old.view_id == item.value.view_id) {
                    return Err("Duplicate legacy view identity".to_owned());
                }
                views.push(item.value);
            }
            files.push(FileBackup {
                source: relative(vault, &path)?,
                revision: raw_revision(&bytes),
                destination: None,
                destination_existed: false,
            });
            originals.push(Some(bytes));
        }
    }
    for path in regular_files(&container.join(".ambd/assets"))? {
        let path = checked(vault, &relative(vault, &path)?)?;
        if fs::metadata(&path)
            .map_err(|error| error.to_string())?
            .len()
            > crate::bundle::MAX_ATTACHMENT_FILE_SIZE
        {
            return Err("A legacy asset exceeds the supported size limit".to_owned());
        }
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        let tail = path
            .strip_prefix(container.join(".ambd/assets"))
            .map_err(|error| error.to_string())?;
        let target = checked(
            vault,
            &relative(vault, &container.join("assets").join(tail))?,
        )?;
        if target.exists() && fs::read(&target).map_err(|error| error.to_string())? != bytes {
            return Err("An asset destination contains different bytes".to_owned());
        }
        files.push(FileBackup {
            source: relative(vault, &path)?,
            revision: raw_revision(&bytes),
            destination: Some(relative(vault, &target)?),
            destination_existed: target.exists(),
        });
        originals.push(None);
    }
    value["formatVersion"] = json!(2);
    value["views"] = json!(views);
    value["templates"] = json!(templates);
    if !regular_files(&container.join(".ambd/assets"))?.is_empty() {
        if serde_json::to_string(&value)
            .map_err(|error| error.to_string())?
            .contains(".ambd/assets/")
        {
            return Err("Custom configuration links to legacy assets require review".to_owned());
        }
        for note in discover_vault(vault)?
            .notes
            .iter()
            .filter(|note| note.path.starts_with(container))
        {
            if fs::read_to_string(&note.path)
                .map_err(|error| error.to_string())?
                .contains(".ambd/assets/")
            {
                return Err("Custom Markdown links to legacy assets require review".to_owned());
            }
        }
    }
    let mut updated = serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?;
    updated.push(b'\n');
    if updated.len() > MAX_JSON_BYTES {
        return Err("Combined database configuration exceeds the size limit".to_owned());
    }
    let manifest = parse_manifest(&updated).map_err(|error| error.to_string())?;
    let validation = super::validation::validate_manifest(&manifest.value);
    if validation.read_only || !validation.errors.is_empty() {
        return Err("Combined database configuration is invalid".to_owned());
    }
    Ok(Plan {
        journal: Journal {
            version: 1,
            status: "inProgress".to_owned(),
            container: relative(vault, container)?,
            updated_revision: raw_revision(&updated),
            files,
        },
        originals,
        updated,
    })
}

fn save_journal(directory: &Path, journal: &Journal) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?;
    frontmatter::atomic_write_bytes(&directory.join("plan.json"), &bytes)
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn rollback(vault: &Path, directory: &Path, journal: &mut Journal) -> Result<(), String> {
    if journal.version != 1 || journal.files.is_empty() {
        return Err("Unsupported database layout journal".to_owned());
    }
    let container = checked(vault, &journal.container)?;
    // Validate every original and destination before restoring any of them.
    for (index, file) in journal.files.iter().enumerate() {
        let source = checked(vault, &file.source)?;
        if !source.starts_with(&container) {
            return Err("Layout journal source escapes its container".to_owned());
        }
        if index == 0 {
            if source.parent() != Some(container.as_path())
                || !super::discovery::is_manifest_file_candidate(&source)
            {
                return Err("Invalid manifest in layout journal".to_owned());
            }
        } else if !["templates", "views", "assets"]
            .iter()
            .any(|name| source.starts_with(container.join(".ambd").join(name)))
        {
            return Err("Invalid auxiliary source in layout journal".to_owned());
        }
        let backup = checked(
            vault,
            &relative(vault, &directory.join(format!("{index}.backup")))?,
        )?;
        let bytes = fs::read(backup).map_err(|error| error.to_string())?;
        if raw_revision(&bytes) != file.revision {
            return Err("Database layout backup is damaged".to_owned());
        }
        let current = read_optional(&source)?;
        if current.as_ref().is_some_and(|current| {
            raw_revision(current) != file.revision
                && !(index == 0
                    && file.destination.as_ref() == Some(&file.source)
                    && raw_revision(current) == journal.updated_revision)
        }) {
            return Err("Database changed after an interrupted conversion".to_owned());
        }
        if let Some(destination) = &file.destination {
            let destination = checked(vault, destination)?;
            if !destination.starts_with(&container) {
                return Err("Layout journal destination escapes its container".to_owned());
            }
            if (index == 0
                && (destination.parent() != Some(container.as_path())
                    || !super::discovery::is_manifest_file_candidate(&destination)))
                || (index > 0 && !destination.starts_with(container.join("assets")))
            {
                return Err("Invalid destination in layout journal".to_owned());
            }
            if destination != source {
                if let Some(current) = read_optional(&destination)? {
                    let expected = if index == 0 {
                        &journal.updated_revision
                    } else {
                        &file.revision
                    };
                    if raw_revision(&current) != *expected {
                        return Err("Database conversion destination was changed".to_owned());
                    }
                }
            }
        }
    }
    for (index, file) in journal.files.iter().enumerate() {
        let source = checked(vault, &file.source)?;
        let backup = checked(
            vault,
            &relative(vault, &directory.join(format!("{index}.backup")))?,
        )?;
        if index > 0 && file.destination.is_some() {
            if !source.exists() {
                frontmatter::atomic_copy_file_new(
                    &backup,
                    &source,
                    crate::bundle::MAX_ATTACHMENT_FILE_SIZE,
                )
                .map_err(|error| format!("Could not restore database asset: {error:?}"))?;
            }
        } else {
            let bytes = fs::read(backup).map_err(|error| error.to_string())?;
            frontmatter::atomic_write_bytes(&source, &bytes)?;
        }
        if !file.destination_existed {
            if let Some(destination) = &file.destination {
                let destination = checked(vault, destination)?;
                if destination != source && destination.exists() {
                    fs::remove_file(destination).map_err(|error| error.to_string())?;
                }
            }
        }
    }
    journal.status = "rolledBack".to_owned();
    save_journal(directory, journal)
}

fn prune_empty_directories(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    for entry in WalkDir::new(root).follow_links(false).contents_first(true) {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().is_dir() {
            continue;
        }
        match fs::remove_dir(entry.path()) {
            Ok(()) => {}
            // Unrecognised user files remain in their directory; only empty directories go.
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::DirectoryNotEmpty | std::io::ErrorKind::NotFound
                ) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

pub fn upgrade(vault: &Path) -> Result<LayoutStatus, String> {
    let root = checked(vault, JOURNALS)?;
    if root.exists() {
        for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
            let directory = entry.map_err(|error| error.to_string())?.path();
            let journal_path = checked(vault, &relative(vault, &directory.join("plan.json"))?)?;
            if !journal_path.exists() {
                continue;
            }
            let mut journal: Journal =
                serde_json::from_slice(&fs::read(journal_path).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
            if journal.status == "inProgress" {
                rollback(vault, &directory, &mut journal)?;
            }
        }
    }
    let discovery = discover_vault(vault)?;
    let mut plans = Vec::new();
    for database in discovery.databases {
        let parsed =
            parse_manifest(&fs::read(&database.manifest_path).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
        if parsed.value.format_version == 1 {
            plans.push(plan(vault, &database.container_path)?);
        }
    }
    // No vault file has changed until every database passed preflight.
    for mut plan in plans {
        let directory = root.join(ulid::Ulid::generate().to_string());
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        for (index, bytes) in plan.originals.iter().enumerate() {
            let backup = directory.join(format!("{index}.backup"));
            if let Some(bytes) = bytes {
                frontmatter::atomic_write_bytes_new(&backup, bytes).map_err(|error| {
                    format!("Could not publish database layout backup: {error:?}")
                })?;
            } else {
                let source = checked(vault, &plan.journal.files[index].source)?;
                frontmatter::atomic_copy_file_new(
                    &source,
                    &backup,
                    crate::bundle::MAX_ATTACHMENT_FILE_SIZE,
                )
                .map_err(|error| format!("Could not publish database asset backup: {error:?}"))?;
            }
            let bytes = fs::read(&backup).map_err(|error| error.to_string())?;
            if raw_revision(&bytes) != plan.journal.files[index].revision {
                return Err("Database source changed while its backup was copied".to_owned());
            }
        }
        save_journal(&directory, &plan.journal)?;
        let result = (|| {
            for file in &plan.journal.files {
                let bytes =
                    fs::read(checked(vault, &file.source)?).map_err(|error| error.to_string())?;
                if raw_revision(&bytes) != file.revision {
                    return Err("Database changed during conversion preflight".to_owned());
                }
            }
            for (index, file) in plan.journal.files.iter().enumerate().skip(1) {
                if let Some(destination) = &file.destination {
                    let path = checked(vault, destination)?;
                    if !file.destination_existed {
                        frontmatter::atomic_copy_file_new(
                            &directory.join(format!("{index}.backup")),
                            &path,
                            crate::bundle::MAX_ATTACHMENT_FILE_SIZE,
                        )
                        .map_err(|error| format!("Could not copy database asset: {error:?}"))?;
                    } else if raw_revision(&fs::read(&path).map_err(|error| error.to_string())?)
                        != file.revision
                    {
                        return Err(
                            "Database asset destination changed during conversion".to_owned()
                        );
                    }
                }
            }
            let file = &plan.journal.files[0];
            let destination = checked(
                vault,
                file.destination
                    .as_ref()
                    .ok_or("Manifest destination is missing")?,
            )?;
            if file.destination_existed {
                frontmatter::atomic_write_bytes(&destination, &plan.updated)?;
            } else {
                frontmatter::atomic_write_bytes_new(&destination, &plan.updated)
                    .map_err(|error| format!("Could not publish converted manifest: {error:?}"))?;
            }
            for (index, file) in plan.journal.files.iter().enumerate() {
                if index == 0 && file.destination.as_ref() == Some(&file.source) {
                    continue;
                }
                let source = checked(vault, &file.source)?;
                if raw_revision(&fs::read(&source).map_err(|error| error.to_string())?)
                    != file.revision
                {
                    return Err("Database source changed during conversion".to_owned());
                }
                fs::remove_file(source).map_err(|error| error.to_string())?;
            }
            prune_empty_directories(&checked(
                vault,
                &format!("{}/.ambd", plan.journal.container),
            )?)?;
            plan.journal.status = "completed".to_owned();
            save_journal(&directory, &plan.journal)
        })();
        if let Err(error) = result {
            plan.journal.status = "inProgress".to_owned();
            rollback(vault, &directory, &mut plan.journal).map_err(|rollback_error| {
                format!("{error}; rollback retained for review: {rollback_error}")
            })?;
            return Err(error);
        }
    }
    scan(vault)
}

#[cfg(test)]
mod tests;
