//! Contract tests for templates and daily notes (docs/cli.md, docs/mcp.md). Written before
//! the implementation. Requirement IDs: T* templates, Y* daily notes, M* MCP.

mod common;

use common::*;
use serde_json::{json, Value};
use std::fs;

const TEMPLATE_ID: &str = "01JC0000000000000000000009";

/// The fixture plus `Templates/Meeting.md` (with an `amby-id` of its own and placeholders)
/// and `Templates/Work/Review.md`.
#[allow(
    clippy::unwrap_used,
    reason = "a fixture that cannot be set up fails the test"
)]
fn template_vault() -> Vault {
    let vault = vault(true);
    fs::create_dir_all(vault.root.join("Templates/Work")).unwrap();
    fs::write(
        vault.root.join("Templates/Meeting.md"),
        format!(
            "---\namby-id: {TEMPLATE_ID}\nkind: meeting\ncreated: {{{{date}}}}\n---\n# {{{{title}}}}\n\nStarted {{{{date}}}} at {{{{time}}}}.\n\n```\n{{{{title}}}} stays in code too\n```\n"
        ),
    )
    .unwrap();
    fs::write(
        vault.root.join("Templates/Work/Review.md"),
        "## Review of {{title}}\n",
    )
    .unwrap();
    vault
}

fn header_id(text: &str) -> Option<String> {
    text.lines()
        .find_map(|line| line.strip_prefix("amby-id: "))
        .map(str::to_owned)
}

#[allow(
    clippy::unwrap_used,
    reason = "a fixture that cannot be set up fails the test"
)]
fn input(vault: &Vault, text: &str) -> String {
    let file = vault.home.join("input.md");
    fs::write(&file, text).unwrap();
    file.to_string_lossy().into_owned()
}

// ----- templates -----

#[test]
fn t1_templates_lists_the_templates_folder() {
    let vault = template_vault();
    let data = vault.ok(&["templates"]);
    let names: Vec<&str> = data["templates"]
        .as_array()
        .unwrap_or_else(|| panic!("{data}"))
        .iter()
        .map(|template| template["name"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(names, ["Meeting", "Work/Review"], "{data}");
    assert_eq!(data["templates"][0]["path"], "Templates/Meeting.md");
}

#[test]
fn t2_new_from_a_template_fills_placeholders_and_gets_its_own_id() {
    let vault = template_vault();
    let before = vault.read("Templates/Meeting.md");
    let data = vault.ok(&["new", "Projects/Standup", "--template", "Meeting"]);
    assert_eq!(data["path"], "Projects/Standup.md", "{data}");
    let text = vault.read("Projects/Standup.md");
    assert!(text.contains("kind: meeting\n"), "{text}");
    assert!(text.contains("\n# Standup\n"), "{text}");
    assert!(!text.contains("{{"), "{text}");
    let id = header_id(&text).unwrap_or_else(|| panic!("an id in {text}"));
    assert_ne!(id, TEMPLATE_ID);
    assert_eq!(text.matches("amby-id:").count(), 1, "{text}");
    assert_eq!(vault.read("Templates/Meeting.md"), before);
}

#[test]
fn t3_a_nested_template_is_named_by_its_path_under_templates() {
    let vault = template_vault();
    vault.ok(&["new", "Projects/Q4", "--template", "Work/Review"]);
    assert!(vault.read("Projects/Q4.md").contains("## Review of Q4\n"));
    // A vault path works as well.
    vault.ok(&[
        "new",
        "Projects/Q5",
        "--template",
        "Templates/Work/Review.md",
    ]);
    assert!(vault.read("Projects/Q5.md").contains("## Review of Q5\n"));
}

#[test]
fn t4_a_missing_template_creates_nothing() {
    let vault = template_vault();
    let (code, error) = vault.error(&["new", "Projects/X", "--template", "Nope"]);
    assert_eq!((code, error.as_str()), (Some(3), "notFound"));
    assert!(!vault.root.join("Projects/X.md").exists());
    let (code, _) = vault.error(&["new", "Projects/X", "--template", "../Daily/My note"]);
    assert_ne!(code, Some(0), "a template outside the vault is refused");
    assert!(!vault.root.join("Projects/X.md").exists());
}

#[test]
fn t5_template_only_fits_new_and_daily() {
    let vault = template_vault();
    let (code, error) = vault.error(&["append", "Projects/Plan", "--template", "Meeting"]);
    assert_eq!((code, error.as_str()), (Some(2), "usage"));
}

#[test]
fn t6_new_from_a_template_dry_run_writes_nothing() {
    let vault = template_vault();
    let data = vault.ok(&[
        "new",
        "Projects/Draft",
        "--template",
        "Meeting",
        "--dry-run",
    ]);
    assert!(
        data["diff"]
            .as_str()
            .is_some_and(|diff| diff.contains("+# Draft")),
        "{data}"
    );
    assert!(!vault.root.join("Projects/Draft.md").exists());
}

// ----- daily notes -----

#[test]
fn y1_daily_creates_the_note_once() {
    let vault = template_vault();
    let data = vault.ok(&["daily", "--date", "2026-11-20"]);
    assert_eq!(data["path"], "Daily/2026-11-20.md", "{data}");
    assert_eq!(data["created"], true, "{data}");
    let text = vault.read("Daily/2026-11-20.md");
    assert!(header_id(&text).is_some(), "{text}");
    let again = vault.ok(&["daily", "--date", "2026-11-20"]);
    assert_eq!(again["created"], false, "{again}");
    assert_eq!(vault.read("Daily/2026-11-20.md"), text);
}

#[test]
fn y2_daily_defaults_to_today() {
    let vault = template_vault();
    let data = vault.ok(&["daily"]);
    let path = data["path"].as_str().unwrap_or_default();
    let date = path
        .strip_prefix("Daily/")
        .and_then(|rest| rest.strip_suffix(".md"))
        .unwrap_or_else(|| panic!("{data}"));
    assert!(
        date.len() == 10 && date.chars().filter(|c| *c == '-').count() == 2,
        "{date}"
    );
}

#[test]
fn y3_daily_uses_a_template_with_the_date_as_title() {
    let vault = template_vault();
    vault.ok(&["daily", "--date", "2026-11-20", "--template", "Meeting"]);
    let text = vault.read("Daily/2026-11-20.md");
    assert!(text.contains("\n# 2026-11-20\n"), "{text}");
    assert!(text.contains("created: 2026-11-20\n"), "{text}");
    assert!(text.contains("Started 2026-11-20 at "), "{text}");
}

#[test]
fn y4_daily_append_creates_then_appends() {
    let vault = template_vault();
    let first = input(&vault, "- first\n");
    vault.ok(&["daily", "append", "--date", "2026-11-21", "--file", &first]);
    let second = input(&vault, "- second\n");
    vault.ok(&["daily", "append", "--date", "2026-11-21", "--file", &second]);
    let text = vault.read("Daily/2026-11-21.md");
    let at = |needle: &str| {
        text.find(needle)
            .unwrap_or_else(|| panic!("{needle} in {text}"))
    };
    assert!(at("- first") < at("- second"), "{text}");
    assert_eq!(text.matches("amby-id:").count(), 1, "{text}");
}

#[test]
fn y5_daily_folder_is_created_when_missing() {
    let vault = template_vault();
    let data = vault.ok(&["daily", "--date", "2026-11-20", "--folder", "Journal/2026"]);
    assert_eq!(data["path"], "Journal/2026/2026-11-20.md", "{data}");
    assert!(vault.root.join("Journal/2026/2026-11-20.md").is_file());
    let (code, _) = vault.error(&["daily", "--date", "2026-11-20", "--folder", ".amby"]);
    assert_ne!(code, Some(0));
}

#[test]
fn y6_daily_rejects_a_bad_date_and_dry_run_writes_nothing() {
    let vault = template_vault();
    for date in ["2026-13-01", "2026-02-30", "20261120", "tomorrow"] {
        let (code, error) = vault.error(&["daily", "--date", date]);
        assert_eq!((code, error.as_str()), (Some(2), "usage"), "{date}");
    }
    let data = vault.ok(&[
        "daily",
        "--date",
        "2026-11-22",
        "--folder",
        "Fresh",
        "--dry-run",
    ]);
    assert_eq!(data["created"], true, "{data}");
    assert!(!vault.root.join("Fresh").exists());
}

// ----- MCP -----

#[test]
fn m1_mcp_lists_templates_without_a_grant_and_writes_only_with_one() {
    let vault = template_vault();
    let read_only = vault.tool_names(None);
    assert!(read_only.contains(&"list_templates".to_owned()));
    assert!(!read_only.contains(&"daily_note".to_owned()));
    let listing = vault.tool(None, "list_templates", json!({}));
    assert_eq!(listing["templates"][1]["name"], "Work/Review", "{listing}");
    let writable = vault.tool_names(Some("--allow-write"));
    for name in ["daily_note", "new_note_from_template"] {
        assert!(writable.contains(&name.to_owned()), "{name}");
    }
}

#[test]
fn m2_mcp_daily_note_creates_appends_and_respects_the_grant() {
    let vault = template_vault();
    let created = vault.tool(
        Some("--allow-write"),
        "daily_note",
        json!({"date":"2026-11-20","template":"Meeting","append":"- from AI\n"}),
    );
    assert_eq!(created["path"], "Daily/2026-11-20.md", "{created}");
    assert_eq!(created["created"], true, "{created}");
    let text = vault.read("Daily/2026-11-20.md");
    assert!(
        text.contains("# 2026-11-20") && text.ends_with("- from AI\n"),
        "{text}"
    );
    let denied = vault.tool(
        Some("--allow-write=Projects"),
        "daily_note",
        json!({"date":"2026-11-21"}),
    );
    assert!(denied["error"].is_string(), "{denied}");
    assert!(!vault.root.join("Daily/2026-11-21.md").exists());
}

#[test]
fn m3_mcp_new_note_from_template() {
    let vault = template_vault();
    let result: Value = vault.tool(
        Some("--allow-write"),
        "new_note_from_template",
        json!({"path":"Projects/Retro","template":"Meeting"}),
    );
    assert_eq!(result["path"], "Projects/Retro.md", "{result}");
    let text = vault.read("Projects/Retro.md");
    assert!(text.contains("# Retro") && header_id(&text).is_some_and(|id| id != TEMPLATE_ID));
    let missing = vault.tool(
        Some("--allow-write"),
        "new_note_from_template",
        json!({"path":"Projects/Other","template":"Nope"}),
    );
    assert_eq!(missing["error"], "notFound", "{missing}");
}

// ----- module settings and switches -----

#[allow(
    clippy::unwrap_used,
    reason = "a fixture that cannot be set up fails the test"
)]
fn with_workspace(vault: &Vault, workspace: &str) {
    fs::create_dir_all(vault.root.join(".amby")).unwrap();
    fs::write(vault.root.join(".amby/workspace.json"), workspace).unwrap();
}

#[test]
fn s1_the_templates_folder_setting_is_followed() {
    let vault = template_vault();
    fs::create_dir_all(vault.root.join("Meta")).unwrap_or_default();
    fs::write(vault.root.join("Meta/Brief.md"), "# {{title}} brief\n").unwrap_or_default();
    with_workspace(
        &vault,
        r#"{"moduleSettings":{"templates":{"folder":"Meta"}}}"#,
    );
    let data = vault.ok(&["templates"]);
    assert_eq!(
        data["templates"],
        json!([{"name":"Brief","path":"Meta/Brief.md"}]),
        "{data}"
    );
    vault.ok(&["new", "Projects/Launch", "--template", "Brief"]);
    assert!(vault
        .read("Projects/Launch.md")
        .contains("# Launch brief\n"));
}

#[test]
fn s2_the_daily_settings_are_followed_and_flags_win() {
    let vault = template_vault();
    with_workspace(
        &vault,
        r#"{"moduleSettings":{"daily":{"folder":"Journal","template":"Meeting"}}}"#,
    );
    let data = vault.ok(&["daily", "--date", "2026-11-20"]);
    assert_eq!(data["path"], "Journal/2026-11-20.md", "{data}");
    assert!(vault
        .read("Journal/2026-11-20.md")
        .contains("# 2026-11-20\n"));
    let flagged = vault.ok(&["daily", "--date", "2026-11-21", "--folder", "Daily"]);
    assert_eq!(flagged["path"], "Daily/2026-11-21.md", "{flagged}");
    let mcp = vault.tool(
        Some("--allow-write"),
        "daily_note",
        json!({"date":"2026-11-22"}),
    );
    assert_eq!(mcp["path"], "Journal/2026-11-22.md", "{mcp}");
}

#[test]
fn s3_a_switched_off_module_is_refused_and_its_tools_are_hidden() {
    let vault = template_vault();
    with_workspace(
        &vault,
        r#"{"profile":{"id":"custom","catalogRevision":"2026-11-20"},"enabledModules":["amby.tags"]}"#,
    );
    for args in [
        vec!["templates"],
        vec!["daily", "--date", "2026-11-20"],
        vec!["new", "Projects/X", "--template", "Meeting"],
    ] {
        let (_, error) = vault.error(&args);
        assert_eq!(error, "moduleDisabled", "{args:?}");
    }
    assert!(!vault.root.join("Daily/2026-11-20.md").exists());
    let names = vault.tool_names(Some("--allow-write"));
    for name in ["list_templates", "new_note_from_template", "daily_note"] {
        assert!(!names.contains(&name.to_owned()), "{name}");
    }
    let refused = vault.tool(Some("--allow-write"), "daily_note", json!({}));
    assert_eq!(refused["error"], "moduleDisabled", "{refused}");
}
