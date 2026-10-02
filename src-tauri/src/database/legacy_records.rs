//! One-way transfer of legacy `.ambd/records/<note-id>.json` values into note
//! frontmatter during legacy-database repair.
//!
//! Frontmatter is the source of truth, so a value already present in a note is
//! never overwritten by a shard. A shard is only taken out of `records/` after
//! its note was readable, snapshotted and written; it is then moved (never
//! deleted) to `.ambd/legacy-records/`, so values that could not be converted,
//! conflicting values and YAML sync bases stay recoverable. A shard whose note
//! is missing or that cannot be read stays where it is.

use std::fs;
use std::path::{Path, PathBuf};

use super::format::{
    property_value_to_frontmatter_value, resolve_property_yaml_value, PropertyDefinition,
    PropertyValue,
};
use crate::frontmatter;

const ARCHIVE_DIR: &str = ".ambd/legacy-records";

/// Returns true when at least one shard left `records/`.
pub(super) fn migrate_container_records(
    vault: &Path,
    dir: &Path,
    properties: &[PropertyDefinition],
) -> bool {
    let records_dir = dir.join(".ambd").join("records");
    let Ok(entries) = fs::read_dir(&records_dir) else {
        return false;
    };
    let mut changed = false;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if migrate_record(vault, dir, properties, &path, stem) && archive_shard(dir, &path) {
            changed = true;
        }
    }
    // Only succeeds when the directory is empty; retained shards keep it alive.
    let _ = fs::remove_dir(&records_dir);
    changed
}

/// True when every value of the shard is now safe in the note (or archived).
fn migrate_record(
    vault: &Path,
    dir: &Path,
    properties: &[PropertyDefinition],
    shard_path: &Path,
    note_id: &str,
) -> bool {
    let Ok(bytes) = fs::read(shard_path) else {
        return false;
    };
    let Ok(shard) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    let Some(note_path) = crate::database::mutations::resolve_note_path_for_id(vault, dir, note_id)
        .ok()
        .or_else(|| {
            let candidate = dir.join(format!("{note_id}.md"));
            candidate.is_file().then_some(candidate)
        })
    else {
        return false;
    };
    let Ok(original) = fs::read(&note_path) else {
        return false;
    };
    let Ok(original_text) = String::from_utf8(original.clone()) else {
        return false;
    };

    let mut content = original_text.clone();
    if frontmatter::frontmatter_yaml_mapping(&content)
        .ok()
        .flatten()
        .is_none()
    {
        content = format!("---\namby-id: {note_id}\n---\n{content}");
    } else if frontmatter::read_markdown(&note_path)
        .ok()
        .and_then(|parsed| parsed.id)
        .as_deref()
        != Some(note_id)
    {
        if let Ok(updated) = frontmatter::replace_yaml_binding_lossless(
            &content,
            "amby-id",
            &serde_yaml::Value::String(note_id.to_owned()),
        ) {
            content = updated;
        }
    }

    if let Some(values) = shard.get("values").and_then(|values| values.as_object()) {
        for (property_id, raw) in values {
            let Some(property) = properties
                .iter()
                .find(|property| property.id() == Some(property_id.as_str()))
            else {
                continue;
            };
            let Some(key) = property.frontmatter_key().or_else(|| property.name()) else {
                continue;
            };
            let has_value = frontmatter::frontmatter_yaml_mapping(&content)
                .ok()
                .flatten()
                .is_some_and(|mapping| resolve_property_yaml_value(&mapping, property).is_some());
            if has_value {
                continue;
            }
            let Ok(value) = serde_json::from_value::<PropertyValue>(raw.clone()) else {
                continue;
            };
            let Some(yaml) = property_value_to_frontmatter_value(&value, property) else {
                continue;
            };
            if let Ok(next) = frontmatter::replace_yaml_binding_lossless(&content, key, &yaml) {
                content = next;
            }
        }
    }

    if content == original_text {
        return true;
    }
    if crate::history::snapshot_before_write(
        vault,
        &note_path,
        content.as_bytes(),
        "database-value",
    )
    .is_err()
    {
        return false;
    }
    // The note must still be what was read; otherwise leave the shard for the
    // next run instead of overwriting a concurrent edit.
    if fs::read(&note_path).ok().as_deref() != Some(original.as_slice()) {
        return false;
    }
    frontmatter::atomic_write_bytes(&note_path, content.as_bytes()).is_ok()
}

fn archive_shard(dir: &Path, shard_path: &Path) -> bool {
    let archive = dir.join(ARCHIVE_DIR);
    if fs::create_dir_all(&archive).is_err() {
        return false;
    }
    let name = shard_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut target: PathBuf = archive.join(&name);
    let mut suffix = 1u32;
    while target.exists() {
        target = archive.join(format!("{name}.{suffix}"));
        suffix += 1;
    }
    fs::rename(shard_path, target).is_ok()
}

#[cfg(test)]
#[path = "legacy_records_test.rs"]
mod tests;
