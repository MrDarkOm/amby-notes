//! MCP tool schemas and the CLI's local desktop dispatch.

use std::path::Path;

use amby_core::cli_ipc::{self, Action, Payload, Request};
use amby_core::vault_tools::{self, Mutation};
use serde_json::{json, Value};
use vault_tools::modules::{Module, Modules};

pub const STRUCTURAL: [(&str, &str, &[&str]); 4] = [
    (
        "rename_item",
        "Rename a note, bundle or folder and update its links.",
        &["path", "name"],
    ),
    (
        "move_item",
        "Move a note, bundle or folder into an existing folder and update its links.",
        &["path", "folder"],
    ),
    (
        "archive_item",
        "Move an item to the recoverable vault archive.",
        &["path"],
    ),
    (
        "restore_item",
        "Restore an archived item to a free vault path.",
        &["path"],
    ),
];

pub fn definition(
    name: &str,
    description: &str,
    strings: &[&str],
    preview: bool,
    read_only: bool,
) -> Value {
    let mut properties = serde_json::Map::new();
    for key in strings {
        properties.insert(
            (*key).into(),
            json!({"type":"string", "minLength": 1, "maxLength": 1024}),
        );
    }
    if preview {
        properties.insert("dryRun".into(), json!({"type":"boolean", "description":"Show the affected paths without changing the vault."}));
    }
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object", "properties": properties, "required": strings, "additionalProperties": false
        },
        "annotations": {
            "readOnlyHint": read_only, "openWorldHint": false, "destructiveHint": !read_only
        }
    })
}

pub fn argument<'a>(args: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 1024)
        .ok_or("invalidArguments")
}

pub fn structural_call(
    root: &Path,
    grant: &str,
    name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let (_, _, fields) = STRUCTURAL
        .iter()
        .find(|(tool, _, _)| *tool == name)
        .ok_or("unknownTool")?;
    validate_fields(arguments, fields, &["dryRun"])?;
    let path = argument(arguments, "path")?.to_owned();
    let request = match name {
        "rename_item" => Mutation::Rename {
            path,
            name: argument(arguments, "name")?.into(),
        },
        "move_item" => Mutation::Move {
            path,
            folder: argument(arguments, "folder")?.into(),
        },
        "archive_item" => Mutation::Archive { path },
        "restore_item" => Mutation::Restore { path },
        _ => return Err("unknownTool".into()),
    };
    if arguments
        .get("dryRun")
        .map_or(Ok(false), |v| v.as_bool().ok_or("invalidArguments"))?
    {
        return vault_tools::preview(root, grant, &request).map_err(str::to_owned);
    }
    execute(root, grant, request)
}

pub fn validate_fields(
    arguments: &Value,
    required: &[&str],
    optional: &[&str],
) -> Result<(), &'static str> {
    let object = arguments.as_object().ok_or("invalidArguments")?;
    if !object
        .keys()
        .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
    {
        return Err("invalidArguments");
    }
    Ok(())
}

pub fn execute(root: &Path, grant: &str, request: Mutation) -> Result<Value, String> {
    // Use the same input ceiling locally and through desktop IPC.
    if serde_json::to_vec(&request)
        .map_err(|_| "invalidArguments")?
        .len()
        > 32 * 1024
    {
        return Err("operationTooLarge".into());
    }
    match vault_tools::execute_offline(root, grant, &request) {
        Err("vaultBusy") => {
            let profile = crate::config::app_data()?;
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| "unavailable")?;
            let response = runtime.block_on(cli_ipc::dispatch(
                &profile,
                Request {
                    version: cli_ipc::VERSION,
                    vault: root.to_owned(),
                    action: Action::Tool {
                        grant: grant.into(),
                        request,
                    },
                },
            ))?;
            match response {
                Payload::Tool(result) => Ok(result),
                _ => Err("desktopRequestInterrupted".into()),
            }
        }
        other => other.map_err(str::to_owned),
    }
}

type DomainTool = (
    &'static str,
    &'static str,
    &'static [&'static str],
    Option<Module>,
);

pub const DOMAIN_READS: [DomainTool; 7] = [
    ("list_archive", "List up to 100 restorable entries, using paths relative to the vault's archive.", &[], None),
    ("list_databases", "List up to 100 databases using their durable IDs.", &[], Some(Module::Databases)),
    ("read_database", "Read a database's properties, types, options and manifest revision.", &["databaseId"], Some(Module::Databases)),
    ("query_database", "Query rows with values, stable IDs and raw revisions. Supports title search and cursor paging.", &["databaseId"], Some(Module::Databases)),
    ("list_workshops", "List up to 100 creative workshops.", &[], Some(Module::Creative)),
    ("read_workshop", "Read a workshop's sections, stories and revision.", &["workshopId"], Some(Module::Creative)),
    ("read_story", "Read a story's text levels, formats, property IDs and database ID.", &["storyId"], Some(Module::Creative)),
];

pub const DOMAIN_WRITES: [DomainTool; 13] = [
    ("create_database", "Create an empty standalone database in an existing folder. Use . for the vault root.", &["parent", "name"], Some(Module::Databases)),
    ("create_database_row", "Create a blank row in a database.", &["databaseId", "title"], Some(Module::Databases)),
    ("rename_database", "Rename a database's display title using its current manifest revision.", &["databaseId", "name", "expectedRevision"], Some(Module::Databases)),
    ("rename_database_property", "Rename a property label while retaining its storage key and values.", &["databaseId", "propertyId", "name", "expectedRevision"], Some(Module::Databases)),
    ("add_database_property", "Create a scalar or choice property using the current database revision.", &["databaseId", "name", "propertyType", "expectedRevision"], Some(Module::Databases)),
    ("create_database_relation", "Create a reciprocal relation between two databases using both manifest revisions.", &["databaseId", "targetDatabaseId", "name", "inverseName", "expectedRevision", "expectedTargetRevision", "operationId"], Some(Module::Databases)),
    ("set_database_relation", "Replace a row's relation targets, or clear it with an empty array. Previews include added and removed inverse records.", &["databaseId", "noteId", "propertyId", "targetNoteIds", "expectedRevision", "operationId"], Some(Module::Databases)),
    ("set_database_value", "Set a typed value on a row, or clear it with null. Requires the current raw row revision.", &["databaseId", "noteId", "propertyId", "expectedRevision", "operationId", "value"], Some(Module::Databases)),
    ("create_workshop", "Create a workshop and its starter databases in an existing folder. Use . for the vault root.", &["parent", "name", "operationId"], Some(Module::Creative)),
    ("create_story", "Create a story and its attached text database in a workshop.", &["workshopId", "title", "operationId"], Some(Module::Creative)),
    ("update_workshop", "Set a workshop's name, tags, or both using its current revision.", &["workshopId", "expectedRevision", "operationId"], Some(Module::Creative)),
    ("create_text_page", "Create a page in a story at a text level, optionally under an existing page.", &["storyId", "title", "levelId", "orderKey"], Some(Module::Creative)),
    ("create_workshop_section", "Create a custom section in a workshop using the current workshop revision.", &["workshopId", "name", "expectedRevision", "operationId"], Some(Module::Creative)),
];

pub fn domain_definition(name: &str, description: &str, fields: &[&str], read_only: bool) -> Value {
    let mut tool = definition(name, description, fields, false, read_only);
    let properties = &mut tool["inputSchema"]["properties"];
    match name {
        "query_database" => {
            properties["search"] = json!({"type":"string","maxLength":1024});
            properties["cursor"] = json!({"type":"string","maxLength":1024});
            properties["limit"] = json!({"type":"integer","minimum":1,"maximum":100,"default":25});
        }
        "set_database_value" => {
            properties["value"] = json!({
                "type":["object","null"],
                "description":"A scalar or choice value object from query_database, or null to clear. Use set_database_relation for Relation values."
            });
        }
        "create_database_relation" => {
            properties["maxItems"] =
                json!({"type":"integer","enum":[1],"description":"Omit for multiple targets."});
        }
        "set_database_relation" => {
            properties["targetNoteIds"] =
                json!({"type":"array","items":{"type":"string","maxLength":26},"maxItems":100});
            properties["dryRun"] = json!({"type":"boolean","description":"Return all record paths that would change."});
        }
        "update_workshop" => {
            properties["name"] = json!({"type":"string","minLength":1,"maxLength":100});
            properties["tags"] =
                json!({"type":"array","items":{"type":"string","maxLength":64},"maxItems":32});
        }
        "create_text_page" => {
            properties["parentNoteId"] = json!({"type":"string","minLength":1,"maxLength":1024});
            properties["formatId"] = json!({"type":"string","minLength":1,"maxLength":1024});
            properties["orderKey"] = json!({"type":"string","pattern":"^[0-9A-Za-z]{1,64}$"});
        }
        "add_database_property" => {
            properties["propertyType"] = json!({"enum":["text","number","checkbox","date","url","select","multiSelect","status"]});
            properties["options"] =
                json!({"type":"array","items":{"type":"string","maxLength":1024},"maxItems":100});
        }
        _ => {}
    }
    tool
}

fn optional_string(args: &Value, key: &str) -> Result<Option<String>, &'static str> {
    args.get(key)
        .map(|_| argument(args, key).map(str::to_owned))
        .transpose()
}

pub fn domain_read(root: &Path, name: &str, arguments: &Value) -> Result<Value, &'static str> {
    let (_, _, fields, module) = DOMAIN_READS
        .iter()
        .find(|(tool, _, _, _)| *tool == name)
        .ok_or("unknownTool")?;
    if let Some(module) = module {
        Modules::require(root, *module)?;
    }
    let optional: &[&str] = if name == "query_database" {
        &["search", "cursor", "limit"]
    } else {
        &[]
    };
    validate_fields(arguments, fields, optional)?;
    match name {
        "list_archive" => {
            let mut entries = amby_core::structural::archive_list(root)?;
            entries.retain(|entry| {
                entry.id.split('/').all(|part| {
                    !part.starts_with('.') && !amby_core::vault::scan::is_service_directory(part)
                })
            });
            let truncated = entries.len() > vault_tools::MAX_ITEMS;
            entries.truncate(vault_tools::MAX_ITEMS);
            Ok(json!({"entries":entries, "truncated": truncated}))
        }
        "list_databases" => vault_tools::database::list(root),
        "read_database" => vault_tools::database::read(root, argument(arguments, "databaseId")?),
        "query_database" => {
            let limit = arguments.get("limit").map_or(Ok(25), |limit| {
                limit
                    .as_u64()
                    .filter(|&n| n > 0 && n <= vault_tools::MAX_ITEMS as u64)
                    .ok_or("invalidArguments")
            })?;
            vault_tools::database::query(
                root,
                argument(arguments, "databaseId")?,
                optional_string(arguments, "search")?,
                optional_string(arguments, "cursor")?,
                limit as u32,
            )
        }
        "list_workshops" => vault_tools::workshop::list(root),
        "read_workshop" => vault_tools::workshop::read(root, argument(arguments, "workshopId")?),
        "read_story" => vault_tools::workshop::read_story(root, argument(arguments, "storyId")?),
        _ => Err("unknownTool"),
    }
}

pub fn domain_write(
    root: &Path,
    grant: &str,
    name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let (_, _, fields, module) = DOMAIN_WRITES
        .iter()
        .find(|(tool, _, _, _)| *tool == name)
        .ok_or("unknownTool")?;
    if let Some(module) = module {
        Modules::require(root, *module)?;
    }
    let optional: &[&str] = match name {
        "add_database_property" => &["options"],
        "update_workshop" => &["name", "tags"],
        "create_text_page" => &["parentNoteId", "formatId"],
        "create_database_relation" => &["maxItems"],
        "set_database_relation" => &["dryRun"],
        _ => &[],
    };
    validate_fields(arguments, fields, optional)?;
    for field in fields
        .iter()
        .copied()
        .filter(|&field| !matches!(field, "value" | "targetNoteIds"))
    {
        argument(arguments, field)?;
    }
    for field in ["name", "parentNoteId", "formatId"] {
        if optional.contains(&field) && arguments.get(field).is_some() {
            argument(arguments, field)?;
        }
    }
    for (field, max) in [("options", vault_tools::MAX_ITEMS), ("tags", 32)] {
        let Some(options) = arguments.get(field) else {
            continue;
        };
        if !options.as_array().is_some_and(|items| {
            items.len() <= max
                && items.iter().all(|item| {
                    item.as_str()
                        .is_some_and(|name| !name.is_empty() && name.len() <= 1024)
                })
        }) {
            return Err("invalidArguments".into());
        }
    }
    let kind = match name {
        "create_database" => "createDatabase",
        "create_database_row" => "createDatabaseRow",
        "rename_database" => "renameDatabase",
        "rename_database_property" => "renameDatabaseProperty",
        "add_database_property" => "addDatabaseProperty",
        "set_database_value" => "setDatabaseValue",
        "create_database_relation" => "createDatabaseRelation",
        "set_database_relation" => "setDatabaseRelation",
        "create_workshop" => "createWorkshop",
        "create_story" => "createStory",
        "update_workshop" => "updateWorkshop",
        "create_text_page" => "createTextPage",
        "create_workshop_section" => "createWorkshopSection",
        _ => return Err("unknownTool".into()),
    };
    let mut request = arguments.clone();
    let dry_run = request
        .as_object_mut()
        .and_then(|object| object.remove("dryRun"))
        .map_or(Ok(false), |value| value.as_bool().ok_or("invalidArguments"))?;
    request["kind"] = kind.into();
    let request = serde_json::from_value(request).map_err(|_| "invalidArguments")?;
    if dry_run {
        vault_tools::preview(root, grant, &request).map_err(str::to_owned)
    } else {
        execute(root, grant, request)
    }
}

/// Note property and deletion tools (docs/mcp.md): name, description, required fields.
pub const PROPERTY_WRITES: [(&str, &str, &[&str]); 5] = [
    (
        "set_property",
        "Set a header property of a note. A missing property is created; type sets the type of a new property or changes an existing one. Use null to clear the value and an array for a list.",
        &["path", "name", "value"],
    ),
    (
        "set_property_appearance",
        "Change how a property is presented: its type, icon, and settings with select options, a default option and option colours. The header value is unchanged.",
        &["path", "name"],
    ),
    (
        "rename_property",
        "Rename a property of a note, keeping its value and presentation.",
        &["path", "name", "newName"],
    ),
    (
        "delete_property",
        "Remove a property from a note's header and its presentation. The previous note text stays in the note's history.",
        &["path", "name"],
    ),
    (
        "delete_item",
        "Move a note, bundle or folder to the system trash, where the user can restore it. Use dryRun to list what would be removed.",
        &["path"],
    ),
];

pub fn get_properties_definition() -> Value {
    let mut tool = definition(
        "get_properties",
        "Read a note's header properties with values, list items, types, icons and settings.",
        &["path"],
        false,
        true,
    );
    tool["inputSchema"]["properties"]["path"]["description"] =
        json!("A vault-relative Markdown path.");
    tool
}

pub fn property_definition(name: &str, description: &str, fields: &[&str]) -> Value {
    let strings: Vec<&str> = fields
        .iter()
        .copied()
        .filter(|field| *field != "value")
        .collect();
    let mut tool = definition(name, description, &strings, name == "delete_item", false);
    tool["inputSchema"]["required"] = json!(fields);
    let properties = &mut tool["inputSchema"]["properties"];
    let types = json!({"enum": amby_core::vault_tools::properties::PROPERTY_TYPES});
    match name {
        "set_property" => {
            properties["value"] = json!({
                "type": ["string", "number", "boolean", "array", "null"],
                "items": {"type": ["string", "number", "boolean"]},
                "maxItems": 100
            });
            properties["type"] = types;
        }
        "set_property_appearance" => {
            properties["type"] = types;
            properties["icon"] = json!({"type": "string", "maxLength": 256, "description": "An encoded Amby icon value, or an empty string to clear."});
            properties["settings"] = json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "options": {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 1024}, "maxItems": 100},
                    "default": {"type": "string", "maxLength": 1024},
                    "colors": {"type": "object", "additionalProperties": {"type": "string", "maxLength": 64}}
                }
            });
        }
        _ => {}
    }
    tool
}

pub fn property_call(
    root: &Path,
    grant: &str,
    name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let (_, _, fields) = PROPERTY_WRITES
        .iter()
        .find(|(tool, _, _)| *tool == name)
        .ok_or("unknownTool")?;
    let optional: &[&str] = match name {
        "set_property" => &["type"],
        "set_property_appearance" => &["type", "icon", "settings"],
        "delete_item" => &["dryRun"],
        _ => &[],
    };
    validate_fields(arguments, fields, optional)?;
    for field in fields.iter().filter(|field| **field != "value") {
        argument(arguments, field)?;
    }
    if name == "set_property" && arguments.get("value").is_none() {
        return Err("invalidArguments".into());
    }
    let mut request = arguments.clone();
    let dry_run = request
        .as_object_mut()
        .and_then(|object| object.remove("dryRun"))
        .map_or(Ok(false), |value| value.as_bool().ok_or("invalidArguments"))?;
    request["kind"] = match name {
        "set_property" => "setProperty",
        "set_property_appearance" => "setPropertyAppearance",
        "rename_property" => "renameProperty",
        "delete_property" => "deleteProperty",
        "delete_item" => "delete",
        _ => return Err("unknownTool".into()),
    }
    .into();
    let request: Mutation = serde_json::from_value(request).map_err(|_| "invalidArguments")?;
    if dry_run {
        vault_tools::preview(root, grant, &request).map_err(str::to_owned)
    } else {
        execute(root, grant, request)
    }
}

/// A change applied to every note a filter finds (docs/cli.md, «Bulk edits»).
pub enum BulkOp {
    Set {
        name: String,
        value: Value,
        property_type: Option<String>,
    },
    Move {
        folder: String,
    },
}

/// The most notes one bulk edit may touch.
pub const BULK_LIMIT: usize = 200;

/// Applies `op` to each note `filter` finds, one by one; a failed note does not stop the
/// others. A preview reports the notes and the ones the grant excludes.
pub fn bulk(
    root: &Path,
    grant: &str,
    mut filter: amby_core::index::NoteFilter,
    op: &BulkOp,
    dry_run: bool,
) -> Result<Value, String> {
    if filter.is_empty() {
        return Err("invalidArguments".into());
    }
    let scope = amby_core::index::read_only::visible_folder(root, grant)?;
    if let BulkOp::Move { folder } = op {
        if folder != "." {
            amby_core::index::read_only::visible_folder(root, folder)?;
        }
    }
    filter.limit = BULK_LIMIT + 1;
    let found = amby_core::index::read_only::ReadVault::open(root)?.find(&filter)?;
    if found.len() > BULK_LIMIT {
        return Err("tooManyNotes".into());
    }
    let mut notes = Vec::new();
    let mut failed = 0;
    for hit in found {
        let Ok(relative) = Path::new(&hit.note.path).strip_prefix(root) else {
            continue;
        };
        let path = amby_core::vault::scan::normalize_rel_path(relative);
        let outcome = if !Path::new(&hit.note.path).starts_with(&scope) {
            Err("outsideWriteScope".to_owned())
        } else if dry_run {
            Ok(())
        } else {
            let request = match op {
                BulkOp::Set {
                    name,
                    value,
                    property_type,
                } => Mutation::SetProperty(vault_tools::properties::SetProperty {
                    path: path.clone(),
                    name: name.clone(),
                    value: value.clone(),
                    property_type: property_type.clone(),
                }),
                BulkOp::Move { folder } => Mutation::Move {
                    path: path.clone(),
                    folder: folder.clone(),
                },
            };
            execute(root, grant, request).map(|_| ())
        };
        match outcome {
            Ok(()) => notes.push(json!({"path": path, "title": hit.note.title, "ok": true})),
            Err(error) => {
                failed += 1;
                notes.push(
                    json!({"path": path, "title": hit.note.title, "ok": false, "error": error}),
                );
            }
        }
    }
    Ok(json!({"notes": notes, "total": notes.len(), "failed": failed, "dryRun": dry_run}))
}

/// Copies a new attachment next to a note inside `scope`, and links it from the note
/// unless `link` is false. Runs locally: the file is new and the note edit is an ordinary
/// append, which an open desktop sees as an external change.
pub fn attach(
    root: &Path,
    scope: &Path,
    note: &str,
    name: &str,
    source: vault_tools::attachments::Source<'_>,
    link: bool,
    ai: bool,
) -> Result<Value, &'static str> {
    let note = note.replace('\\', "/");
    let file = amby_core::index::read_only::visible_note(root, &note)?;
    if !file.starts_with(scope) {
        return Err("outsideWriteScope");
    }
    let imported = vault_tools::attachments::import(root, &file, name, source)?;
    if link {
        let markdown = vault_tools::attachments::link_markdown(&imported);
        crate::edit::execute(
            root,
            Some(scope),
            amby_core::note_edit::EditKind::Append,
            &note,
            &markdown,
            false,
            ai,
        )?;
    }
    let mut result = json!(imported);
    result["note"] = json!(note);
    result["linked"] = json!(link);
    Ok(result)
}
