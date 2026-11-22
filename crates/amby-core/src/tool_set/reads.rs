//! Read-side dispatch shared by the `amby mcp` server and the desktop AI panel. These
//! functions check arguments only; who may read what is decided by the caller.

use std::path::Path;

use serde_json::{json, Value};

use super::definitions::DOMAIN_READS;
use crate::vault_tools::{self, modules::Modules};

pub fn argument<'a>(args: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 1024)
        .ok_or("invalidArguments")
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
            let mut entries = crate::structural::archive_list(root)?;
            entries.retain(|entry| {
                entry.id.split('/').all(|part| {
                    !part.starts_with('.') && !crate::vault::scan::is_service_directory(part)
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

/// Outline, one section and the versions history keeps (`get_outline`, `read_section`,
/// `list_versions`, `read_version`). `path` must be a vault-relative note path.
pub fn note_read(root: &Path, name: &str, arguments: &Value) -> Result<Value, &'static str> {
    match name {
        "get_outline" => {
            validate_fields(arguments, &["path"], &[])?;
            crate::note_outline::outline(root, argument(arguments, "path")?)
        }
        "read_section" => {
            validate_fields(arguments, &["path", "heading"], &["occurrence"])?;
            let occurrence = match arguments.get("occurrence") {
                None => None,
                Some(value) => Some(
                    value
                        .as_u64()
                        .filter(|n| (1..=1000).contains(n))
                        .ok_or("invalidArguments")? as usize,
                ),
            };
            crate::note_outline::section(
                root,
                argument(arguments, "path")?,
                argument(arguments, "heading")?,
                occurrence,
            )
        }
        "list_versions" => {
            validate_fields(arguments, &["path"], &[])?;
            crate::note_versions::list(root, argument(arguments, "path")?)
        }
        "read_version" => {
            validate_fields(arguments, &["id"], &[])?;
            crate::note_versions::read(root, argument(arguments, "id")?)
        }
        _ => Err("unknownTool"),
    }
}
