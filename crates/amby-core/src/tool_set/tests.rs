use super::*;

#[test]
fn every_read_definition_is_unique_read_only_and_closed_world() {
    let tools = read_definitions();
    let mut names: Vec<&str> = tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    let total = names.len();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), total, "duplicate tool names");
    for tool in &tools {
        assert!(tool["description"]
            .as_str()
            .is_some_and(|text| !text.is_empty()));
        assert_eq!(tool["inputSchema"]["type"], "object");
        assert_eq!(tool["annotations"]["readOnlyHint"], true, "{tool}");
        assert_eq!(tool["annotations"]["openWorldHint"], false, "{tool}");
        assert_eq!(tool["annotations"]["destructiveHint"], false, "{tool}");
    }
}

#[test]
fn write_definitions_are_never_read_only() {
    for tool in notes_write_definitions()
        .into_iter()
        .chain(extra_write_definitions())
    {
        assert_eq!(tool["annotations"]["readOnlyHint"], false, "{tool}");
    }
}

#[test]
fn argument_validation_is_strict() {
    let args = serde_json::json!({"path":"a.md","extra":1});
    assert_eq!(
        validate_fields(&args, &["path"], &[]),
        Err("invalidArguments")
    );
    assert_eq!(validate_fields(&args, &["path"], &["extra"]), Ok(()));
    assert_eq!(
        argument(&serde_json::json!({"path":""}), "path"),
        Err("invalidArguments")
    );
    assert_eq!(
        note_read(std::path::Path::new("."), "edit_note", &args),
        Err("unknownTool")
    );
}
