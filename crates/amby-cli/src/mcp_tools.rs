//! MCP tool schemas and the CLI's local desktop dispatch.

use std::path::Path;

use amby_core::cli_ipc::{self, Action, Payload, Request};
pub use amby_core::tool_set::{
    argument, definition, domain_definition, domain_read, get_properties_definition,
    property_definition, validate_fields, DOMAIN_READS, DOMAIN_WRITES, PROPERTY_WRITES, STRUCTURAL,
};
use amby_core::vault_tools::{self, Mutation};
use serde_json::{json, Value};
use vault_tools::modules::Modules;

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
        "set_database_relation" | "delete_database_row" => &["dryRun"],
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
        "delete_database_row" => "deleteDatabaseRow",
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
