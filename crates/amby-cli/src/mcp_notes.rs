//! MCP tools for working inside a note and with its history (docs/mcp.md): fragment edits,
//! the outline and one section, the versions history keeps, and showing a note in desktop Amby.

use std::path::Path;

use amby_core::index::read_only::visible_note;
use amby_core::note_edit::Edit;
use serde_json::{json, Value};

use crate::mcp_tools::{argument, validate_fields};

pub fn is_read(name: &str) -> bool {
    matches!(
        name,
        "get_outline" | "read_section" | "list_versions" | "read_version" | "open_in_amby"
    )
}

pub fn is_write(name: &str) -> bool {
    matches!(name, "edit_note" | "restore_version")
}

fn flag(arguments: &Value, name: &str) -> Result<bool, &'static str> {
    arguments
        .get(name)
        .map_or(Ok(false), |value| value.as_bool().ok_or("invalidArguments"))
}

fn text<'a>(arguments: &'a Value, name: &str) -> Result<&'a str, &'static str> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .ok_or("invalidArguments")
}

pub fn read(root: &Path, name: &str, arguments: &Value) -> Result<Value, &'static str> {
    match name {
        "get_outline" | "read_section" | "list_versions" | "read_version" => {
            amby_core::tool_set::note_read(root, name, arguments)
        }
        "open_in_amby" => {
            validate_fields(arguments, &["path"], &[])?;
            let path = argument(arguments, "path")?.replace('\\', "/");
            visible_note(root, &path)?;
            crate::launch::open(root, &path)?;
            Ok(json!({ "path": path, "requested": true }))
        }
        _ => Err("unknownTool"),
    }
}

pub fn write(
    root: &Path,
    scope: &Path,
    name: &str,
    arguments: &Value,
) -> Result<Value, &'static str> {
    match name {
        "edit_note" => {
            validate_fields(
                arguments,
                &["path", "oldText", "newText"],
                &["replaceAll", "dryRun"],
            )?;
            let path = argument(arguments, "path")?;
            let (edit, count) = Edit::prepare_replace(
                root,
                path,
                Some(scope),
                text(arguments, "oldText")?,
                text(arguments, "newText")?,
                flag(arguments, "replaceAll")?,
            )?;
            let result =
                crate::edit::finish(&edit, root, Some(scope), flag(arguments, "dryRun")?, true)?;
            let mut value = json!(result);
            value["replacements"] = json!(count);
            Ok(value)
        }
        "restore_version" => {
            validate_fields(arguments, &["id"], &["dryRun"])?;
            amby_core::note_versions::restore(
                root,
                scope,
                argument(arguments, "id")?,
                flag(arguments, "dryRun")?,
            )
        }
        _ => Err("unknownTool"),
    }
}
