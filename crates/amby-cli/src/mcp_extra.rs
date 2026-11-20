//! MCP tools for vault hygiene, attachments, property order and bulk edits, and the
//! server's prompts (docs/mcp.md).

use std::path::Path;

use amby_core::index::read_only::ReadVault;
use amby_core::vault_tools::attachments::{self, Source};
use base64::Engine as _;
use serde_json::{json, Value};

use crate::mcp_tools::{self, argument, validate_fields, BulkOp};

/// Images up to this size come back as MCP image content.
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// Other files come back as base64 inside the JSON result, which must stay small.
const MAX_INLINE_BYTES: u64 = 128 * 1024;

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

fn tool(name: &str, description: &str, input: Value, read_only: bool) -> Value {
    json!({
        "name": name, "description": description, "inputSchema": input,
        "annotations": {"readOnlyHint": read_only, "openWorldHint": false, "destructiveHint": false}
    })
}

fn filter_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"description":"Which notes: at least a query or a filter, as in search_notes.","properties":{
        "query":{"type":"string","maxLength":1024},
        "tags":{"type":"array","items":{"type":"string","minLength":1,"maxLength":256},"maxItems":16},
        "properties":{"type":"array","maxItems":16,"items":{"type":"object","properties":{"name":{"type":"string"},"value":{"type":"string"}},"required":["name"],"additionalProperties":false}},
        "folder":{"type":"string","maxLength":1024}}})
}

pub fn read_definitions() -> Vec<Value> {
    let folder = json!({"type":"string","maxLength":1024,"description":"A vault-relative folder."});
    let limit = json!({"type":"integer","minimum":1,"maximum":1000});
    let note = json!({"type":"string","minLength":1,"maxLength":1024,"description":"A note ID or a vault-relative Markdown path."});
    vec![
        tool("find_orphans", "List notes that no other note links to.", schema(json!({"folder":folder,"limit":limit}), &[]), true),
        tool("list_unresolved_links", "List links to notes that do not exist, with the note holding each. Links to existing attachments are not listed.", schema(json!({"folder":folder,"limit":limit}), &[]), true),
        tool("get_note_info", "Summarize a note: path, ID, size, words, dates, tags, link counts, property count and attachments.", schema(json!({"id":note}), &["id"]), true),
        tool("list_attachments", "List the local files a note links or embeds, with kind, size and whether each exists.", schema(json!({"id":note}), &["id"]), true),
        tool("list_templates", "List the note templates in the Templates folder, by name and path. Placeholders {{title}}, {{date}} and {{time}} are filled in when a note is made from one.", schema(json!({}), &[]), true),
        tool("read_attachment", "Read an attachment by vault-relative path. Images up to 10 MiB come back as image content; other files up to 128 KiB as base64 data.", schema(json!({"path":{"type":"string","minLength":1,"maxLength":1024}}), &["path"]), true),
    ]
}

pub fn write_definitions() -> Vec<Value> {
    let path = json!({"type":"string","minLength":1,"maxLength":1024,"description":"A vault-relative Markdown path."});
    let value = json!({"type":["string","number","boolean","array","null"],"items":{"type":["string","number","boolean"]},"maxItems":100});
    let dry_run = json!({"type":"boolean","description":"List the notes without changing them."});
    vec![
        tool("add_attachment", "Add a file to a note from base64 data, under a new name in the note's assets folder, and link it from the note (an image is embedded). It never replaces a file.", schema(json!({
            "path":path,"name":{"type":"string","minLength":1,"maxLength":255,"description":"The original file name; its extension sets the type."},
            "data":{"type":"string","description":"Base64 contents, up to 25 MiB decoded."},
            "link":{"type":"boolean","description":"Append a link to the note (default true)."}}), &["path","name","data"]), false),
        tool("new_note_from_template", "Create a note at a vault-relative path from a template (a name from list_templates or a vault path). The note gets its own ID; the template is not changed.", schema(json!({
            "path":path,"template":{"type":"string","minLength":1,"maxLength":1024},"dryRun":dry_run}), &["path","template"]), false),
        tool("daily_note", "Open the note for a day (Daily/YYYY-MM-DD.md, created when missing, from a template if given) and optionally append Markdown to it.", schema(json!({
            "date":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$","description":"The day; today (local time) when omitted."},
            "folder":{"type":"string","maxLength":1024,"description":"The folder for daily notes (default Daily; . for the root)."},
            "template":{"type":"string","minLength":1,"maxLength":1024},
            "append":{"type":"string","description":"Markdown to add at the end."},"dryRun":dry_run}), &[]), false),
        tool("reorder_properties", "Set the order of a note's properties by name. Names left out keep their relative order after these.", schema(json!({
            "path":path,"names":{"type":"array","items":{"type":"string","minLength":1,"maxLength":256},"minItems":1,"maxItems":100}}), &["path","names"]), false),
        tool("bulk_set_property", "Set one property on every note a filter finds, at most 200. Each note is changed on its own; the result reports each one.", schema(json!({
            "filter":filter_schema(),"name":{"type":"string","minLength":1,"maxLength":256},"value":value,
            "type":{"enum":amby_core::vault_tools::properties::PROPERTY_TYPES},"dryRun":dry_run}), &["filter","name","value"]), false),
        tool("bulk_move", "Move every note a filter finds, at most 200, into an existing folder (. for the root), updating links. Each note moves on its own.", schema(json!({
            "filter":filter_schema(),"folder":{"type":"string","minLength":1,"maxLength":1024},"dryRun":dry_run}), &["filter","folder"]), false),
    ]
}

/// The workspace module a tool belongs to; a switched-off module hides its tools.
pub fn module_of(name: &str) -> Option<amby_core::vault_tools::modules::Module> {
    use amby_core::vault_tools::modules::Module;
    match name {
        "list_templates" | "new_note_from_template" => Some(Module::Templates),
        "daily_note" => Some(Module::Daily),
        _ => None,
    }
}

pub fn is_read(name: &str) -> bool {
    matches!(
        name,
        "find_orphans"
            | "list_unresolved_links"
            | "get_note_info"
            | "list_attachments"
            | "read_attachment"
            | "list_templates"
    )
}

pub fn is_write(name: &str) -> bool {
    matches!(
        name,
        "add_attachment"
            | "reorder_properties"
            | "bulk_set_property"
            | "bulk_move"
            | "daily_note"
            | "new_note_from_template"
    )
}

fn optional_limit(arguments: &Value) -> Result<usize, &'static str> {
    arguments.get("limit").map_or(Ok(100), |limit| {
        limit
            .as_u64()
            .filter(|n| (1..=1000).contains(n))
            .map(|n| n as usize)
            .ok_or("invalidArguments")
    })
}

fn optional_folder(arguments: &Value) -> Result<String, &'static str> {
    Ok(match arguments.get("folder") {
        None => String::new(),
        Some(_) => argument(arguments, "folder")?
            .replace('\\', "/")
            .trim_matches('/')
            .to_owned(),
    })
}

pub fn read(root: &Path, name: &str, arguments: &Value) -> Result<Value, &'static str> {
    if name == "list_templates" {
        validate_fields(arguments, &[], &[])?;
        return crate::daily::list(root);
    }
    let vault = ReadVault::open(root)?;
    match name {
        "find_orphans" | "list_unresolved_links" => {
            validate_fields(arguments, &[], &["folder", "limit"])?;
            let (folder, limit) = (optional_folder(arguments)?, optional_limit(arguments)?);
            if name == "find_orphans" {
                vault.orphans(&folder, limit)
            } else {
                vault.unresolved(&folder, limit)
            }
        }
        "get_note_info" | "list_attachments" => {
            validate_fields(arguments, &["id"], &[])?;
            let note = vault.note(argument(arguments, "id")?)?;
            if name == "get_note_info" {
                return vault.info(&note);
            }
            let file = Path::new(&note.path);
            let relative = file.strip_prefix(root).map_err(|_| "accessDenied")?;
            let relative = amby_core::vault::scan::normalize_rel_path(relative);
            let file = amby_core::index::read_only::visible_note(root, &relative)?;
            let content = std::fs::read_to_string(&file).map_err(|_| "invalidEncoding")?;
            Ok(json!({"note": relative, "attachments": attachments::list(root, &file, &content)}))
        }
        "read_attachment" => {
            validate_fields(arguments, &["path"], &[])?;
            let path = argument(arguments, "path")?.replace('\\', "/");
            let file = attachments::visible_attachment(root, &path)?;
            if file.extension().is_some_and(|ext| {
                ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown")
            }) {
                return Err("notAnAttachment");
            }
            let size = std::fs::metadata(&file).map_err(|_| "unavailable")?.len();
            let mime = attachments::mime_of(&path);
            let image = attachments::kind_of(&path) == "image" && mime != "image/svg+xml";
            if size
                > if image {
                    MAX_IMAGE_BYTES
                } else {
                    MAX_INLINE_BYTES
                }
            {
                return Err("resultTooLarge");
            }
            let bytes = std::fs::read(&file).map_err(|_| "unavailable")?;
            let data = base64::engine::general_purpose::STANDARD.encode(bytes);
            let mut result = json!({"path": path, "mimeType": mime, "size": size, "kind": attachments::kind_of(&path)});
            if image {
                result[amby_core::mcp::EXTRA_CONTENT] =
                    json!([{"type":"image","data":data,"mimeType":mime}]);
            } else {
                result["data"] = json!(data);
            }
            Ok(result)
        }
        _ => Err("unknownTool"),
    }
}

pub fn write(
    root: &Path,
    scope: &Path,
    grant: &str,
    name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let dry_run = || {
        arguments
            .get("dryRun")
            .map_or(Ok(false), |value| value.as_bool().ok_or("invalidArguments"))
    };
    let optional = |field: &str| match arguments.get(field) {
        None => Ok(None),
        Some(value) => value.as_str().map(Some).ok_or("invalidArguments"),
    };
    match name {
        "new_note_from_template" => {
            validate_fields(arguments, &["path", "template"], &["dryRun"])?;
            let result = crate::daily::new_from_template(
                root,
                Some(scope),
                argument(arguments, "path")?,
                argument(arguments, "template")?,
                dry_run()?,
                true,
            )?;
            Ok(json!(result))
        }
        "daily_note" => {
            validate_fields(
                arguments,
                &[],
                &["date", "folder", "template", "append", "dryRun"],
            )?;
            let moment = match optional("date")? {
                Some(date) => crate::daily::Moment::on(date).ok_or("invalidArguments")?,
                None => crate::daily::Moment::now(),
            };
            let request = crate::daily::Daily {
                moment,
                folder: optional("folder")?,
                template: optional("template")?,
                append: optional("append")?,
                dry_run: dry_run()?,
            };
            Ok(crate::daily::daily(root, Some(scope), request, true)?)
        }
        "add_attachment" => {
            validate_fields(arguments, &["path", "name", "data"], &["link"])?;
            let data = arguments
                .get("data")
                .and_then(Value::as_str)
                .ok_or("invalidArguments")?;
            if data.len() > 36 * 1024 * 1024 {
                return Err("attachmentTooLarge".into());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.trim())
                .map_err(|_| "invalidArguments")?;
            let link = arguments
                .get("link")
                .map_or(Ok(true), |link| link.as_bool().ok_or("invalidArguments"))?;
            mcp_tools::attach(
                root,
                scope,
                argument(arguments, "path")?,
                argument(arguments, "name")?,
                Source::Bytes(&bytes),
                link,
                true,
            )
            .map_err(str::to_owned)
        }
        "reorder_properties" => {
            validate_fields(arguments, &["path", "names"], &[])?;
            let names: Vec<String> = serde_json::from_value(arguments["names"].clone())
                .map_err(|_| "invalidArguments")?;
            mcp_tools::execute(
                root,
                grant,
                amby_core::vault_tools::Mutation::ReorderProperties {
                    path: argument(arguments, "path")?.to_owned(),
                    names,
                },
            )
        }
        "bulk_set_property" | "bulk_move" => {
            let (required, optional): (&[&str], &[&str]) = if name == "bulk_move" {
                (&["filter", "folder"], &["dryRun"])
            } else {
                (&["filter", "name", "value"], &["type", "dryRun"])
            };
            validate_fields(arguments, required, optional)?;
            let filter = arguments
                .get("filter")
                .filter(|f| f.is_object())
                .ok_or("invalidArguments")?;
            if filter.get("limit").is_some() {
                return Err("invalidArguments".into());
            }
            let filter = amby_core::ai_tools::filter_from(filter, root)?;
            let dry_run = arguments
                .get("dryRun")
                .map_or(Ok(false), |value| value.as_bool().ok_or("invalidArguments"))?;
            let op = if name == "bulk_move" {
                BulkOp::Move {
                    folder: argument(arguments, "folder")?
                        .replace('\\', "/")
                        .trim_matches('/')
                        .to_owned(),
                }
            } else {
                BulkOp::Set {
                    name: argument(arguments, "name")?.to_owned(),
                    value: arguments.get("value").cloned().ok_or("invalidArguments")?,
                    property_type: arguments
                        .get("type")
                        .map(|_| argument(arguments, "type").map(str::to_owned))
                        .transpose()?,
                }
            };
            mcp_tools::bulk(root, grant, filter, &op, dry_run)
        }
        _ => Err("unknownTool".into()),
    }
}

// ----- prompts -----

struct Prompt {
    name: &'static str,
    description: &'static str,
    argument: (&'static str, &'static str, bool),
    text: fn(&str) -> String,
}

const PROMPTS: [Prompt; 4] = [
    Prompt {
        name: "summarize_tag",
        description: "Summarize every note with a tag.",
        argument: ("tag", "The tag, without #.", true),
        text: |tag| {
            format!(
            "Use search_notes with tags [\"{tag}\"] (raise limit to 50) to find the notes tagged #{tag}. \
             Read each with read_note, then write a short summary grouped by theme, citing note paths. \
             Do not change any note."
        )
        },
    },
    Prompt {
        name: "tidy_folder",
        description: "Suggest tags, properties and moves for the notes of a folder.",
        argument: ("folder", "A vault-relative folder.", true),
        text: |folder| {
            format!(
            "List the notes of the folder \"{folder}\" with list_folder and read them with read_note and get_properties. \
             Propose consistent tags, properties and moves. Show the plan first; apply it only after I agree, \
             using bulk_set_property or bulk_move with dryRun before each real run."
        )
        },
    },
    Prompt {
        name: "fix_broken_links",
        description: "Find links to missing notes and propose fixes.",
        argument: (
            "folder",
            "Optional: only this vault-relative folder.",
            false,
        ),
        text: |folder| {
            format!(
            "Call list_unresolved_links{}. For each link, search_notes for a note that was probably meant \
             and propose either the correct target or a new note. Change nothing until I confirm; then edit \
             with write_note after reading the latest text.",
            if folder.is_empty() { String::new() } else { format!(" with folder \"{folder}\"") }
        )
        },
    },
    Prompt {
        name: "review_orphans",
        description: "Review notes nothing links to.",
        argument: (
            "folder",
            "Optional: only this vault-relative folder.",
            false,
        ),
        text: |folder| {
            format!(
            "Call find_orphans{}. Read each orphan and suggest which notes should link to it, which belong \
             in another folder, and which could be archived. Do not change anything without my confirmation.",
            if folder.is_empty() { String::new() } else { format!(" with folder \"{folder}\"") }
        )
        },
    },
];

pub fn prompts() -> Value {
    PROMPTS
        .iter()
        .map(|prompt| {
            let (name, description, required) = prompt.argument;
            json!({"name": prompt.name, "description": prompt.description,
                "arguments": [{"name": name, "description": description, "required": required}]})
        })
        .collect()
}

pub fn prompt(name: &str, arguments: &Value) -> Result<Value, &'static str> {
    let prompt = PROMPTS
        .iter()
        .find(|prompt| prompt.name == name)
        .ok_or("unknownPrompt")?;
    let (key, _, required) = prompt.argument;
    let value = arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if required && value.is_empty() || value.len() > 256 || value.contains(['"', '\n']) {
        return Err("invalidArguments");
    }
    Ok(json!({
        "description": prompt.description,
        "messages": [{"role": "user", "content": {"type": "text", "text": (prompt.text)(value)}}]
    }))
}
