//! Note properties for the CLI and MCP (docs/cli.md, docs/mcp.md): the value in the YAML
//! header, the presentation (type, icon, settings) in the property groups (appendix З of
//! docs/sync-plan.md). Writes go through [`crate::property_groups`], which owns the journal,
//! the backups and the byte-exact header edits.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::{allowed, relative, Published};
use crate::frontmatter;
use crate::index::read_only::visible_note;
use crate::property_groups::{self as groups, ActiveProperty, Design};

/// The types a note property can have (the property editor offers the same list).
pub const PROPERTY_TYPES: [&str; 7] = [
    "text", "number", "checkbox", "date", "select", "list", "url",
];
const MAX_ITEMS: usize = 100;
const MAX_TEXT: usize = 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetProperty {
    pub path: String,
    pub name: String,
    /// A string, number, flag, list of scalars, or `null` to clear.
    pub value: Value,
    /// The type of a property that does not exist yet; an existing one changes type.
    #[serde(default, rename = "type")]
    pub property_type: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyAppearance {
    pub path: String,
    pub name: String,
    #[serde(default, rename = "type")]
    pub property_type: Option<String>,
    /// An encoded icon value; `""` clears it.
    #[serde(default)]
    pub icon: Option<String>,
    /// `{"options": [...], "default": "...", "colors": {"option": "color"}}`.
    #[serde(default)]
    pub settings: Option<Value>,
}

/// Maps a message of the property engine to a stable code.
fn code(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    if error.contains("not migrated") {
        "propertiesNotMigrated"
    } else if error.contains("newer than this version") {
        "propertiesFormatNewer"
    } else if error.contains("exists already") {
        "alreadyExists"
    } else if error.contains("several keys") {
        "ambiguousProperty"
    } else if error.contains("no such property") {
        "propertyNotFound"
    } else if error.contains("no usable amby-id") || error.contains("identity is invalid") {
        "noteWithoutId"
    } else if error.contains("read only") {
        "propertiesReadOnly"
    } else if error.contains("malformed") || error.contains("without loss") {
        "invalidFrontmatter"
    } else if error.contains("name cannot be empty") || error.contains("cannot be used") {
        "invalidArguments"
    } else if error.contains("not found") {
        "notFound"
    } else {
        "propertyRejected"
    }
}

fn same_name(a: &str, b: &str) -> bool {
    use unicode_normalization::UnicodeNormalization;
    let fold = |text: &str| text.trim().nfc().collect::<String>();
    fold(a) == fold(b) || fold(a).eq_ignore_ascii_case(&fold(b))
}

/// Settings as JSON: the new form as it is, the old comma list as options, none as `null`.
fn settings_json(settings: &str) -> Value {
    let trimmed = settings.trim();
    if trimmed.is_empty() {
        return Value::Null;
    }
    if trimmed.starts_with('{') {
        if let Ok(value @ Value::Object(_)) = serde_json::from_str::<Value>(trimmed) {
            return value;
        }
    }
    let options: Vec<&str> = trimmed
        .split(',')
        .map(str::trim)
        .filter(|option| !option.is_empty())
        .collect();
    json!({ "options": options })
}

fn property_json(property: &ActiveProperty) -> Value {
    json!({
        "name": property.name,
        "key": property.key,
        "value": property.value,
        "items": property.items,
        "type": property.property_type,
        "icon": property.icon,
        "settings": settings_json(&property.settings),
        "fromTemplate": property.from_template,
        "customized": property.has_record,
        "readOnly": property.read_only,
        "typeMismatch": property.type_mismatch,
        "outsideOptions": property.outside_options,
    })
}

/// The note's ID when its header holds a usable one; `Err` when the header is damaged.
fn note_id(text: &str) -> Result<Option<String>, &'static str> {
    let parsed = frontmatter::parse_markdown(text);
    if parsed.frontmatter_status.is_malformed() || parsed.identity_error.is_some() {
        return Err("invalidFrontmatter");
    }
    Ok(parsed.id)
}

/// The properties of the note at a vault-relative path.
pub fn read(conn: &Connection, root: &Path, path: &str) -> Result<Value, &'static str> {
    let file = visible_note(root, path)?;
    let text = std::fs::read_to_string(&file).map_err(|_| "invalidEncoding")?;
    listing(conn, root, &file, &text)
}

fn listing(conn: &Connection, root: &Path, file: &Path, text: &str) -> Result<Value, &'static str> {
    let path = relative(root, file)?;
    let id = note_id(text)?;
    let migrated = groups::in_groups(root);
    let (active, dormant, read_only) = match &id {
        Some(id) => {
            let panel = groups::panel(conn, root, id).map_err(|error| code(&error))?;
            if panel.unreadable {
                return Err("invalidFrontmatter");
            }
            let dormant: Vec<String> = panel.dormant.into_iter().map(|d| d.name).collect();
            (panel.active, dormant, panel.read_only)
        }
        None => (
            groups::header_view(text).ok_or("invalidFrontmatter")?,
            Vec::new(),
            !migrated,
        ),
    };
    Ok(json!({
        "path": path,
        "noteId": id,
        "readOnly": read_only,
        "properties": active.iter().map(property_json).collect::<Vec<_>>(),
        "dormant": dormant,
    }))
}

/// A JSON value as the text the header editor takes, or the items of a list.
enum Input {
    Text(String),
    List(Vec<String>),
}

fn scalar(value: &Value) -> Result<String, &'static str> {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        _ => return Err("invalidArguments"),
    };
    if text.len() > MAX_TEXT || text.contains(['\n', '\r']) {
        return Err("invalidArguments");
    }
    Ok(text)
}

fn input(value: &Value) -> Result<(Input, &'static str), &'static str> {
    Ok(match value {
        Value::Null => (Input::Text(String::new()), "text"),
        Value::Array(items) if items.len() <= MAX_ITEMS => (
            Input::List(items.iter().map(scalar).collect::<Result<_, _>>()?),
            "list",
        ),
        Value::Bool(_) => (Input::Text(scalar(value)?), "checkbox"),
        Value::Number(_) => (Input::Text(scalar(value)?), "number"),
        Value::String(_) => (Input::Text(scalar(value)?), "text"),
        _ => return Err("invalidArguments"),
    })
}

fn check_type(property_type: Option<&str>) -> Result<(), &'static str> {
    match property_type {
        Some(kind) if !PROPERTY_TYPES.contains(&kind) => Err("invalidArguments"),
        _ => Ok(()),
    }
}

fn check_name(name: &str) -> Result<(), &'static str> {
    if name.trim().is_empty() || name.len() > 256 || name.contains(['\n', '\r']) {
        Err("invalidArguments")
    } else {
        Ok(())
    }
}

/// The settings JSON of the presentation: only `options`, `default` and `colors`, typed.
fn settings_text(settings: &Value) -> Result<String, &'static str> {
    let object = settings.as_object().ok_or("invalidArguments")?;
    let mut clean = Map::new();
    for (key, value) in object {
        let ok = match key.as_str() {
            "options" => value.as_array().is_some_and(|options| {
                options.len() <= MAX_ITEMS
                    && options.iter().all(|option| {
                        option.as_str().is_some_and(|option| {
                            !option.trim().is_empty() && option.len() <= MAX_TEXT
                        })
                    })
            }),
            "default" => value.as_str().is_some_and(|text| text.len() <= MAX_TEXT),
            "colors" => value.as_object().is_some_and(|colors| {
                colors.len() <= MAX_ITEMS
                    && colors
                        .values()
                        .all(|color| color.as_str().is_some_and(|color| color.len() <= 64))
            }),
            _ => false,
        };
        if !ok {
            return Err("invalidArguments");
        }
        clean.insert(key.clone(), value.clone());
    }
    serde_json::to_string(&Value::Object(clean)).map_err(|_| "invalidArguments")
}

/// The note a write targets: inside the grant, readable, with its text and ID.
struct Target {
    file: PathBuf,
    text: String,
    id: Option<String>,
}

fn target(root: &Path, scope: &Path, path: &str) -> Result<Target, &'static str> {
    let file = visible_note(root, &path.replace('\\', "/"))?;
    allowed(scope, &file)?;
    let text = std::fs::read_to_string(&file).map_err(|_| "invalidEncoding")?;
    let id = note_id(&text)?;
    Ok(Target { file, text, id })
}

fn current(
    conn: &Connection,
    root: &Path,
    id: &str,
    name: &str,
) -> Result<Option<ActiveProperty>, &'static str> {
    let panel = groups::panel(conn, root, id).map_err(|error| code(&error))?;
    if panel.unreadable {
        return Err("invalidFrontmatter");
    }
    Ok(panel.active.into_iter().find(|p| same_name(&p.name, name)))
}

fn done(conn: &Connection, root: &Path, target: &Target) -> Result<Published, &'static str> {
    let text = std::fs::read_to_string(&target.file).map_err(|_| "unavailable")?;
    Ok(Published {
        output: listing(conn, root, &target.file, &text)?,
        changed: vec![target.file.clone()],
        archive_changed: false,
        properties_changed: true,
    })
}

/// A header edit of a note without `amby-id`: the value only, no ID is added.
fn write_header(root: &Path, target: &Target, updated: &str) -> Result<(), &'static str> {
    if updated == target.text {
        return Ok(());
    }
    let bytes =
        frontmatter::text_bytes_for_write(&target.file, updated).map_err(|_| "unavailable")?;
    crate::history::snapshot_before_write(root, &target.file, &bytes, "cli-property")
        .map_err(|_| "historyFailed")?;
    frontmatter::atomic_write_bytes(&target.file, &bytes).map_err(|_| "unavailable")
}

/// The text with an empty header when it has none, keeping a BOM and the line ending.
fn with_header(text: &str) -> String {
    if !matches!(
        frontmatter::header_keys(text),
        frontmatter::HeaderKeys::Absent
    ) {
        return text.to_owned();
    }
    let (bom, body) = match text.strip_prefix('\u{feff}') {
        Some(body) => ("\u{feff}", body),
        None => ("", text),
    };
    let newline = if body.contains("\r\n") { "\r\n" } else { "\n" };
    format!("{bom}---{newline}---{newline}{body}")
}

fn set_without_id(root: &Path, target: &Target, request: &SetProperty) -> Result<(), &'static str> {
    if !groups::in_groups(root) {
        return Err("propertiesNotMigrated");
    }
    let (value, inferred) = input(&request.value)?;
    let existing = groups::header_view(&target.text)
        .ok_or("invalidFrontmatter")?
        .into_iter()
        .find(|p| same_name(&p.name, &request.name));
    if existing.as_ref().is_some_and(|p| p.read_only) {
        return Err("invalidFrontmatter");
    }
    let key = existing
        .as_ref()
        .map_or(request.name.trim(), |p| p.key.as_str());
    let kind = request
        .property_type
        .as_deref()
        .or(existing.as_ref().map(|p| p.property_type.as_str()))
        .unwrap_or(inferred);
    let text = with_header(&target.text);
    // The envelope exists now, so no identity is written.
    let updated = match value {
        Input::List(items) => frontmatter::upsert_frontmatter_list(&text, "", key, &items),
        Input::Text(text_value) if kind == "list" => {
            let items: Vec<String> = (!text_value.is_empty())
                .then_some(text_value)
                .into_iter()
                .collect();
            frontmatter::upsert_frontmatter_list(&text, "", key, &items)
        }
        Input::Text(text_value) => {
            frontmatter::upsert_frontmatter_property(&text, "", key, &text_value, kind)
        }
    }
    .map_err(|error| code(&error))?;
    write_header(root, target, &updated)
}

pub fn set(
    conn: &Connection,
    root: &Path,
    scope: &Path,
    request: &SetProperty,
) -> Result<Published, &'static str> {
    check_name(&request.name)?;
    check_type(request.property_type.as_deref())?;
    let target = target(root, scope, &request.path)?;
    let Some(id) = target.id.clone() else {
        set_without_id(root, &target, request)?;
        return done(conn, root, &target);
    };
    let (value, inferred) = input(&request.value)?;
    let engine = |error: String| code(&error);
    let name = match current(conn, root, &id, &request.name)? {
        Some(property) => {
            if let Some(kind) = request.property_type.as_deref() {
                if kind != property.property_type {
                    groups::change_type(conn, root, &id, &property.name, kind).map_err(engine)?;
                }
            }
            property.name
        }
        None => groups::create_property(
            conn,
            root,
            &id,
            Design {
                name: request.name.clone(),
                icon: String::new(),
                property_type: request
                    .property_type
                    .clone()
                    .unwrap_or_else(|| inferred.into()),
                settings: String::new(),
            },
            "",
        )
        .map_err(engine)?,
    };
    let kind = current(conn, root, &id, &name)?
        .map(|property| property.property_type)
        .unwrap_or_default();
    match value {
        Input::List(items) => groups::set_list_value(conn, root, &id, &name, &items),
        Input::Text(text) if kind == "list" => {
            let items: Vec<String> = (!text.is_empty()).then_some(text).into_iter().collect();
            groups::set_list_value(conn, root, &id, &name, &items)
        }
        Input::Text(text) => groups::set_value(conn, root, &id, &name, &text),
    }
    .map_err(engine)?;
    done(conn, root, &target)
}

pub fn appearance(
    conn: &Connection,
    root: &Path,
    scope: &Path,
    request: &PropertyAppearance,
) -> Result<Published, &'static str> {
    check_name(&request.name)?;
    check_type(request.property_type.as_deref())?;
    if request.property_type.is_none() && request.icon.is_none() && request.settings.is_none() {
        return Err("invalidArguments");
    }
    if request
        .icon
        .as_ref()
        .is_some_and(|icon| icon.len() > 256 || icon.contains(['\n', '\r']))
    {
        return Err("invalidArguments");
    }
    let settings = request.settings.as_ref().map(settings_text).transpose()?;
    let target = target(root, scope, &request.path)?;
    let id = target.id.clone().ok_or("noteWithoutId")?;
    let property = current(conn, root, &id, &request.name)?.ok_or("propertyNotFound")?;
    let engine = |error: String| code(&error);
    if let Some(kind) = request.property_type.as_deref() {
        if kind != property.property_type {
            groups::change_type(conn, root, &id, &property.name, kind).map_err(engine)?;
        }
    }
    if request.icon.is_some() || settings.is_some() {
        groups::set_appearance_fields(
            conn,
            root,
            &id,
            &property.name,
            request.icon.as_deref(),
            settings.as_deref(),
        )
        .map_err(engine)?;
    }
    done(conn, root, &target)
}

pub fn rename(
    conn: &Connection,
    root: &Path,
    scope: &Path,
    path: &str,
    name: &str,
    new_name: &str,
) -> Result<Published, &'static str> {
    check_name(name)?;
    check_name(new_name)?;
    let target = target(root, scope, path)?;
    let id = target.id.clone().ok_or("noteWithoutId")?;
    let property = current(conn, root, &id, name)?.ok_or("propertyNotFound")?;
    if !same_name(name, new_name) && current(conn, root, &id, new_name)?.is_some() {
        return Err("alreadyExists");
    }
    groups::rename_property(conn, root, &id, &property.name, new_name)
        .map_err(|error| code(&error))?;
    done(conn, root, &target)
}

pub fn delete(
    conn: &Connection,
    root: &Path,
    scope: &Path,
    path: &str,
    name: &str,
) -> Result<Published, &'static str> {
    check_name(name)?;
    let target = target(root, scope, path)?;
    let Some(id) = target.id.clone() else {
        if !groups::in_groups(root) {
            return Err("propertiesNotMigrated");
        }
        let property = groups::header_view(&target.text)
            .ok_or("invalidFrontmatter")?
            .into_iter()
            .find(|p| same_name(&p.name, name))
            .ok_or("propertyNotFound")?;
        let updated = frontmatter::remove_frontmatter_property(&target.text, &property.key)
            .map_err(|error| code(&error))?;
        write_header(root, &target, &updated)?;
        return done(conn, root, &target);
    };
    let property = current(conn, root, &id, name)?.ok_or("propertyNotFound")?;
    groups::delete_property(conn, root, &id, &property.name).map_err(|error| code(&error))?;
    done(conn, root, &target)
}

pub fn reorder(
    conn: &Connection,
    root: &Path,
    scope: &Path,
    path: &str,
    names: &[String],
) -> Result<Published, &'static str> {
    if names.is_empty() || names.len() > MAX_ITEMS {
        return Err("invalidArguments");
    }
    for name in names {
        check_name(name)?;
    }
    let target = target(root, scope, path)?;
    let id = target.id.clone().ok_or("noteWithoutId")?;
    let panel = groups::panel(conn, root, &id).map_err(|error| code(&error))?;
    let mut ordered = Vec::new();
    for name in names {
        let property = panel
            .active
            .iter()
            .find(|p| same_name(&p.name, name))
            .ok_or("propertyNotFound")?;
        if ordered.contains(&property.name) {
            return Err("invalidArguments");
        }
        ordered.push(property.name.clone());
    }
    groups::reorder(conn, root, &id, &ordered).map_err(|error| code(&error))?;
    done(conn, root, &target)
}
