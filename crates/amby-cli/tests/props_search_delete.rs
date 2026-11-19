//! Contract tests for note properties, filtered search, deletion and the MCP fixes
//! (docs/cli.md and docs/mcp.md). Written before the implementation: they check the
//! documented behaviour, not the code. Requirement IDs: P* properties, S* search,
//! D* deletion, M* MCP protocol.

mod common;

use common::*;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

// ----- properties -----

/// P1: `prop list` shows every header property with its value, items and type, by path,
/// title or ID, and reads without writing.
#[test]
fn p1_listing_reads_header_values_without_writing() {
    let vault = vault(true);
    for reference in ["Projects/Meeting.md", "Meeting", ID_MEETING] {
        let listing = vault.ok(&["prop", "list", reference]);
        assert_eq!(listing["path"], "Projects/Meeting.md");
        assert_eq!(listing["noteId"], ID_MEETING);
        assert_eq!(property(&listing, "status")["value"], "active");
        assert_eq!(
            property(&listing, "tags")["items"],
            json!(["work", "meeting"])
        );
        assert!(property(&listing, "status")["type"].is_string());
        assert!(listing["properties"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["name"] != "amby-id"));
    }
    assert_eq!(vault.read("Projects/Meeting.md"), MEETING);
    assert_eq!(vault.snapshots(), 0);
}

/// P2: setting an existing scalar rewrites only its line, keeps CRLF and the other bytes,
/// and takes a history snapshot first.
#[test]
fn p2_set_existing_value_rewrites_only_its_line() {
    let vault = vault(true);
    let after = vault.ok(&["prop", "set", "Meeting", "status", "paused"]);
    assert_eq!(property(&after, "status")["value"], "paused");
    assert_eq!(
        vault.read("Projects/Meeting.md"),
        MEETING.replace("status: active", "status: paused")
    );
    assert_eq!(vault.snapshots(), 1);
}

/// P3: setting a missing property creates it with the requested type; several values make
/// a list; no value clears it.
#[test]
fn p3_set_creates_typed_and_list_properties_and_clears() {
    let vault = vault(true);
    let created = vault.ok(&[
        "prop", "set", "Meeting", "priority", "3", "--type", "number",
    ]);
    assert_eq!(property(&created, "priority")["value"], "3");
    assert_eq!(property(&created, "priority")["type"], "number");
    assert!(vault.read("Projects/Meeting.md").contains("priority: 3"));

    let listed = vault.ok(&["prop", "set", "Meeting", "people", "Ann", "Bob"]);
    assert_eq!(property(&listed, "people")["items"], json!(["Ann", "Bob"]));
    assert_eq!(property(&listed, "people")["type"], "list");

    let cleared = vault.ok(&["prop", "set", "Meeting", "status"]);
    assert_eq!(property(&cleared, "status")["value"], "");
    // The other lines survive every write.
    let text = vault.read("Projects/Meeting.md");
    assert!(
        text.contains("amby-id: 01JC0000000000000000000001"),
        "{text}"
    );
    assert!(text.ends_with("Agenda for [[Plan]]. #todo\r\n"), "{text}");
}

/// P4: the presentation (type, icon, settings as JSON) is stored outside the header; the
/// header bytes stay as they are.
#[test]
fn p4_style_writes_presentation_json_but_not_the_header() {
    let vault = vault(true);
    let settings =
        r#"{"options":["active","paused","done"],"default":"active","colors":{"active":"green"}}"#;
    let styled = vault.ok(&[
        "prop",
        "style",
        "Meeting",
        "status",
        "--type",
        "select",
        "--icon",
        "amby-icon:circle-chevron-down:",
        "--settings",
        settings,
    ]);
    let status = property(&styled, "status");
    assert_eq!(status["type"], "select");
    assert_eq!(status["icon"], "amby-icon:circle-chevron-down:");
    assert_eq!(
        status["settings"]["options"],
        json!(["active", "paused", "done"])
    );
    assert_eq!(status["settings"]["colors"]["active"], "green");
    assert_eq!(vault.read("Projects/Meeting.md"), MEETING);
    let groups: Vec<_> = fs::read_dir(vault.root.join(".amby/properties"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name != "layout.json")
        .collect();
    assert_eq!(groups.len(), 1, "{groups:?}");
    // A second read sees the stored presentation.
    let again = vault.ok(&["prop", "list", "Meeting"]);
    assert_eq!(property(&again, "status")["settings"]["default"], "active");
}

/// P5: invalid presentation input is refused before anything is written.
#[test]
fn p5_invalid_presentation_is_refused() {
    let vault = vault(true);
    for args in [
        &[
            "prop",
            "style",
            "Meeting",
            "status",
            "--settings",
            "not json",
        ][..],
        &["prop", "style", "Meeting", "status", "--settings", "[1,2]"],
        &[
            "prop",
            "style",
            "Meeting",
            "status",
            "--settings",
            r#"{"options":[1]}"#,
        ],
        &[
            "prop",
            "style",
            "Meeting",
            "status",
            "--settings",
            r#"{"unknown":true}"#,
        ],
        &["prop", "style", "Meeting", "status", "--type", "spaceship"],
        &["prop", "style", "Meeting", "status"],
        &[
            "prop",
            "set",
            "Meeting",
            "rating",
            "x",
            "--type",
            "spaceship",
        ],
    ] {
        assert_eq!(
            vault.error(args),
            (Some(2), "invalidArguments".into()),
            "{args:?}"
        );
    }
    assert_eq!(vault.read("Projects/Meeting.md"), MEETING);
    assert_eq!(vault.snapshots(), 0);
}

/// P6: rename keeps the value under the new key; delete removes the key after a history
/// snapshot of the note.
#[test]
fn p6_rename_and_delete_properties() {
    let vault = vault(true);
    let renamed = vault.ok(&["prop", "rename", "Meeting", "status", "state"]);
    assert_eq!(property(&renamed, "state")["value"], "active");
    let text = vault.read("Projects/Meeting.md");
    assert!(
        text.contains("state: active") && !text.contains("status:"),
        "{text}"
    );

    let (code, error) = vault.error(&["prop", "rename", "Meeting", "state", "tags"]);
    assert_eq!((code, error.as_str()), (Some(6), "alreadyExists"));

    let before = vault.snapshots();
    let deleted = vault.ok(&["prop", "delete", "Meeting", "state"]);
    assert!(deleted["properties"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["name"] != "state"));
    assert!(!vault.read("Projects/Meeting.md").contains("state:"));
    // The previous header stays restorable from the note's history.
    assert_eq!(vault.snapshots(), before + 1);

    let (code, error) = vault.error(&["prop", "delete", "Meeting", "missing"]);
    assert_eq!((code, error.as_str()), (Some(3), "propertyNotFound"));
}

/// P7: a vault whose properties were never migrated reads its header but refuses writes.
#[test]
fn p7_unmigrated_vault_is_read_only() {
    let vault = vault(false);
    let listing = vault.ok(&["prop", "list", "Meeting"]);
    assert_eq!(listing["readOnly"], true);
    assert_eq!(property(&listing, "status")["value"], "active");
    let (code, error) = vault.error(&["prop", "set", "Meeting", "status", "x"]);
    assert_eq!((code, error.as_str()), (Some(1), "propertiesNotMigrated"));
    assert_eq!(vault.read("Projects/Meeting.md"), MEETING);
}

/// P8: a note without `amby-id` gets value edits in its header (no ID is added), but no
/// presentation, which is keyed by the ID.
#[test]
fn p8_note_without_id_edits_values_only() {
    let vault = vault(true);
    let after = vault.ok(&["prop", "set", "Daily/My note.md", "status", "done"]);
    assert_eq!(property(&after, "status")["value"], "done");
    assert_eq!(after["noteId"], Value::Null);
    let text = vault.read("Daily/My note.md");
    assert!(text.starts_with("---\nstatus: done\n---\n"), "{text}");
    assert!(!text.contains("amby-id"), "{text}");
    let (code, error) = vault.error(&["prop", "style", "My note", "status", "--icon", "x"]);
    assert_eq!((code, error.as_str()), (Some(1), "noteWithoutId"));
}

/// P9: MCP reads properties without a grant, writes them only inside the grant, and takes
/// presentation settings as a JSON object.
#[test]
fn p9_mcp_property_tools_follow_the_grant() {
    let vault = vault(true);
    let read_only = vault.tool_names(None);
    assert!(
        read_only.contains(&"get_properties".into()),
        "{read_only:?}"
    );
    assert!(!read_only.contains(&"set_property".into()));

    let listing = vault.tool(
        None,
        "get_properties",
        json!({"path":"Projects/Meeting.md"}),
    );
    assert_eq!(property(&listing, "status")["value"], "active");

    let grant = Some("--allow-write=Projects");
    let tools = vault.tool_names(grant);
    for name in [
        "set_property",
        "set_property_appearance",
        "rename_property",
        "delete_property",
    ] {
        assert!(tools.contains(&name.into()), "{name}: {tools:?}");
    }
    let outside = vault.tool(
        grant,
        "set_property",
        json!({"path":"Daily/My note.md","name":"status","value":"x"}),
    );
    assert_eq!(outside["error"], "outsideWriteScope", "{outside}");

    let listed = vault.tool(
        grant,
        "set_property",
        json!({"path":"Projects/Meeting.md","name":"people","value":["Ann","Bob"]}),
    );
    assert_eq!(
        property(&listed, "people")["items"],
        json!(["Ann", "Bob"]),
        "{listed}"
    );
    let flag = vault.tool(
        grant,
        "set_property",
        json!({"path":"Projects/Meeting.md","name":"urgent","value":true}),
    );
    assert_eq!(property(&flag, "urgent")["type"], "checkbox", "{flag}");

    let styled = vault.tool(
        grant,
        "set_property_appearance",
        json!({"path":"Projects/Meeting.md","name":"status","type":"select",
            "settings":{"options":["active","done"],"colors":{"done":"blue"}}}),
    );
    assert_eq!(
        property(&styled, "status")["settings"]["colors"]["done"],
        "blue",
        "{styled}"
    );
    let bad = vault.tool(
        grant,
        "set_property_appearance",
        json!({"path":"Projects/Meeting.md","name":"status","settings":"options"}),
    );
    assert_eq!(bad["error"], "invalidArguments", "{bad}");

    let deleted = vault.tool(
        grant,
        "delete_property",
        json!({"path":"Projects/Meeting.md","name":"urgent"}),
    );
    assert!(deleted["properties"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["name"] != "urgent"));
}

// ----- search -----

/// S1: the CLI filters by tag, property (with or without a value) and folder, with or
/// without a text query; results carry the path.
#[test]
fn s1_cli_search_filters() {
    let vault = vault(true);
    let search = |args: &[&str]| {
        let mut all = vec!["search"];
        all.extend_from_slice(args);
        paths(&vault.ok(&all)["results"])
    };
    assert_eq!(
        search(&["--tag", "work"]),
        ["Daily/My note.md", "Projects/Meeting.md"]
    );
    assert_eq!(
        search(&["--tag", "WORK", "--tag", "todo"]),
        ["Projects/Meeting.md"]
    );
    assert_eq!(
        search(&["--property", "status=active"]),
        ["Daily/My note.md", "Projects/Meeting.md"]
    );
    assert_eq!(search(&["--property", "Status=DONE"]), ["Projects/Plan.md"]);
    fs::write(
        vault.root.join("Daily/Задача.md"),
        "---\nСтатус: В работе\n---\n# Задача\n\n#Работа\n",
    )
    .unwrap();
    assert_eq!(
        search(&["--property", "статус=в РАБОТЕ"]),
        ["Daily/Задача.md"]
    );
    assert_eq!(search(&["--tag", "работа"]), ["Daily/Задача.md"]);
    fs::remove_file(vault.root.join("Daily/Задача.md")).unwrap();
    assert_eq!(
        search(&["--property", "tags=meeting"]),
        ["Projects/Meeting.md"]
    );
    assert_eq!(
        search(&["--property", "status", "--folder", "Projects"]),
        ["Projects/Meeting.md", "Projects/Plan.md"]
    );
    assert_eq!(
        search(&["agenda", "--property", "status=active"]),
        ["Projects/Meeting.md"]
    );
    assert!(search(&["agenda", "--folder", "Daily"]).is_empty());
    assert_eq!(search(&["--tag", "work", "--limit", "1"]).len(), 1);
    assert_eq!(vault.error(&["search"]), (Some(2), "usage".into()));
    assert_eq!(
        vault.error(&["search", "--folder", ".amby"]),
        (Some(5), "accessDenied".into())
    );
    assert!(!vault.root.join(".amby/notes.db").exists());
}

/// S2, M3: MCP search takes the same filters and returns path, snippet and match type.
#[test]
fn s2_mcp_search_filters_and_result_fields() {
    let vault = vault(true);
    let found = vault.tool(None, "search_notes", json!({"query":"agenda"}));
    let hit = &found["notes"][0];
    assert_eq!(hit["path"], "Projects/Meeting.md", "{found}");
    assert_eq!(hit["title"], "Meeting");
    assert!(
        hit["snippet"].as_str().unwrap().contains("Agenda"),
        "{found}"
    );
    assert!(hit["matchType"].is_string());
    let filtered = vault.tool(
        None,
        "search_notes",
        json!({"tags":["work"],"properties":[{"name":"status","value":"active"}],"folder":"Daily"}),
    );
    assert_eq!(
        paths(&filtered["notes"]),
        ["Daily/My note.md"],
        "{filtered}"
    );
    let empty = vault.tool(None, "search_notes", json!({}));
    assert_eq!(empty["error"], "invalidArguments", "{empty}");
}

/// M2, M5: notes can be named by path in read tools, and tags are listed.
#[test]
fn m2_read_tools_accept_paths_and_list_tags() {
    let vault = vault(true);
    let read = vault.tool(None, "read_note", json!({"id":"Projects/Meeting.md"}));
    assert!(
        read["content"].as_str().unwrap().contains("Agenda"),
        "{read}"
    );
    assert_eq!(read["path"], "Projects/Meeting.md", "{read}");
    let by_id = vault.tool(None, "read_note", json!({"id":ID_MEETING}));
    assert_eq!(by_id["path"], "Projects/Meeting.md", "{by_id}");
    let links = vault.tool(None, "get_links", json!({"id":"Projects/Plan.md"}));
    assert!(links.to_string().contains("Projects/Meeting.md"), "{links}");
    let hidden = vault.tool(
        None,
        "read_note",
        json!({"id":".amby/properties/layout.json"}),
    );
    assert!(hidden["error"].is_string(), "{hidden}");
    let tags = vault.tool(None, "list_tags", json!({}));
    let work = tags["tags"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tag| tag["tag"] == "work")
        .unwrap_or_else(|| panic!("{tags}"));
    assert_eq!(work["count"], 2);
}

/// M1: the server and `--version` report the application version.
#[test]
fn m1_version_is_the_application_version() {
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json"))
            .unwrap(),
    )
    .unwrap();
    let version = manifest["version"].as_str().unwrap();
    let vault = vault(true);
    let replies = vault.mcp(None, &[]);
    assert_eq!(replies[0]["result"]["serverInfo"]["version"], version);
    assert_eq!(vault.ok(&["--version"])["version"], version);
}

/// M4: notes are MCP resources; service files are not.
#[test]
fn m4_notes_are_resources() {
    let vault = vault(true);
    let replies = vault.mcp(
        None,
        &[
            json!({"jsonrpc":"2.0","id":1,"method":"resources/list"}),
            json!({"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"amby://vault/Daily/My%20note.md"}}),
            json!({"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"amby://vault/.amby/properties/layout.json"}}),
            json!({"jsonrpc":"2.0","id":4,"method":"resources/templates/list"}),
        ],
    );
    assert!(replies[0]["result"]["capabilities"]["resources"].is_object());
    let uris: Vec<&str> = replies[1]["result"]["resources"]
        .as_array()
        .unwrap_or_else(|| panic!("{}", replies[1]))
        .iter()
        .map(|resource| resource["uri"].as_str().unwrap())
        .collect();
    assert!(
        uris.contains(&"amby://vault/Projects/Meeting.md"),
        "{uris:?}"
    );
    assert!(
        uris.contains(&"amby://vault/Daily/My%20note.md"),
        "{uris:?}"
    );
    assert!(uris.iter().all(|uri| !uri.contains(".amby")));
    let contents = &replies[2]["result"]["contents"][0];
    assert_eq!(contents["mimeType"], "text/markdown");
    assert!(contents["text"].as_str().unwrap().contains("Worked on"));
    assert!(replies[3]["error"].is_object(), "{}", replies[3]);
    assert!(
        replies[4]["result"]["resourceTemplates"].is_array(),
        "{}",
        replies[4]
    );
}

// ----- deletion -----

/// D1: a deletion preview names what would go and changes nothing; the grant and the
/// visible vault confine deletion.
#[test]
fn d1_delete_preview_and_scope() {
    let vault = vault(true);
    let preview = vault.ok(&["delete", "Projects/Plan.md", "--dry-run"]);
    assert_eq!(
        preview["affectedPaths"],
        json!(["Projects/Plan.md"]),
        "{preview}"
    );
    assert!(vault.root.join("Projects/Plan.md").exists());
    let folder = vault.ok(&["delete", "Projects", "--dry-run"]);
    let mut affected: Vec<&str> = folder["affectedPaths"]
        .as_array()
        .unwrap_or_else(|| panic!("{folder}"))
        .iter()
        .map(|path| path.as_str().unwrap())
        .collect();
    affected.sort_unstable();
    assert_eq!(
        affected,
        ["Projects", "Projects/Meeting.md", "Projects/Plan.md"]
    );
    assert_eq!(
        vault.error(&["delete", ".", "--dry-run"]),
        (Some(5), "accessDenied".into())
    );
    assert_eq!(
        vault.error(&["delete", ".amby/properties", "--dry-run"]),
        (Some(5), "accessDenied".into())
    );
    assert_eq!(
        vault.error(&["delete", "Nope.md", "--dry-run"]),
        (Some(3), "notFound".into())
    );

    let read_only = vault.tool_names(None);
    assert!(!read_only.contains(&"delete_item".into()));
    let grant = Some("--allow-write=Projects");
    assert!(vault.tool_names(grant).contains(&"delete_item".into()));
    let outside = vault.tool(grant, "delete_item", json!({"path":"Daily/My note.md"}));
    assert_eq!(outside["error"], "outsideWriteScope", "{outside}");
    let root = vault.tool(
        grant,
        "delete_item",
        json!({"path":"Projects","dryRun":true}),
    );
    assert_eq!(root["error"], "outsideWriteScope", "{root}");
    let preview = vault.tool(
        grant,
        "delete_item",
        json!({"path":"Projects/Plan.md","dryRun":true}),
    );
    assert_eq!(
        preview["affectedPaths"],
        json!(["Projects/Plan.md"]),
        "{preview}"
    );
    assert!(vault.root.join("Daily/My note.md").exists());
    assert!(vault.root.join("Projects/Plan.md").exists());
}
