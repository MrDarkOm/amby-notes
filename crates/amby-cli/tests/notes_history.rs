//! MCP contract for working inside a note: fragment edits, outline and sections, versions,
//! opening in desktop Amby, and deleting a database row (docs/mcp.md).

mod common;

use common::*;
use serde_json::json;
use std::fs;

const WRITE: Option<&str> = Some("--allow-write");
const PROJECTS: Option<&str> = Some("--allow-write=Projects");

#[test]
fn n1_new_tools_are_offered_by_grant() {
    let vault = vault(true);
    let read_only = vault.tool_names(None);
    for name in [
        "get_outline",
        "read_section",
        "list_versions",
        "read_version",
        "open_in_amby",
    ] {
        assert!(read_only.contains(&name.to_owned()), "{name}");
    }
    for name in ["edit_note", "restore_version", "delete_database_row"] {
        assert!(!read_only.contains(&name.to_owned()), "{name}");
        assert!(vault.tool_names(WRITE).contains(&name.to_owned()), "{name}");
    }
}

#[test]
fn n2_edit_note_replaces_one_fragment_and_keeps_the_crlf_header() {
    let vault = vault(true);
    let preview = vault.tool(
        WRITE,
        "edit_note",
        json!({"path":"Projects/Meeting.md","oldText":"Agenda for","newText":"Notes on","dryRun":true}),
    );
    assert_eq!(preview["replacements"], 1, "{preview}");
    assert!(
        preview["diff"]
            .as_str()
            .is_some_and(|d| d.contains("+Notes on")),
        "{preview}"
    );
    assert_eq!(vault.read("Projects/Meeting.md"), MEETING);

    let done = vault.tool(
        WRITE,
        "edit_note",
        json!({"path":"Projects/Meeting.md","oldText":"# Meeting\n\nAgenda","newText":"# Meeting\n\nThe agenda"}),
    );
    assert!(done["snapshotId"].is_string(), "{done}");
    assert_eq!(
        vault.read("Projects/Meeting.md"),
        MEETING.replace("\r\nAgenda", "\r\nThe agenda")
    );

    for (old, code) in [("status: active", "textNotFound"), ("e", "textNotUnique")] {
        let refused = vault.tool(
            WRITE,
            "edit_note",
            json!({"path":"Projects/Meeting.md","oldText":old,"newText":"x"}),
        );
        assert_eq!(refused["error"], code, "{refused}");
    }
    let outside = vault.tool(
        PROJECTS,
        "edit_note",
        json!({"path":"Daily/My note.md","oldText":"a","newText":"b"}),
    );
    assert!(outside["error"].is_string(), "{outside}");
}

#[test]
fn n3_an_ai_edit_is_listed_and_restored() {
    let vault = vault(true);
    vault.tool(
        WRITE,
        "edit_note",
        json!({"path":"Projects/Meeting.md","oldText":"Agenda","newText":"Plan"}),
    );
    let versions = vault.tool(None, "list_versions", json!({"path":"Projects/Meeting.md"}));
    assert_eq!(versions["versions"][0]["reason"], "ai-edit", "{versions}");
    let id = versions["versions"][0]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("{versions}"))
        .to_owned();
    let text = vault.tool(None, "read_version", json!({"id":id}));
    assert_eq!(text["content"], MEETING, "{text}");

    let read_only = vault.tool(None, "restore_version", json!({"id":id}));
    assert!(read_only["error"].is_string(), "{read_only}");
    let preview = vault.tool(WRITE, "restore_version", json!({"id":id,"dryRun":true}));
    assert_eq!(preview["changed"], true, "{preview}");
    assert_ne!(vault.read("Projects/Meeting.md"), MEETING);
    let restored = vault.tool(PROJECTS, "restore_version", json!({"id":id}));
    assert_eq!(restored["restored"], true, "{restored}");
    assert_eq!(vault.read("Projects/Meeting.md"), MEETING);
    let after = vault.tool(None, "list_versions", json!({"path":"Projects/Meeting.md"}));
    assert_eq!(after["total"], 2, "{after}");
}

#[test]
fn n4_outline_and_section_read_a_note_by_parts() {
    let vault = vault(true);
    fs::write(
        vault.root.join("Projects/Long.md"),
        "# Long\nintro\n## Goals\none\n### Detail\ntwo\n## Risks\nthree\n",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    let outline = vault.tool(None, "get_outline", json!({"path":"Projects/Long.md"}));
    assert_eq!(outline["total"], 4, "{outline}");
    assert_eq!(
        outline["headings"][1],
        json!({"level":2,"text":"Goals","line":3})
    );
    let goals = vault.tool(
        None,
        "read_section",
        json!({"path":"Projects/Long.md","heading":"goals"}),
    );
    assert_eq!(
        goals["content"], "## Goals\none\n### Detail\ntwo\n",
        "{goals}"
    );
    let missing = vault.tool(
        None,
        "read_section",
        json!({"path":"Projects/Long.md","heading":"Nope"}),
    );
    assert_eq!(missing["error"], "headingNotFound", "{missing}");
}

#[test]
fn n5_open_in_amby_refuses_hidden_and_missing_notes() {
    let vault = vault(true);
    for path in [".amby/properties/layout.json", "Projects/Nope.md"] {
        let refused = vault.tool(None, "open_in_amby", json!({"path":path}));
        assert!(refused["error"].is_string(), "{path}: {refused}");
    }
}

#[test]
fn n6_delete_database_row_previews_inside_the_grant_only() {
    let vault = vault(true);
    fs::create_dir_all(vault.root.join("Projects/Work")).unwrap_or_else(|error| panic!("{error}"));
    let db = vault.tool(
        WRITE,
        "create_database",
        json!({"parent":"Daily","name":"Log"}),
    );
    let db_id = db["databaseId"].as_str().unwrap_or_else(|| panic!("{db}"));
    let row = vault.tool(
        WRITE,
        "create_database_row",
        json!({"databaseId":db_id,"title":"Entry"}),
    );
    let request = json!({"databaseId":db_id,"noteId":row["noteId"],"dryRun":true});
    let preview = vault.tool(WRITE, "delete_database_row", request.clone());
    assert_eq!(preview["destination"], "systemTrash", "{preview}");
    assert_eq!(preview["affectedPaths"], json!([row["path"]]), "{preview}");
    let outside = vault.tool(PROJECTS, "delete_database_row", request);
    assert_eq!(outside["error"], "outsideWriteScope", "{outside}");
    let missing = vault.tool(
        WRITE,
        "delete_database_row",
        json!({"databaseId":db_id,"noteId":"01JC0000000000000000000099","dryRun":true}),
    );
    assert!(missing["error"].is_string(), "{missing}");
    assert!(vault
        .root
        .join(row["path"].as_str().unwrap_or_default())
        .exists());
}

#[test]
fn n7_a_subscribed_note_reports_its_change_and_an_unsubscribed_one_does_not() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    let vault = vault(true);
    let mut child = Command::new(env!("CARGO_BIN_EXE_amby"))
        .env("AMBY_APP_DATA_DIR", &vault.home)
        .arg("--vault")
        .arg(&vault.root)
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap_or_else(|error| panic!("{error}"));
    let mut input = child.stdin.take().unwrap_or_else(|| panic!("stdin"));
    let stdout = child.stdout.take().unwrap_or_else(|| panic!("stdout"));
    let (lines, received) = mpsc::channel::<serde_json::Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str(&line) {
                if lines.send(value).is_err() {
                    return;
                }
            }
        }
    });
    let next = || {
        received
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|error| panic!("no message: {error}"))
    };
    let mut send = |message: serde_json::Value| {
        writeln!(input, "{message}").unwrap_or_else(|error| panic!("{error}"));
    };
    send(
        json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}),
    );
    let init = next();
    assert_eq!(
        init["result"]["capabilities"]["resources"]["subscribe"], true,
        "{init}"
    );
    for (id, uri) in [
        (1, "amby://vault/Projects/Meeting.md"),
        (2, "amby://vault/Projects/Plan.md"),
    ] {
        send(json!({"jsonrpc":"2.0","id":id,"method":"resources/subscribe","params":{"uri":uri}}));
        assert_eq!(next()["result"], json!({}));
    }
    send(
        json!({"jsonrpc":"2.0","id":3,"method":"resources/subscribe","params":{"uri":"amby://vault/.amby/x.md"}}),
    );
    assert!(next()["error"].is_object());
    send(
        json!({"jsonrpc":"2.0","id":4,"method":"resources/unsubscribe","params":{"uri":"amby://vault/Projects/Plan.md"}}),
    );
    assert_eq!(next()["result"], json!({}));

    fs::write(vault.root.join("Projects/Plan.md"), "changed plan\n")
        .unwrap_or_else(|e| panic!("{e}"));
    fs::write(
        vault.root.join("Projects/Meeting.md"),
        "changed meeting, longer\n",
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let note = next();
    assert_eq!(note["method"], "notifications/resources/updated", "{note}");
    assert_eq!(
        note["params"]["uri"], "amby://vault/Projects/Meeting.md",
        "{note}"
    );
    assert!(received.recv_timeout(Duration::from_millis(2500)).is_err());
    drop(send);
    drop(input);
    assert!(child.wait().unwrap_or_else(|e| panic!("{e}")).success());
}
