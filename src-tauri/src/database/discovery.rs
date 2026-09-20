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
    DatabaseManifest, FormatError, PropertyDefinition, PropertyValue, parse_manifest, parse_record,
    parse_template, parse_view,
};
use super::validation::{validate_manifest, validate_record};
use crate::frontmatter;
use crate::paths;

pub const LEGACY_DATABASE_MANIFEST: &str = "ambd.json";
#[allow(dead_code)]
pub const DATABASE_MANIFEST: &str = LEGACY_DATABASE_MANIFEST;

/// Returns true if a path is a candidate for a database manifest:
/// either `ambd.json`, or `<container_name>.json`, or `<container_name>.database`.
pub fn is_manifest_file_candidate(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if file_name == LEGACY_DATABASE_MANIFEST {
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
/// 3. `ambd.json` (legacy)
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
    let legacy = container.join(LEGACY_DATABASE_MANIFEST);
    if legacy.is_file() {
        return Some(legacy);
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

const SERVICE_DIRECTORIES: &[&str] = &[".amby", ".obsidian", ".git", ".trash", "assets", ".ambd"];

fn create_default_view_value(database_id: &str, view_id: &str) -> serde_json::Value {
    serde_json::json!({
        "format": "amby-database-view",
        "formatVersion": 1,
        "databaseId": database_id,
        "viewId": view_id,
        "name": "Table",
        "layout": "table",
        "openMode": "sidePeek",
        "subitemsMode": "nested",
        "density": "default",
        "fields": [{"field": {"kind": "system", "field": "title"}, "visible": true, "width": null, "frozen": true}],
        "filter": null,
        "sorts": [{"field": {"kind": "system", "field": "title"}, "direction": "asc", "nulls": "last"}],
        "group": null,
        "aggregates": []
    })
}

fn normalize_view_value(
    mut val: serde_json::Value,
    database_id: &str,
    view_id: &str,
) -> (serde_json::Value, bool) {
    let mut changed = false;
    if val.get("format").and_then(|v| v.as_str()) != Some("amby-database-view") {
        val["format"] = serde_json::Value::String("amby-database-view".to_string());
        changed = true;
    }
    if val.get("formatVersion").and_then(|v| v.as_u64()) != Some(1) {
        val["formatVersion"] = serde_json::json!(1);
        changed = true;
    }
    if val.get("databaseId").and_then(|v| v.as_str()) != Some(database_id) {
        val["databaseId"] = serde_json::Value::String(database_id.to_string());
        changed = true;
    }
    if val.get("viewId").and_then(|v| v.as_str()) != Some(view_id) {
        val["viewId"] = serde_json::Value::String(view_id.to_string());
        changed = true;
    }
    if val
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .unwrap_or("")
        .is_empty()
    {
        val["name"] = serde_json::Value::String("Table".to_string());
        changed = true;
    }
    if val.get("layout").and_then(|v| v.as_str()).is_none() {
        val["layout"] = serde_json::Value::String("table".to_string());
        changed = true;
    }
    if val.get("openMode").and_then(|v| v.as_str()).is_none() {
        val["openMode"] = serde_json::Value::String("sidePeek".to_string());
        changed = true;
    }
    if val.get("subitemsMode").and_then(|v| v.as_str()).is_none() {
        val["subitemsMode"] = serde_json::Value::String("nested".to_string());
        changed = true;
    }
    if val.get("density").and_then(|v| v.as_str()).is_none() {
        val["density"] = serde_json::Value::String("default".to_string());
        changed = true;
    }
    let fields_empty = val
        .get("fields")
        .and_then(|v| v.as_array())
        .is_none_or(|arr| arr.is_empty());
    if fields_empty {
        val["fields"] = serde_json::json!([{
            "field": {"kind": "system", "field": "title"},
            "visible": true,
            "width": null,
            "frozen": true
        }]);
        changed = true;
    }
    if val.get("sorts").and_then(|v| v.as_array()).is_none() {
        val["sorts"] = serde_json::json!([]);
        changed = true;
    }
    (val, changed)
}

fn repair_container_shards(
    vault: &Path,
    dir: &Path,
    database_id: &str,
    manifest_val: &mut serde_json::Value,
    view_order_ids: &mut Vec<String>,
) -> bool {
    let mut changed = false;

    // 1. Repair and reconcile existing views into manifest_val["views"]
    let views_dir = dir.join(".ambd").join("views");
    let mut views_list: Vec<serde_json::Value> = manifest_val
        .get("views")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if let Ok(entries) = fs::read_dir(&views_dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if ulid::Ulid::from_string(stem).is_err() {
                continue;
            }
            if let Ok(bytes) = fs::read(&path) {
                if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    let (normalized, _) = normalize_view_value(val, database_id, stem);
                    if let Some(pos) = views_list
                        .iter()
                        .position(|v| v.get("viewId").and_then(|id| id.as_str()) == Some(stem))
                    {
                        views_list[pos] = normalized;
                    } else {
                        views_list.push(normalized);
                    }
                    if !view_order_ids.iter().any(|id| id == stem) {
                        view_order_ids.push(stem.to_string());
                    }
                    changed = true;
                }
            }
            let _ = fs::remove_file(&path);
        }
        let _ = fs::remove_dir(&views_dir);
    }

    for v in &mut views_list {
        let view_id = v
            .get("viewId")
            .and_then(|id| id.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| ulid::Ulid::generate().to_string());
        let (norm, v_changed) = normalize_view_value(v.clone(), database_id, &view_id);
        if v_changed {
            *v = norm;
            changed = true;
        }
    }

    for view_id in view_order_ids.iter() {
        if !views_list
            .iter()
            .any(|v| v.get("viewId").and_then(|id| id.as_str()) == Some(view_id))
        {
            views_list.push(create_default_view_value(database_id, view_id));
            changed = true;
        }
    }

    if views_list.is_empty() {
        let default_view_id = view_order_ids
            .first()
            .cloned()
            .unwrap_or_else(|| ulid::Ulid::generate().to_string());
        if !view_order_ids.contains(&default_view_id) {
            view_order_ids.push(default_view_id.clone());
        }
        views_list.push(create_default_view_value(database_id, &default_view_id));
        changed = true;
    }

    for view in &views_list {
        if let Some(vid) = view.get("viewId").and_then(|v| v.as_str()) {
            if !view_order_ids.iter().any(|id| id == vid) {
                view_order_ids.push(vid.to_string());
                changed = true;
            }
        }
    }

    let views_json = serde_json::json!(views_list);
    if manifest_val.get("views") != Some(&views_json) {
        manifest_val["views"] = views_json;
        changed = true;
    }

    // 2. Migrate legacy records from .ambd/records into note frontmatter
    let records_dir = dir.join(".ambd").join("records");
    if records_dir.is_dir() {
        let properties: Vec<PropertyDefinition> = manifest_val
            .get("properties")
            .and_then(|p| serde_json::from_value(p.clone()).ok())
            .unwrap_or_default();

        if let Ok(entries) = fs::read_dir(&records_dir) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("json")
                {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                if let Ok(bytes) = fs::read(&path) {
                    if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        let note_path =
                            crate::database::mutations::resolve_note_path_for_id(vault, dir, stem)
                                .ok()
                                .or_else(|| {
                                    let candidate = dir.join(format!("{stem}.md"));
                                    if candidate.is_file() {
                                        Some(candidate)
                                    } else {
                                        None
                                    }
                                });
                        if let Some(note_path) = note_path {
                            if let Ok(mut content) = fs::read_to_string(&note_path) {
                                let mut note_changed = false;
                                if frontmatter::frontmatter_yaml_mapping(&content)
                                    .ok()
                                    .flatten()
                                    .is_none()
                                {
                                    content = format!("---\namby-id: {stem}\n---\n{content}");
                                    note_changed = true;
                                } else if frontmatter::read_markdown(&note_path)
                                    .ok()
                                    .and_then(|p| p.id)
                                    .as_deref()
                                    != Some(stem)
                                {
                                    if let Ok(updated) = frontmatter::replace_yaml_binding_lossless(
                                        &content,
                                        "amby-id",
                                        &serde_yaml::Value::String(stem.to_string()),
                                    ) {
                                        if updated != content {
                                            content = updated;
                                            note_changed = true;
                                        }
                                    }
                                }
                                if let Some(values_obj) =
                                    val.get("values").and_then(|v| v.as_object())
                                {
                                    for (prop_id, val_json) in values_obj {
                                        if let Some(prop_def) = properties
                                            .iter()
                                            .find(|p| p.id() == Some(prop_id.as_str()))
                                        {
                                            if let Some(prop_name) = prop_def
                                                .frontmatter_key()
                                                .or_else(|| prop_def.name())
                                            {
                                                if let Ok(prop_val) =
                                                    serde_json::from_value::<PropertyValue>(
                                                        val_json.clone(),
                                                    )
                                                {
                                                    if let Some(fm_val) =
                                                        super::format::property_value_to_frontmatter_value(
                                                            &prop_val, prop_def,
                                                        )
                                                    {
                                                        if let Ok(next) =
                                                            frontmatter::replace_yaml_binding_lossless(
                                                                &content,
                                                                prop_name,
                                                                &fm_val,
                                                            )
                                                        {
                                                            if next != content {
                                                                content = next;
                                                                note_changed = true;
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                if note_changed {
                                    let _ = frontmatter::atomic_write_bytes(
                                        &note_path,
                                        content.as_bytes(),
                                    );
                                }
                            }
                        }
                    }
                }
                let _ = fs::remove_file(&path);
                changed = true;
            }
        }
        let _ = fs::remove_dir(&records_dir);
    }

    // 3. Repair all templates in .ambd/templates
    let templates_dir = dir.join(".ambd").join("templates");
    if let Ok(entries) = fs::read_dir(&templates_dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if let Ok(bytes) = fs::read(&path) {
                if let Ok(mut val) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    let mut template_changed = false;
                    if val.get("format").and_then(|v| v.as_str()) != Some("amby-database-template")
                    {
                        val["format"] =
                            serde_json::Value::String("amby-database-template".to_string());
                        template_changed = true;
                    }
                    if val.get("formatVersion").and_then(|v| v.as_u64()) != Some(1) {
                        val["formatVersion"] = serde_json::json!(1);
                        template_changed = true;
                    }
                    if val.get("databaseId").and_then(|v| v.as_str()) != Some(database_id) {
                        val["databaseId"] = serde_json::Value::String(database_id.to_string());
                        template_changed = true;
                    }
                    if val.get("templateId").and_then(|v| v.as_str()) != Some(stem) {
                        val["templateId"] = serde_json::Value::String(stem.to_string());
                        template_changed = true;
                    }
                    if template_changed {
                        if let Ok(new_bytes) = serde_json::to_vec_pretty(&val) {
                            let _ = frontmatter::atomic_write_bytes(&path, &new_bytes);
                        }
                    }
                }
            }
        }
    }

    // 4. Do not remove .ambd/recovery: recovery data must be preserved.
    let ambd_dir = dir.join(".ambd");
    if ambd_dir.is_dir() {
        let _ = fs::remove_dir(&ambd_dir); // Only succeeds if .ambd is truly empty
    }

    changed
}

/// Migrates and repairs any legacy database manifests in a vault:
/// 1. Finds directories with `ambd.json`, `<container_name>.json`, or `.ambd`.
/// 2. Ensures `format: "amby-database"`, `formatVersion: 1`, and valid ULID `databaseId`.
/// 3. Normalizes `membership: {"kind": "filesystem-descendants", "recursive": true}`.
/// 4. Sets `containerKind` to `"attached"` if `<container_name>.md` exists, else `"standalone"`.
/// 5. Ensures `.ambd/views/` exists and has at least one valid view file matching `viewOrder`.
/// 6. Migrates to `<container_name>.json` atomically and deletes stale `ambd.json`.
#[allow(dead_code)]
pub fn migrate_legacy_database_manifests(vault: &Path) -> Result<usize, String> {
    let mut count = 0;
    for entry in WalkDir::new(vault)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| {
            if !e.file_type().is_dir() {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            !SERVICE_DIRECTORIES.contains(&name.as_ref())
        })
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_dir() {
            continue;
        }
        let dir = entry.path();
        let Some(name) = dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let named_json = dir.join(format!("{name}.json"));
        let named_database = dir.join(format!("{name}.database"));
        let legacy_json = dir.join(LEGACY_DATABASE_MANIFEST);
        let ambd_dir = dir.join(".ambd");

        let has_database = legacy_json.is_file()
            || named_json.is_file()
            || named_database.is_file()
            || ambd_dir.is_dir();

        if !has_database {
            continue;
        }

        let mut raw_manifest_bytes: Option<Vec<u8>> = None;
        let mut existing_manifest_path: Option<PathBuf> = None;
        if named_json.is_file() {
            if let Ok(bytes) = fs::read(&named_json) {
                raw_manifest_bytes = Some(bytes);
                existing_manifest_path = Some(named_json.clone());
            }
        } else if named_database.is_file() {
            if let Ok(bytes) = fs::read(&named_database) {
                raw_manifest_bytes = Some(bytes);
                existing_manifest_path = Some(named_database.clone());
            }
        } else if legacy_json.is_file() {
            if let Ok(bytes) = fs::read(&legacy_json) {
                raw_manifest_bytes = Some(bytes);
                existing_manifest_path = Some(legacy_json.clone());
            }
        }

        let is_canonical_json = existing_manifest_path.as_ref() == Some(&named_json);
        let has_legacy_shards =
            ambd_dir.join("records").is_dir() || ambd_dir.join("views").is_dir();
        if is_canonical_json
            && !has_legacy_shards
            && !named_database.is_file()
            && !legacy_json.is_file()
        {
            if let Some(ref bytes) = raw_manifest_bytes {
                if let Ok(parsed) = parse_manifest(bytes) {
                    if validate_manifest(&parsed.value).errors.is_empty()
                        && !parsed.value.views.is_empty()
                    {
                        continue;
                    }
                }
            }
        }

        let mut value = match raw_manifest_bytes
            .as_deref()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(b).ok())
        {
            Some(v) => v,
            None => {
                if raw_manifest_bytes.is_some() || !ambd_dir.is_dir() {
                    continue;
                }
                serde_json::json!({})
            }
        };

        // Determine if this is a database
        let is_db = legacy_json.is_file()
            || ambd_dir.is_dir()
            || value.get("format").and_then(|v| v.as_str()) == Some("amby-database")
            || value.get("databaseId").is_some()
            || value.get("properties").is_some();

        if !is_db {
            continue;
        }

        let mut manifest_changed = false;

        // Ensure "format": "amby-database"
        if value.get("format").and_then(|v| v.as_str()) != Some("amby-database") {
            value["format"] = serde_json::Value::String("amby-database".to_string());
            manifest_changed = true;
        }

        // Ensure "formatVersion": 1
        if value.get("formatVersion").and_then(|v| v.as_u64()) != Some(1) {
            value["formatVersion"] = serde_json::json!(1);
            manifest_changed = true;
        }

        // Ensure "databaseId" is valid ULID
        let valid_db_id = value
            .get("databaseId")
            .and_then(|v| v.as_str())
            .filter(|s| ulid::Ulid::from_string(s).is_ok())
            .map(|s| s.to_string());
        let database_id = match valid_db_id {
            Some(id) => id,
            None => {
                let new_id = ulid::Ulid::generate().to_string();
                value["databaseId"] = serde_json::Value::String(new_id.clone());
                manifest_changed = true;
                new_id
            }
        };

        // Ensure "name"
        let current_name = value
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty());
        if current_name.is_none() {
            value["name"] = serde_json::Value::String(name.to_string());
            manifest_changed = true;
        }

        // Ensure "containerKind"
        let has_attached_note = dir.join(format!("{name}.md")).is_file();
        let expected_kind = if has_attached_note {
            "attached"
        } else {
            "standalone"
        };
        if value.get("containerKind").and_then(|v| v.as_str()) != Some(expected_kind) {
            value["containerKind"] = serde_json::Value::String(expected_kind.to_string());
            manifest_changed = true;
        }

        // Ensure "locked"
        if !value.get("locked").is_some_and(|v| v.is_boolean()) {
            value["locked"] = serde_json::Value::Bool(false);
            manifest_changed = true;
        }

        // Ensure "membership"
        let valid_membership = value
            .get("membership")
            .and_then(|v| v.as_object())
            .is_some_and(|obj| {
                obj.get("kind").and_then(|k| k.as_str()) == Some("filesystem-descendants")
                    && obj.get("recursive").and_then(|r| r.as_bool()) == Some(true)
            });
        if !valid_membership {
            value["membership"] = serde_json::json!({
                "kind": "filesystem-descendants",
                "recursive": true,
            });
            manifest_changed = true;
        }

        // Ensure "properties"
        if !value.get("properties").is_some_and(|v| v.is_array()) {
            value["properties"] = serde_json::json!([]);
            manifest_changed = true;
        }

        // Ensure "templateOrder"
        if !value.get("templateOrder").is_some_and(|v| v.is_array()) {
            value["templateOrder"] = serde_json::json!([]);
            manifest_changed = true;
        }

        // Normalize viewOrder and defaultViewId
        let mut view_order_ids: Vec<String> = value
            .get("viewOrder")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .filter(|s| ulid::Ulid::from_string(s).is_ok())
                    .map(|s| s.to_string())
                    .collect()
            })
            .unwrap_or_default();

        let shards_changed =
            repair_container_shards(vault, dir, &database_id, &mut value, &mut view_order_ids);
        if shards_changed {
            manifest_changed = true;
        }

        if !view_order_ids.is_empty() {
            let new_view_order_json = serde_json::json!(view_order_ids);
            if value.get("viewOrder") != Some(&new_view_order_json) {
                value["viewOrder"] = new_view_order_json;
                manifest_changed = true;
            }

            let default_view_id = value
                .get("defaultViewId")
                .and_then(|v| v.as_str())
                .filter(|id| view_order_ids.contains(&id.to_string()))
                .map(|s| s.to_string())
                .unwrap_or_else(|| view_order_ids[0].clone());
            if value.get("defaultViewId").and_then(|v| v.as_str()) != Some(&default_view_id) {
                value["defaultViewId"] = serde_json::Value::String(default_view_id);
                manifest_changed = true;
            }
        }

        let target_manifest_path = named_json.clone();
        let needs_write = manifest_changed || !target_manifest_path.is_file();
        if needs_write {
            if let Ok(new_bytes) = serde_json::to_vec_pretty(&value) {
                if frontmatter::atomic_write_bytes(&target_manifest_path, &new_bytes).is_ok() {
                    count += 1;
                }
            }
        }
        if named_database.is_file() {
            let _ = fs::remove_file(&named_database);
        }
        if legacy_json.is_file() {
            let _ = fs::remove_file(&legacy_json);
        }
    }
    Ok(count)
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

        let is_legacy =
            path.file_name().and_then(|name| name.to_str()) == Some(LEGACY_DATABASE_MANIFEST);

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
                if is_legacy {
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

        if !is_legacy && !bytes.windows(15).any(|w| w == b"\"amby-database\"") {
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
            if !is_legacy {
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
    !name.starts_with('.') && !SERVICE_DIRECTORIES.contains(&name.as_ref())
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
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    const OUTER_ID: &str = "01J00000000000000000000000";
    const INNER_ID: &str = "01J00000000000000000000001";
    const FIRST_NOTE_ID: &str = "01J00000000000000000000002";
    const SECOND_NOTE_ID: &str = "01J00000000000000000000003";

    fn temp_vault(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("amby-discovery-{name}-{nanos}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_manifest(root: &Path, id: &str, name: &str) {
        fs::create_dir_all(root).unwrap();
        fs::write(
            root.join(DATABASE_MANIFEST),
            serde_json::to_vec_pretty(&json!({
                "format": "amby-database",
                "formatVersion": 1,
                "databaseId": id,
                "name": name,
                "locked": false,
                "membership": {"kind": "filesystem-descendants", "recursive": true},
                "properties": [],
                "viewOrder": [],
                "defaultViewId": null,
                "templateOrder": [],
                "defaultTemplateId": null
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn write_note(path: &Path, id: &str, title: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, format!("---\namby-id: {id}\n---\n# {title}\n")).unwrap();
    }

    fn note<'a>(result: &'a DiscoveryResult, path: &str) -> &'a DiscoveredNote {
        result
            .notes
            .iter()
            .find(|note| note.relative_path == path)
            .unwrap()
    }

    fn has_code(result: &DiscoveryResult, code: DiagnosticCode) -> bool {
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == code)
    }

    #[test]
    fn discovers_attached_and_standalone_ownership_and_categories() {
        let vault = temp_vault("ownership");
        let attached = vault.join("Characters");
        let standalone = vault.join("Tasks");
        write_manifest(&attached, OUTER_ID, "Characters");
        write_manifest(&standalone, INNER_ID, "Tasks");
        write_note(
            &attached.join("Characters.md"),
            FIRST_NOTE_ID,
            "Database page",
        );
        write_note(&attached.join("Alice.md"), SECOND_NOTE_ID, "Alice");
        write_note(&attached.join("Category/Bob.md"), OUTER_ID, "Bob");
        write_note(&standalone.join("Task.md"), FIRST_NOTE_ID, "Task");

        let result = discover_vault(&vault).unwrap();
        assert_eq!(result.databases.len(), 2);
        assert_eq!(result.databases[0].kind, ContainerKind::Attached);
        assert_eq!(result.databases[1].kind, ContainerKind::Standalone);
        assert_eq!(
            note(&result, "Characters/Characters.md").owner_database_id,
            None
        );
        assert_eq!(
            note(&result, "Characters/Alice.md")
                .owner_database_id
                .as_deref(),
            Some(OUTER_ID)
        );
        assert_eq!(
            note(&result, "Characters/Category/Bob.md").category_path,
            vec!["Category"]
        );
        assert_eq!(
            note(&result, "Tasks/Task.md").owner_database_id.as_deref(),
            Some(INNER_ID)
        );
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn nearest_nested_database_owns_subtree_but_attached_main_stays_outer() {
        let vault = temp_vault("nested");
        let outer = vault.join("Outer");
        let inner = outer.join("Inner");
        write_manifest(&outer, OUTER_ID, "Outer");
        write_manifest(&inner, INNER_ID, "Inner");
        write_note(&inner.join("Inner.md"), FIRST_NOTE_ID, "Inner database");
        write_note(&inner.join("Child.md"), SECOND_NOTE_ID, "Child");

        let result = discover_vault(&vault).unwrap();
        assert_eq!(
            note(&result, "Outer/Inner/Inner.md")
                .owner_database_id
                .as_deref(),
            Some(OUTER_ID)
        );
        assert_eq!(
            note(&result, "Outer/Inner/Child.md")
                .owner_database_id
                .as_deref(),
            Some(INNER_ID)
        );
        assert_eq!(
            note(&result, "Outer/Inner/Child.md")
                .parent_note_id
                .as_deref(),
            Some(FIRST_NOTE_ID)
        );
        assert_eq!(note(&result, "Outer/Inner/Child.md").depth, 1);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn corrupt_nested_manifest_is_a_hard_boundary() {
        let vault = temp_vault("broken-nested");
        let outer = vault.join("Outer");
        let inner = outer.join("Inner");
        write_manifest(&outer, OUTER_ID, "Outer");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join(DATABASE_MANIFEST), b"{not-json").unwrap();
        write_note(&inner.join("Child.md"), FIRST_NOTE_ID, "Child");

        let result = discover_vault(&vault).unwrap();
        assert_eq!(result.databases.len(), 1);
        assert_eq!(
            note(&result, "Outer/Inner/Child.md").owner_database_id,
            None
        );
        assert!(has_code(&result, DiagnosticCode::BrokenManifest));
        assert!(has_code(&result, DiagnosticCode::NestedBoundary));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn duplicate_ids_titles_and_excluded_service_directories_are_visible() {
        let vault = temp_vault("diagnostics");
        write_manifest(&vault.join("One"), OUTER_ID, "Same");
        write_manifest(&vault.join("Two"), OUTER_ID, "Same");
        write_note(&vault.join("One/A.md"), FIRST_NOTE_ID, "Same note");
        write_note(&vault.join("One/B.md"), FIRST_NOTE_ID, "Same note");
        for directory in SERVICE_DIRECTORIES {
            let hidden = vault.join(directory).join("Hidden.md");
            if let Some(parent) = hidden.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(hidden, "# Hidden").unwrap();
        }

        let result = discover_vault(&vault).unwrap();
        assert_eq!(
            result
                .notes
                .iter()
                .filter(|note| note.relative_path.contains("Hidden"))
                .count(),
            0
        );
        assert!(has_code(&result, DiagnosticCode::DuplicateDatabaseId));
        assert!(has_code(&result, DiagnosticCode::DuplicateDatabaseTitle));
        assert!(has_code(&result, DiagnosticCode::DuplicateNoteId));
        assert!(has_code(&result, DiagnosticCode::DuplicateNoteTitle));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn orphan_record_shard_and_missing_view_are_diagnosed() {
        let vault = temp_vault("shards");
        let database = vault.join("Database");
        write_manifest(&database, OUTER_ID, "Database");
        write_note(&database.join("Known.md"), FIRST_NOTE_ID, "Known");
        let records = database.join(".ambd/records");
        fs::create_dir_all(&records).unwrap();
        fs::write(
            records.join(format!("{SECOND_NOTE_ID}.json")),
            serde_json::to_vec_pretty(&json!({
                "format": "amby-database-record",
                "formatVersion": 1,
                "databaseId": OUTER_ID,
                "noteId": SECOND_NOTE_ID,
                "values": {}
            }))
            .unwrap(),
        )
        .unwrap();
        let manifest_path = database.join(DATABASE_MANIFEST);
        let mut manifest =
            serde_json::from_slice::<serde_json::Value>(&fs::read(&manifest_path).unwrap())
                .unwrap();
        manifest["viewOrder"] = json!([INNER_ID]);
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let result = discover_vault(&vault).unwrap();
        assert!(has_code(&result, DiagnosticCode::OrphanShard));
        assert!(has_code(&result, DiagnosticCode::MissingShard));
        fs::remove_dir_all(vault).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_diagnosed_without_following_the_link() {
        use std::os::unix::fs::symlink;

        let vault = temp_vault("symlink");
        let outside = temp_vault("symlink-outside");
        write_manifest(&vault.join("Database"), OUTER_ID, "Database");
        write_note(&outside.join("Secret.md"), FIRST_NOTE_ID, "Secret");
        symlink(&outside, vault.join("Database/.ambd")).unwrap();
        let result = discover_vault(&vault).unwrap();
        assert!(has_code(&result, DiagnosticCode::SymlinkEscape));
        assert!(
            result
                .notes
                .iter()
                .all(|note| !note.relative_path.contains("Secret"))
        );
        fs::remove_dir_all(vault).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn named_manifest_database_is_discovered_and_preferred_over_legacy() {
        let vault = temp_vault("named-manifest");
        let db_dir = vault.join("Projects");
        fs::create_dir_all(&db_dir).unwrap();

        // 1. Named manifest
        let manifest = json!({
            "format": "amby-database",
            "formatVersion": 1,
            "databaseId": OUTER_ID,
            "name": "Projects",
            "locked": false,
            "membership": {"kind": "filesystem-descendants", "recursive": true},
            "properties": [],
            "viewOrder": [],
            "defaultViewId": null,
            "templateOrder": [],
            "defaultTemplateId": null,
        });
        fs::write(
            db_dir.join("Projects.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        // 2. An unrelated JSON file in another folder
        let config_dir = vault.join("Config");
        fs::create_dir_all(&config_dir).unwrap();
        fs::write(config_dir.join("Config.json"), b"{\"unrelated\": true}").unwrap();

        let result = discover_vault(&vault).unwrap();
        assert_eq!(result.databases.len(), 1);
        let db = &result.databases[0];
        assert_eq!(db.database_id, OUTER_ID);
        assert_eq!(db.name, "Projects");
        assert_eq!(
            db.manifest_path,
            vault.canonicalize().unwrap().join("Projects/Projects.json")
        );
        assert!(result.diagnostics.is_empty());

        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn migrates_and_repairs_legacy_database_manifest() {
        let vault = temp_vault("migrate-legacy-db");
        let db_dir = vault.join("Tasks");
        fs::create_dir_all(&db_dir).unwrap();
        let legacy_manifest = json!({
            "format": "amby-database",
            "databaseId": "invalid-non-ulid",
            "name": "Tasks",
            "properties": "not-an-array",
        });
        fs::write(
            db_dir.join("Tasks.json"),
            serde_json::to_vec_pretty(&legacy_manifest).unwrap(),
        )
        .unwrap();

        let migrated = migrate_legacy_database_manifests(&vault).unwrap();
        assert_eq!(migrated, 1);
        assert!(db_dir.join("Tasks.json").exists());

        let content: serde_json::Value =
            serde_json::from_slice(&fs::read(db_dir.join("Tasks.json")).unwrap()).unwrap();
        assert_eq!(content["containerKind"], "standalone");
        assert_eq!(content["name"], "Tasks");
        assert_eq!(content["formatVersion"], 1);
        assert!(content["properties"].is_array());
        assert!(ulid::Ulid::from_string(content["databaseId"].as_str().unwrap()).is_ok());

        let migrated_again = migrate_legacy_database_manifests(&vault).unwrap();
        assert_eq!(migrated_again, 0);

        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn migrate_legacy_database_manifests_reconciles_shard_database_ids() {
        let vault = temp_vault("shard_reconcile");
        let db_dir = vault.join("PaLooVerse");
        fs::create_dir_all(db_dir.join(".ambd/views")).unwrap();
        fs::create_dir_all(db_dir.join(".ambd/records")).unwrap();

        let manifest_id = "01M2NKEGMJY9YHDNTV6HNWDFE6";
        let view_id = "01M1PTZSVFN6EZA2H7ENZ1CSB9";
        let note_id = "01M1Q23EBJDZNPWBC01W513DS0";
        let old_db_id = "01M1PTZSVFTGA864YBJP7TJKXN";

        let manifest = serde_json::json!({
            "format": "amby-database",
            "formatVersion": 1,
            "databaseId": manifest_id,
            "name": "PaLooVerse",
            "containerKind": "standalone",
            "locked": false,
            "membership": {
                "kind": "filesystem-descendants",
                "recursive": true
            },
            "properties": [],
            "viewOrder": [view_id],
            "defaultViewId": view_id,
            "templateOrder": []
        });
        fs::write(
            db_dir.join("PaLooVerse.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let old_view = serde_json::json!({
            "format": "amby-database-view",
            "formatVersion": 1,
            "databaseId": old_db_id,
            "viewId": view_id,
            "name": "Table",
            "layout": "table",
            "openMode": "sidePeek",
            "subitemsMode": "nested",
            "density": "default",
            "fields": [{"field": {"kind": "system", "field": "title"}, "visible": true, "width": null, "frozen": true}],
            "filter": null,
            "sorts": [],
            "group": null,
            "aggregates": []
        });
        fs::write(
            db_dir.join(".ambd/views").join(format!("{view_id}.json")),
            serde_json::to_vec_pretty(&old_view).unwrap(),
        )
        .unwrap();

        let old_record = serde_json::json!({
            "format": "amby-database-record",
            "formatVersion": 1,
            "databaseId": old_db_id,
            "noteId": note_id,
            "values": {}
        });
        fs::write(
            db_dir.join(".ambd/records").join(format!("{note_id}.json")),
            serde_json::to_vec_pretty(&old_record).unwrap(),
        )
        .unwrap();

        // Create the note file so record is owned
        fs::write(
            db_dir.join("Row.md"),
            format!("---\namby-id: {note_id}\n---\n# Row\n"),
        )
        .unwrap();

        migrate_legacy_database_manifests(&vault).unwrap();

        // Check view is now inside PaLooVerse.json with reconciled databaseId
        let manifest_val: serde_json::Value =
            serde_json::from_slice(&fs::read(db_dir.join("PaLooVerse.json")).unwrap()).unwrap();
        let views = manifest_val["views"].as_array().expect("views array");
        assert_eq!(views.len(), 1);
        assert_eq!(views[0]["viewId"], view_id);
        assert_eq!(views[0]["databaseId"], manifest_id);

        // Check view and record shard dirs are deleted
        assert!(!db_dir.join(".ambd/views").exists());
        assert!(!db_dir.join(".ambd/records").exists());

        // Check note frontmatter has note_id
        let note_content = fs::read_to_string(db_dir.join("Row.md")).unwrap();
        assert!(note_content.contains(note_id));

        // Second migration run should be a no-op
        let second_run = migrate_legacy_database_manifests(&vault).unwrap();
        assert_eq!(second_run, 0);

        // Discovery should find zero errors
        let discovery = discover_vault(&vault).unwrap();
        let errors = discovery
            .diagnostics
            .iter()
            .filter(|d| d.severity == DiagnosticSeverity::Error)
            .collect::<Vec<_>>();
        assert!(errors.is_empty(), "Expected 0 errors, got: {:?}", errors);
        assert_eq!(discovery.databases.len(), 1);
        assert_eq!(discovery.databases[0].database_id, manifest_id);

        fs::remove_dir_all(vault).unwrap();
    }
}
