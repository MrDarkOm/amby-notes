//! Contract tests for vault hygiene (orphans, unresolved links, note info), attachments,
//! property order, MCP prompts and bulk operations (docs/cli.md, docs/mcp.md). Written
//! before the implementation. Requirement IDs: L* links, A* attachments, R* order,
//! Q* prompts, B* bulk.

mod common;

use common::*;
use serde_json::{json, Value};
use std::fs;

const PNG: &[u8] = &[
    0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, b'I', b'H', b'D', b'R', 0, 0, 0,
    1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
];

#[allow(
    clippy::unwrap_used,
    reason = "a fixture that cannot be set up fails the test"
)]
fn sorted(values: &Value, field: &str) -> Vec<String> {
    let mut items: Vec<String> = values
        .as_array()
        .unwrap_or_else(|| panic!("array: {values}"))
        .iter()
        .map(|item| {
            item[field]
                .as_str()
                .unwrap_or_else(|| panic!("{field} in {item}"))
                .to_owned()
        })
        .collect();
    items.sort();
    items
}

/// The fixture plus attachments: an image embedded twice, a PDF linked by a vault path, a
/// missing image, an external URL and two unresolved links.
#[allow(
    clippy::unwrap_used,
    reason = "a fixture that cannot be set up fails the test"
)]
fn rich_vault() -> Vault {
    let vault = vault(true);
    fs::create_dir_all(vault.root.join("assets")).unwrap();
    fs::write(vault.root.join("assets/diagram.png"), PNG).unwrap();
    fs::write(vault.root.join("assets/spec.pdf"), b"%PDF-1.4 tiny").unwrap();
    fs::write(
        vault.root.join("Projects/Plan.md"),
        format!(
            "---\namby-id: {ID_PLAN}\nstatus: done\n---\n# Plan\n\nSee [[Meeting]] and [[Missing note]].\n\
             ![Diagram](../assets/diagram.png) ![[diagram.png]] [Spec](assets/spec.pdf)\n\
             ![Gone](../assets/gone.png) [Site](https://example.com/a.png) [[Ghost.png]]\n"
        ),
    )
    .unwrap();
    vault
}

// ----- links -----

/// L1: orphans are notes no other note links to; a folder narrows them.
#[test]
fn l1_orphans() {
    let vault = rich_vault();
    let orphans = vault.ok(&["orphans"]);
    assert_eq!(sorted(&orphans["notes"], "path"), ["Daily/My note.md"]);
    assert!(vault.ok(&["orphans", "--folder", "Projects"])["notes"]
        .as_array()
        .unwrap()
        .is_empty());
    let tool = vault.tool(None, "find_orphans", json!({}));
    assert_eq!(
        sorted(&tool["notes"], "path"),
        ["Daily/My note.md"],
        "{tool}"
    );
}

/// L2: unresolved links name their source note; links to existing attachments are not
/// unresolved.
#[test]
fn l2_unresolved_links() {
    let vault = rich_vault();
    let links = vault.ok(&["unresolved"]);
    assert_eq!(
        sorted(&links["links"], "target"),
        ["Ghost.png", "Missing note"],
        "{links}"
    );
    assert!(links["links"]
        .as_array()
        .unwrap()
        .iter()
        .all(|link| link["source"] == "Projects/Plan.md"));
    let tool = vault.tool(None, "list_unresolved_links", json!({"folder":"Daily"}));
    assert!(tool["links"].as_array().unwrap().is_empty(), "{tool}");
}

/// L3: note info gathers the path, size, words, tags, links, properties and attachments.
#[test]
fn l3_note_info() {
    let vault = rich_vault();
    let info = vault.ok(&["info", "Plan"]);
    assert_eq!(info["path"], "Projects/Plan.md");
    assert_eq!(info["noteId"], ID_PLAN);
    assert_eq!(info["title"], "Plan");
    assert_eq!(
        info["size"],
        fs::metadata(vault.root.join("Projects/Plan.md"))
            .unwrap()
            .len()
    );
    assert!(info["words"].as_u64().unwrap() > 3, "{info}");
    assert!(info["modified"].is_u64(), "{info}");
    assert_eq!(info["links"]["outgoing"], 1, "{info}");
    assert_eq!(info["links"]["unresolved"], 2, "{info}");
    assert_eq!(info["links"]["incoming"], 1, "{info}");
    assert_eq!(info["properties"], 1, "{info}");
    assert_eq!(info["attachments"]["count"], 3, "{info}");
    assert_eq!(info["attachments"]["missing"], 1, "{info}");
    let meeting = vault.ok(&["info", "Meeting"]);
    let mut tags: Vec<&str> = meeting["tags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap())
        .collect();
    tags.sort_unstable();
    assert_eq!(tags, ["meeting", "todo", "work"]);
    let tool = vault.tool(None, "get_note_info", json!({"id":"Projects/Plan.md"}));
    assert_eq!(tool["noteId"], ID_PLAN, "{tool}");
}

// ----- attachments -----

/// A1: a note's attachments are its local links and embeds, resolved next to the note
/// first and from the vault root otherwise; external URLs are not attachments.
#[test]
fn a1_lists_attachments() {
    let vault = rich_vault();
    let listing = vault.ok(&["attachments", "Plan"]);
    let items = listing["attachments"].as_array().unwrap();
    assert_eq!(
        sorted(&listing["attachments"], "path"),
        ["assets/diagram.png", "assets/gone.png", "assets/spec.pdf"],
        "{listing}"
    );
    let get = |path: &str| items.iter().find(|item| item["path"] == path).unwrap();
    assert_eq!(get("assets/diagram.png")["kind"], "image");
    assert_eq!(get("assets/diagram.png")["size"], PNG.len());
    assert_eq!(get("assets/diagram.png")["exists"], true);
    assert_eq!(get("assets/spec.pdf")["kind"], "pdf");
    assert_eq!(get("assets/gone.png")["exists"], false);
    let tool = vault.tool(None, "list_attachments", json!({"id":"Projects/Plan.md"}));
    assert_eq!(tool["attachments"].as_array().unwrap().len(), 3, "{tool}");
}

/// A2: attaching copies the file under a new random name into the note's assets folder
/// and appends a link; the note gets a history snapshot. `--no-link` copies only.
#[test]
fn a2_attach_copies_and_links() {
    let vault = rich_vault();
    let source = vault.home.join("Quarterly report.pdf");
    fs::write(&source, b"%PDF-1.4 report").unwrap();
    let attached = vault.ok(&["attach", "Meeting", source.to_str().unwrap()]);
    let path = attached["path"].as_str().unwrap();
    assert!(
        path.starts_with("assets/pdf_") && path.ends_with(".pdf"),
        "{attached}"
    );
    assert_eq!(fs::read(vault.root.join(path)).unwrap(), b"%PDF-1.4 report");
    assert_eq!(attached["name"], "Quarterly report.pdf");
    let note = vault.read("Projects/Meeting.md");
    assert!(note.starts_with(MEETING.trim_end_matches("\r\n")), "{note}");
    assert!(
        note.contains(&format!("[Quarterly report.pdf]({path})")),
        "{note}"
    );
    assert_eq!(vault.snapshots(), 1);
    assert!(fs::read(&source).is_ok(), "the source stays");

    let image = vault.home.join("photo.png");
    fs::write(&image, PNG).unwrap();
    let copied = vault.ok(&["attach", "Meeting", image.to_str().unwrap(), "--no-link"]);
    assert!(copied["path"].as_str().unwrap().starts_with("assets/img_"));
    assert!(!vault.read("Projects/Meeting.md").contains("photo.png"));
    assert_eq!(
        vault.error(&[
            "attach",
            "Meeting",
            vault.home.join("none.png").to_str().unwrap()
        ]),
        (Some(3), "notFound".into())
    );
}

/// A3: MCP adds attachments from base64 inside the grant and reads them back: an image as
/// MCP image content, other files as base64; notes and service files are not attachments.
#[test]
fn a3_mcp_attachments() {
    use base64::Engine as _;
    let vault = rich_vault();
    let encoded = base64::engine::general_purpose::STANDARD.encode(PNG);
    let grant = Some("--allow-write=Projects");
    let outside = vault.tool(
        grant,
        "add_attachment",
        json!({"path":"Daily/My note.md","name":"x.png","data":encoded}),
    );
    assert_eq!(outside["error"], "outsideWriteScope", "{outside}");
    let added = vault.tool(
        grant,
        "add_attachment",
        json!({"path":"Projects/Meeting.md","name":"chart.png","data":encoded}),
    );
    let path = added["path"]
        .as_str()
        .unwrap_or_else(|| panic!("{added}"))
        .to_owned();
    assert_eq!(fs::read(vault.root.join(&path)).unwrap(), PNG);
    assert!(vault
        .read("Projects/Meeting.md")
        .contains(&format!("![chart.png]({path})")));
    let bad = vault.tool(
        grant,
        "add_attachment",
        json!({"path":"Projects/Meeting.md","name":"x.png","data":"%%%"}),
    );
    assert_eq!(bad["error"], "invalidArguments", "{bad}");

    let replies = vault.mcp(
        None,
        &[json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
            "params":{"name":"read_attachment","arguments":{"path":"assets/diagram.png"}}})],
    );
    let content = replies[1]["result"]["content"].as_array().unwrap();
    let image = content
        .iter()
        .find(|block| block["type"] == "image")
        .unwrap_or_else(|| panic!("{}", replies[1]));
    assert_eq!(image["mimeType"], "image/png");
    assert_eq!(image["data"], encoded);
    let pdf = vault.tool(None, "read_attachment", json!({"path":"assets/spec.pdf"}));
    assert_eq!(pdf["mimeType"], "application/pdf", "{pdf}");
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(pdf["data"].as_str().unwrap())
            .unwrap(),
        b"%PDF-1.4 tiny"
    );
    for (path, code) in [
        ("Projects/Plan.md", "notAnAttachment"),
        (".amby/properties/layout.json", "accessDenied"),
        ("assets/gone.png", "notFound"),
    ] {
        let refused = vault.tool(None, "read_attachment", json!({"path":path}));
        assert_eq!(refused["error"], code, "{path}: {refused}");
    }
}

// ----- property order -----

/// R1: the order of a note's properties can be set in the CLI and MCP.
#[test]
fn r1_property_order() {
    let vault = vault(true);
    let ordered = vault.ok(&["prop", "order", "Meeting", "tags", "status"]);
    assert_eq!(sorted_in_order(&ordered), ["tags", "status"]);
    let again = vault.tool(
        Some("--allow-write"),
        "reorder_properties",
        json!({"path":"Projects/Meeting.md","names":["status","tags"]}),
    );
    assert_eq!(sorted_in_order(&again), ["status", "tags"], "{again}");
    assert_eq!(
        vault.read("Projects/Meeting.md"),
        MEETING,
        "order lives outside the header"
    );
}

#[allow(
    clippy::unwrap_used,
    reason = "a fixture that cannot be set up fails the test"
)]
fn sorted_in_order(listing: &Value) -> Vec<String> {
    listing["properties"]
        .as_array()
        .unwrap_or_else(|| panic!("{listing}"))
        .iter()
        .map(|p| p["name"].as_str().unwrap().to_owned())
        .collect()
}

// ----- prompts -----

/// Q1: the server offers prompts that guide an agent through the tools.
#[test]
fn q1_prompts() {
    let vault = vault(true);
    let replies = vault.mcp(
        None,
        &[
            json!({"jsonrpc":"2.0","id":1,"method":"prompts/list"}),
            json!({"jsonrpc":"2.0","id":2,"method":"prompts/get","params":{"name":"summarize_tag","arguments":{"tag":"work"}}}),
            json!({"jsonrpc":"2.0","id":3,"method":"prompts/get","params":{"name":"summarize_tag","arguments":{}}}),
            json!({"jsonrpc":"2.0","id":4,"method":"prompts/get","params":{"name":"nope"}}),
        ],
    );
    assert!(replies[0]["result"]["capabilities"]["prompts"].is_object());
    let names = sorted(&replies[1]["result"]["prompts"], "name");
    for name in [
        "fix_broken_links",
        "review_orphans",
        "summarize_tag",
        "tidy_folder",
    ] {
        assert!(names.contains(&name.to_owned()), "{names:?}");
    }
    let text = replies[2]["result"]["messages"][0]["content"]["text"]
        .as_str()
        .unwrap();
    assert!(
        text.contains("work") && text.contains("search_notes"),
        "{text}"
    );
    assert!(replies[3]["error"].is_object(), "{}", replies[3]);
    assert!(replies[4]["error"].is_object(), "{}", replies[4]);
}

// ----- bulk -----

/// B1: bulk edits need --dry-run or --yes, preview the exact notes, and report each one.
#[test]
fn b1_cli_bulk_set_and_move() {
    let vault = vault(true);
    assert_eq!(
        vault.error(&["bulk", "set", "status", "archived", "--tag", "work"]),
        (Some(2), "usage".into())
    );
    assert_eq!(
        vault.error(&["bulk", "set", "status", "archived", "--yes"]),
        (Some(2), "usage".into()),
        "a bulk edit needs a filter"
    );
    let preview = vault.ok(&[
        "bulk",
        "set",
        "status",
        "archived",
        "--tag",
        "work",
        "--dry-run",
    ]);
    assert_eq!(
        sorted(&preview["notes"], "path"),
        ["Daily/My note.md", "Projects/Meeting.md"]
    );
    assert_eq!(vault.read("Projects/Meeting.md"), MEETING);
    let done = vault.ok(&[
        "bulk", "set", "status", "archived", "--tag", "work", "--yes",
    ]);
    assert_eq!(done["failed"], 0, "{done}");
    assert!(vault
        .read("Projects/Meeting.md")
        .contains("status: archived"));
    assert!(vault.read("Daily/My note.md").contains("status: archived"));
    assert!(vault.read("Projects/Plan.md").contains("status: done"));

    fs::create_dir_all(vault.root.join("Archive")).unwrap();
    let moved = vault.ok(&["bulk", "move", "Archive", "--folder", "Projects", "--yes"]);
    assert_eq!(moved["failed"], 0, "{moved}");
    assert!(vault.root.join("Archive/Meeting.md").is_file());
    assert!(vault.root.join("Archive/Plan.md").is_file());
}

/// B2: a failed note does not stop the others; the exit code says some failed.
#[test]
fn b2_partial_failure_is_reported() {
    let vault = vault(true);
    fs::write(
        vault.root.join("Daily/Broken.md"),
        "---\nstatus: [\n---\n#work\n",
    )
    .unwrap();
    let (code, value) = vault.json(&["bulk", "set", "status", "x", "--tag", "work", "--yes"]);
    assert_eq!(code, Some(8), "{value}");
    assert_eq!(value["ok"], true);
    assert_eq!(value["data"]["failed"], 1, "{value}");
    let broken = value["data"]["notes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|note| note["path"] == "Daily/Broken.md")
        .unwrap();
    assert!(broken["error"].is_string(), "{broken}");
    assert!(vault.read("Projects/Meeting.md").contains("status: x"));
}

/// B3: MCP bulk tools check every note against the grant and support a preview.
#[test]
fn b3_mcp_bulk() {
    let vault = vault(true);
    let grant = Some("--allow-write=Projects");
    let filter = json!({"tags":["work"]});
    let preview = vault.tool(
        grant,
        "bulk_set_property",
        json!({"filter":filter,"name":"status","value":"x","dryRun":true}),
    );
    let outside = preview["notes"]
        .as_array()
        .unwrap_or_else(|| panic!("{preview}"))
        .iter()
        .find(|note| note["path"] == "Daily/My note.md")
        .unwrap();
    assert_eq!(outside["error"], "outsideWriteScope", "{preview}");
    assert_eq!(vault.read("Projects/Meeting.md"), MEETING);
    let done = vault.tool(
        grant,
        "bulk_set_property",
        json!({"filter":filter,"name":"status","value":"x"}),
    );
    assert_eq!(done["failed"], 1, "{done}");
    assert!(vault.read("Projects/Meeting.md").contains("status: x"));
    assert!(vault.read("Daily/My note.md").contains("status: active"));
    let empty = vault.tool(grant, "bulk_move", json!({"filter":{},"folder":"Projects"}));
    assert_eq!(empty["error"], "invalidArguments", "{empty}");
}
