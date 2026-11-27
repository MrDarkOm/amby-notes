//! The tool schemas every Amby surface offers: the `amby mcp` server, the desktop AI panel's
//! bridge and the API providers. One definition per tool; who may call it is decided by the
//! caller (the MCP server's write grant, the panel's `ToolScope`).

use serde_json::{json, Value};

use crate::vault_tools::modules::Module;

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

pub const DOMAIN_WRITES: [DomainTool; 14] = [
    ("create_database", "Create an empty standalone database in an existing folder. Use . for the vault root.", &["parent", "name"], Some(Module::Databases)),
    ("create_database_row", "Create a blank row in a database.", &["databaseId", "title"], Some(Module::Databases)),
    ("delete_database_row", "Move a database row's note to the system trash, where the user can restore it. Use dryRun to list what would be removed.", &["databaseId", "noteId"], Some(Module::Databases)),
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
        "delete_database_row" => {
            properties["dryRun"] = json!({"type":"boolean","description":"Show the affected paths without changing the vault."});
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
    let types = json!({"enum": crate::vault_tools::properties::PROPERTY_TYPES});
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

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

fn tool(name: &str, description: &str, input: Value, read_only: bool, destructive: bool) -> Value {
    json!({
        "name": name, "description": description, "inputSchema": input,
        "annotations": {"readOnlyHint": read_only, "openWorldHint": false, "destructiveHint": destructive}
    })
}

fn path_field() -> Value {
    json!({"type":"string","minLength":1,"maxLength":1024,"description":"A vault-relative Markdown path."})
}

fn id_field() -> Value {
    json!({"type":"string","minLength":26,"maxLength":26,"description":"A version ID from list_versions."})
}

pub fn notes_read_definitions() -> Vec<Value> {
    vec![
        tool("get_outline", "List a note's headings with their level and line, to read a long note by parts.", schema(json!({"path":path_field()}), &["path"]), true, false),
        tool("read_section", "Read one section of a note: its heading line and everything under it up to the next heading of the same or a higher level. Headings are matched without case; use occurrence when several are equal.", schema(json!({"path":path_field(),"heading":{"type":"string","minLength":1,"maxLength":1024},"occurrence":{"type":"integer","minimum":1,"maximum":1000}}), &["path","heading"]), true, false),
        tool("list_versions", "List the earlier versions history keeps of a note, newest first (at most 50). Every AI edit leaves one with reason ai-edit.", schema(json!({"path":path_field()}), &["path"]), true, false),
        tool("read_version", "Read the text of one earlier version of a note.", schema(json!({"id":id_field()}), &["id"]), true, false),
        tool("open_in_amby", "Show a note to the user in desktop Amby. Nothing in the vault changes.", schema(json!({"path":path_field()}), &["path"]), true, false),
    ]
}

pub fn notes_write_definitions() -> Vec<Value> {
    vec![
        tool("edit_note", "Replace an exact fragment of a note's body with new text, without rewriting the rest. oldText must occur once unless replaceAll is true; copy it from read_note or read_section. The header (frontmatter) is not edited here. The previous text stays in the note's history.", schema(json!({
            "path":path_field(),
            "oldText":{"type":"string","minLength":1},
            "newText":{"type":"string"},
            "replaceAll":{"type":"boolean"},
            "dryRun":{"type":"boolean","description":"Return a diff without writing."}
        }), &["path","oldText","newText"]), false, false),
        tool("restore_version", "Put an earlier version back as the note's text. The current text is kept as a new version first, so the restore can be undone the same way.", schema(json!({
            "id":id_field(),
            "dryRun":{"type":"boolean","description":"Check the version without writing."}
        }), &["id"]), false, false),
    ]
}

fn plain_tool(name: &str, description: &str, input: Value, read_only: bool) -> Value {
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

pub fn extra_read_definitions() -> Vec<Value> {
    let folder = json!({"type":"string","maxLength":1024,"description":"A vault-relative folder."});
    let limit = json!({"type":"integer","minimum":1,"maximum":1000});
    let note = json!({"type":"string","minLength":1,"maxLength":1024,"description":"A note ID or a vault-relative Markdown path."});
    vec![
        plain_tool("find_orphans", "List notes that no other note links to.", schema(json!({"folder":folder,"limit":limit}), &[]), true),
        plain_tool("list_unresolved_links", "List links to notes that do not exist, with the note holding each. Links to existing attachments are not listed.", schema(json!({"folder":folder,"limit":limit}), &[]), true),
        plain_tool("get_note_info", "Summarize a note: path, ID, size, words, dates, tags, link counts, property count and attachments.", schema(json!({"id":note}), &["id"]), true),
        plain_tool("list_attachments", "List the local files a note links or embeds, with kind, size and whether each exists.", schema(json!({"id":note}), &["id"]), true),
        plain_tool("list_templates", "List the note templates in the Templates folder, by name and path. Placeholders {{title}}, {{date}} and {{time}} are filled in when a note is made from one.", schema(json!({}), &[]), true),
        plain_tool("read_attachment", "Read an attachment by vault-relative path. Images up to 10 MiB come back as image content; other files up to 128 KiB as base64 data.", schema(json!({"path":{"type":"string","minLength":1,"maxLength":1024}}), &["path"]), true),
    ]
}

pub fn extra_write_definitions() -> Vec<Value> {
    let path = json!({"type":"string","minLength":1,"maxLength":1024,"description":"A vault-relative Markdown path."});
    let value = json!({"type":["string","number","boolean","array","null"],"items":{"type":["string","number","boolean"]},"maxItems":100});
    let dry_run = json!({"type":"boolean","description":"List the notes without changing them."});
    vec![
        plain_tool("add_attachment", "Add a file to a note from base64 data, under a new name in the note's assets folder, and link it from the note (an image is embedded). It never replaces a file.", schema(json!({
            "path":path,"name":{"type":"string","minLength":1,"maxLength":255,"description":"The original file name; its extension sets the type."},
            "data":{"type":"string","description":"Base64 contents, up to 25 MiB decoded."},
            "link":{"type":"boolean","description":"Append a link to the note (default true)."}}), &["path","name","data"]), false),
        plain_tool("new_note_from_template", "Create a note at a vault-relative path from a template (a name from list_templates or a vault path). The note gets its own ID; the template is not changed.", schema(json!({
            "path":path,"template":{"type":"string","minLength":1,"maxLength":1024},"dryRun":dry_run}), &["path","template"]), false),
        plain_tool("daily_note", "Open the note for a day (Daily/YYYY-MM-DD.md, created when missing, from a template if given) and optionally append Markdown to it.", schema(json!({
            "date":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$","description":"The day; today (local time) when omitted."},
            "folder":{"type":"string","maxLength":1024,"description":"The folder for daily notes (default Daily; . for the root)."},
            "template":{"type":"string","minLength":1,"maxLength":1024},
            "append":{"type":"string","description":"Markdown to add at the end."},"dryRun":dry_run}), &[]), false),
        plain_tool("reorder_properties", "Set the order of a note's properties by name. Names left out keep their relative order after these.", schema(json!({
            "path":path,"names":{"type":"array","items":{"type":"string","minLength":1,"maxLength":256},"minItems":1,"maxItems":100}}), &["path","names"]), false),
        plain_tool("bulk_set_property", "Set one property on every note a filter finds, at most 200. Each note is changed on its own; the result reports each one.", schema(json!({
            "filter":filter_schema(),"name":{"type":"string","minLength":1,"maxLength":256},"value":value,
            "type":{"enum":crate::vault_tools::properties::PROPERTY_TYPES},"dryRun":dry_run}), &["filter","name","value"]), false),
        plain_tool("bulk_move", "Move every note a filter finds, at most 200, into an existing folder (. for the root), updating links. Each note moves on its own.", schema(json!({
            "filter":filter_schema(),"folder":{"type":"string","minLength":1,"maxLength":1024},"dryRun":dry_run}), &["filter","folder"]), false),
    ]
}

/// The workspace module a tool belongs to; a switched-off module hides its tools.
pub fn module_of(name: &str) -> Option<crate::vault_tools::modules::Module> {
    use crate::vault_tools::modules::Module;
    match name {
        "list_templates" | "new_note_from_template" => Some(Module::Templates),
        "daily_note" => Some(Module::Daily),
        _ => None,
    }
}
