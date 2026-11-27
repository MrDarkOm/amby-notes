use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

fn cli(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_amby"));
    command
        .env("AMBY_APP_DATA_DIR", home)
        .env_remove("AMBY_VAULT");
    command
}

fn json(output: Output) -> Value {
    serde_json::from_slice(&output.stdout).expect("CLI stdout must be a JSON envelope")
}

#[test]
fn uncached_vault_supports_reading_search_links_and_tags_without_writes() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let original = "\u{feff}---\r\namby-title: First\r\n---\r\nUnique #test [[Second]]\r\n";
    fs::write(root.join("One.md"), original).unwrap();
    fs::write(
        root.join("Second.md"),
        "---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\nBody",
    )
    .unwrap();
    let command = || {
        let mut client = cli(root);
        client.arg("--vault").arg(root);
        client
    };
    let cat = command().args(["cat", "First"]).output().unwrap();
    assert!(cat.status.success());
    assert_eq!(cat.stdout, original.as_bytes());
    for (args, field, expected) in [
        (["search", "Unique"], "results", "One.md"),
        (["links", "First"], "links", "Second.md"),
        (
            ["backlinks", "01ARZ3NDEKTSV4RRFFQ69G5FAV"],
            "links",
            "One.md",
        ),
    ] {
        let value = json(command().arg("--json").args(args).output().unwrap());
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["data"][field][0]["path"], expected);
    }
    let tags = json(command().args(["tags", "--json"]).output().unwrap());
    assert_eq!(tags["data"]["tags"][0]["tag"], "test");
    assert_eq!(fs::read(root.join("One.md")).unwrap(), original.as_bytes());
    assert!(!root.join(".amby").exists());
}

#[test]
fn remembered_vaults_and_ambiguity_have_a_machine_readable_contract() {
    let app = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    fs::write(
        app.path().join("workspaces.json"),
        serde_json::json!({
            "schemaVersion": 1, "recent": [], "lastOpened": vault.path(),
        })
        .to_string(),
    )
    .unwrap();
    for name in ["A.md", "B.md"] {
        fs::write(vault.path().join(name), "---\namby-title: Same\n---\nbody").unwrap();
    }
    let output = cli(app.path())
        .args(["--json", "cat", "Same"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(4));
    assert!(output.stderr.is_empty());
    let error = json(output);
    assert_eq!(error["error"]["code"], "ambiguousNote");
    assert_eq!(
        error["error"]["candidates"],
        serde_json::json!(["A.md", "B.md"])
    );

    assert!(cli(app.path())
        .args(["vault", "use"])
        .arg(other.path())
        .output()
        .unwrap()
        .status
        .success());
    let list = json(
        cli(app.path())
            .args(["vault", "list", "--json"])
            .output()
            .unwrap(),
    );
    let remembered = other.path().canonicalize().unwrap();
    assert_eq!(list["data"]["selected"], remembered.to_str().unwrap());
    let override_result = json(
        cli(app.path())
            .env("AMBY_VAULT", vault.path())
            .args(["ls", "--json"])
            .output()
            .unwrap(),
    );
    assert_eq!(override_result["data"]["entries"][0]["name"], "A.md");
}

#[test]
fn stdio_mcp_exposes_read_tools_and_rejects_service_paths() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    fs::create_dir(root.join(".amby")).unwrap();
    fs::write(root.join(".amby/key.md"), "secret").unwrap();
    fs::write(root.join("Visible.md"), "unique body").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join(".amby/key.md"), root.join("Alias.md")).unwrap();
    let mut child = cli(root)
        .arg("--vault")
        .arg(root)
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for message in [
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}"#,
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_folder","arguments":{"path":".amby"}}}"#,
        r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_notes","arguments":{"query":"unique"}}}"#,
    ] {
        writeln!(input, "{message}").unwrap();
    }
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(!stdout.contains("secret"));
    assert!(!stdout.contains("Alias"));
    let replies: Vec<Value> = stdout
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(replies.len(), 4);
    assert_eq!(replies[0]["result"]["protocolVersion"], "2025-11-25");
    let tools = replies[1]["result"]["tools"].as_array().unwrap();
    // 8 read tools plus list_tags, get_properties, five hygiene and attachment reads and
    // five note-part, version and open reads.
    assert_eq!(tools.len(), 21);
    assert!(tools
        .iter()
        .all(|tool| tool["annotations"]["readOnlyHint"] == true));
    assert_eq!(replies[2]["result"]["isError"], true);
    assert!(replies[2]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("accessDenied"));
    assert!(replies[3]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Visible"));
    assert!(replies[3]["result"]["structuredContent"].is_object());
    assert!(!root.join(".amby/notes.db").exists());
}

#[test]
fn persisted_index_is_read_without_mutating_wal_and_stale_rows_are_ignored() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    let note = root.join("Note.md");
    let removed = root.join("Removed.md");
    let source = "---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\nstale";
    fs::write(&note, source).unwrap();
    fs::write(
        &removed,
        "---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAW\n---\nremoved",
    )
    .unwrap();
    let index = amby_core::index::open_connection(&root).unwrap();
    amby_core::index::sync_vault(&index, &root).unwrap();
    let paths = ["notes.db", "notes.db-shm", "notes.db-wal"];
    let bytes = paths.map(|name| fs::read(root.join(".amby").join(name)).unwrap());
    let search = |query: &str| {
        json(
            cli(&root)
                .arg("--vault")
                .arg(&root)
                .args(["search", query, "--json"])
                .output()
                .unwrap(),
        )
    };
    assert_eq!(search("stale")["data"]["results"][0]["path"], "Note.md");
    fs::write(&note, "replacement content").unwrap();
    fs::remove_file(&removed).unwrap();
    assert_eq!(
        search("replacement")["data"]["results"][0]["path"],
        "Note.md"
    );
    assert_eq!(search("stale")["data"]["results"], serde_json::json!([]));
    assert_eq!(search("removed")["data"]["results"], serde_json::json!([]));
    assert_eq!(
        bytes,
        paths.map(|name| fs::read(root.join(".amby").join(name)).unwrap())
    );
    assert_eq!(fs::read_to_string(note).unwrap(), "replacement content");
}

#[cfg(unix)]
#[test]
fn desktop_open_passes_only_the_canonical_vault_and_relative_note() {
    use std::os::unix::fs::PermissionsExt;
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    let helper = root.join("desktop");
    let log = root.join("launch.txt");
    fs::write(root.join("A note.md"), "body").unwrap();
    fs::write(
        &helper,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$AMBY_TEST_LAUNCH\"\n",
    )
    .unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    let info = json(
        cli(&root)
            .arg("--vault")
            .arg(&root)
            .env("AMBY_DESKTOP_BIN", &helper)
            .env("AMBY_TEST_LAUNCH", &log)
            .args(["open", "A note.md", "--json"])
            .output()
            .unwrap(),
    );
    assert_eq!(info["data"]["requested"], true);
    let expected = format!("--amby-open-note\n{}\nA note.md\n", root.display());
    for _ in 0..100 {
        if fs::read_to_string(&log).is_ok_and(|args| args == expected) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("desktop launch did not receive the expected arguments");
}

fn edit_cli(home: &Path, root: &Path, args: &[&str], content: &str) -> Output {
    let mut child = cli(home)
        .arg("--vault")
        .arg(root)
        .arg("--json")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn the CLI");
    child
        .stdin
        .take()
        .expect("CLI stdin is piped")
        .write_all(content.as_bytes())
        .expect("send the Markdown payload");
    child.wait_with_output().expect("wait for the CLI")
}

#[test]
fn dry_run_preserves_files_and_append_and_write_snapshot_the_exact_previous_bytes() {
    use amby_core::history::{list_snapshots, read_snapshot_text};
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    let note = root.join("Source.md");
    let header = "\u{feff}---\r\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\nother: 'keep me' # comment\r\n---\r\n";
    let original = format!("{header}old body");
    fs::write(&note, &original).unwrap();
    let dry = json(edit_cli(
        &root,
        &root,
        &["write", "Source", "--dry-run"],
        "replacement\n",
    ));
    assert_eq!(dry["data"]["dryRun"], true);
    let diff = dry["data"]["diff"].as_str().unwrap();
    assert!(diff.contains("-old body"));
    assert!(diff.contains("+replacement"));
    assert_eq!(fs::read_to_string(&note).unwrap(), original);
    assert!(!root.join(".amby").exists());

    fs::create_dir(root.join(".amby")).unwrap();
    fs::write(
        root.join(".amby/workspace.json"),
        r#"{"history":{"enabled":false}}"#,
    )
    .unwrap();
    assert!(!amby_core::history::is_history_enabled(&root));
    let append = json(edit_cli(&root, &root, &["append", "Source.md"], "added\n"));
    let after_append = format!("{header}old body\r\nadded\r\n");
    assert_eq!(fs::read_to_string(&note).unwrap(), after_append);
    let snapshot = append["data"]["snapshotId"].as_str().unwrap();
    assert_eq!(
        read_snapshot_text(&root, snapshot).unwrap().content,
        original
    );

    let payload = root.join("input.txt");
    fs::write(&payload, "new body\n").unwrap();
    let written = json(edit_cli(
        &root,
        &root,
        &[
            "write",
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "--file",
            payload.to_str().unwrap(),
        ],
        "",
    ));
    let snapshot = written["data"]["snapshotId"].as_str().unwrap();
    assert_eq!(
        read_snapshot_text(&root, snapshot).unwrap().content,
        after_append
    );
    assert_eq!(
        fs::read_to_string(&note).unwrap(),
        format!("{header}new body\r\n")
    );
    assert!(list_snapshots(&root, &note)
        .unwrap()
        .iter()
        .all(|entry| entry.reason == "cli-edit"));
    let noop = json(edit_cli(
        &root,
        &root,
        &["write", "Source.md"],
        "new body\n",
    ));
    assert_eq!(noop["data"]["changed"], false);
    assert_eq!(list_snapshots(&root, &note).unwrap().len(), 2);
}

#[test]
fn new_uses_no_replace_and_dry_run_writes_neither_a_note_nor_history() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let preview = json(edit_cli(
        root,
        root,
        &["new", "Note", "--dry-run"],
        "# Draft\n",
    ));
    assert_eq!(preview["data"]["path"], "Note.md");
    assert!(preview["data"]["diff"]
        .as_str()
        .unwrap()
        .contains("+++ Note.md"));
    assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    assert!(edit_cli(root, root, &["new", "Note"], "# Created\n")
        .status
        .success());
    let original = fs::read_to_string(root.join("Note.md")).unwrap();
    assert!(amby_core::frontmatter::parse_markdown(&original)
        .note_id()
        .is_some());
    let conflict = edit_cli(root, root, &["new", "Note.md"], "# Wrong\n");
    assert_eq!(conflict.status.code(), Some(6));
    assert_eq!(json(conflict)["error"]["code"], "alreadyExists");
    assert_eq!(fs::read_to_string(root.join("Note.md")).unwrap(), original);
}

fn mcp_writes(root: &Path, flag: Option<&str>, calls: &[Value]) -> Vec<Value> {
    let mut child = cli(root)
        .arg("--vault")
        .arg(root)
        .arg("mcp")
        .args(flag)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn the MCP server");
    let mut input = child.stdin.take().expect("MCP stdin is piped");
    for request in calls {
        writeln!(input, "{request}").expect("send the request");
    }
    drop(input);
    let output = child.wait_with_output().expect("wait for the MCP server");
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .expect("MCP responses are UTF-8")
        .lines()
        .map(|line| serde_json::from_str(line).expect("valid JSON-RPC response"))
        .collect()
}

#[test]
fn mcp_write_requires_opt_in_and_confines_a_scoped_grant_to_the_folder() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    for folder in ["Projects", "Projects2"] {
        fs::create_dir(root.join(folder)).unwrap();
        fs::write(root.join(folder).join("Note.md"), "old\n").unwrap();
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("Projects2"), root.join("Projects/Alias")).unwrap();
    let request = |id: u32, tool: &str, path: &str, dry_run: bool| {
        serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {
                "name": tool, "arguments": { "path": path, "content": "next\n", "dryRun": dry_run }
            }
        })
    };
    let body = |reply: &Value| -> Value {
        serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
    };
    let denied = mcp_writes(
        &root,
        None,
        &[request(1, "write_note", "Projects/Note.md", false)],
    );
    assert_eq!(body(&denied[0])["error"], "accessDenied");
    let scoped = mcp_writes(
        &root,
        Some("--allow-write=Projects/"),
        &[
            serde_json::json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
            request(2, "append_note", "Projects2/Note.md", false),
            request(3, "new_note", "Projects/../bad.md", false),
            request(4, "new_note", ".amby/bad.md", false),
            request(5, "write_note", "Projects/Note.md", true),
            request(6, "append_note", "Projects/Note.md", false),
        ],
    );
    // 23 tools plus list_tags, get_properties, four property writes, delete_item, five
    // hygiene and attachment reads, four attachment, order and bulk writes, five note-part,
    // version and open reads, edit_note, restore_version and delete_database_row. Daily notes
    // are opt-in, so daily_note is not listed.
    assert_eq!(scoped[0]["result"]["tools"].as_array().unwrap().len(), 49);
    for reply in &scoped[1..4] {
        assert_eq!(body(reply)["error"], "accessDenied");
    }
    assert_eq!(body(&scoped[4])["dryRun"], true);
    assert_eq!(body(&scoped[4])["snapshotId"], Value::Null);
    let note = root.join("Projects/Note.md");
    assert_eq!(fs::read_to_string(&note).unwrap(), "old\nnext\n");
    let history = amby_core::history::list_snapshots(&root, &note).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].reason, "ai-edit");
    assert_eq!(
        fs::read_to_string(root.join("Projects2/Note.md")).unwrap(),
        "old\n"
    );
    #[cfg(unix)]
    {
        let denied = mcp_writes(
            &root,
            Some("--allow-write"),
            &[request(1, "write_note", "Projects/Alias/Note.md", false)],
        );
        assert_eq!(body(&denied[0])["error"], "accessDenied");
    }
}

fn structural_command(root: &Path, args: &[&str]) -> (Option<i32>, Value) {
    let output = cli(root)
        .arg("--vault")
        .arg(root)
        .arg("--json")
        .args(args)
        .output()
        .expect("run the CLI structural command");
    (output.status.code(), json(output))
}

fn structural_success(root: &Path, args: &[&str]) -> Value {
    let (code, body) = structural_command(root, args);
    assert_eq!(code, Some(0), "{args:?}: {body}");
    body["data"].clone()
}

#[test]
fn structural_preview_rename_move_archive_and_restore() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let note = "\u{feff}---\r\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\namby-title: Alpha\r\nunknown: keep # comment\r\n---\r\nBody\r\n";
    let reference = "See [[Alpha#Heading|Alias]] and `[[Alpha]]`.\r\n";
    fs::write(root.join("Alpha.md"), note).unwrap();
    fs::write(root.join("Reference.md"), reference).unwrap();
    fs::create_dir(root.join("Projects")).unwrap();

    let dry = structural_success(root, &["rename", "Alpha.md", "Renamed", "--dry-run"]);
    assert_eq!(dry["destination"], "Renamed.md");
    assert_eq!(dry["dryRun"], true);
    assert!(dry["rewrittenPaths"]
        .as_array()
        .unwrap()
        .contains(&Value::from("Reference.md")));
    assert!(!root.join(".amby").exists());
    assert_eq!(fs::read_to_string(root.join("Alpha.md")).unwrap(), note);
    assert_eq!(
        fs::read_to_string(root.join("Reference.md")).unwrap(),
        reference
    );

    structural_success(root, &["rename", "Alpha.md", "Renamed"]);
    let renamed = fs::read_to_string(root.join("Renamed.md")).unwrap();
    assert_eq!(
        renamed,
        note.replace("amby-title: Alpha", "amby-title: Renamed")
    );
    assert_eq!(
        fs::read_to_string(root.join("Reference.md")).unwrap(),
        "See [[Renamed#Heading|Alias]] and `[[Alpha]]`.\r\n"
    );
    structural_success(root, &["move", "Renamed.md", "Projects"]);
    assert_eq!(
        fs::read_to_string(root.join("Projects/Renamed.md")).unwrap(),
        renamed
    );
    structural_success(root, &["archive", "Projects/Renamed.md"]);
    assert!(!root.join("Projects/Renamed.md").exists());
    let archive = structural_success(root, &["archive", "list"]);
    assert!(
        archive.to_string().contains("Projects/Renamed.md"),
        "{archive}"
    );
    fs::write(root.join("Projects/Renamed.md"), "occupied").unwrap();
    let restored = structural_success(root, &["restore", "Projects/Renamed.md"]);
    let restored_path = restored["destination"].as_str().unwrap();
    assert_ne!(restored_path, "Projects/Renamed.md");
    assert_eq!(
        fs::read_to_string(root.join(restored_path)).unwrap(),
        renamed
    );
    assert_eq!(
        fs::read_to_string(root.join("Projects/Renamed.md")).unwrap(),
        "occupied"
    );
    assert!(!root.join(".amby/recovery/cli/structural.json").exists());
}

#[test]
fn an_open_vault_allows_preview_and_blocks_structural_writes() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    fs::write(root.join("Original.md"), "Body").unwrap();
    let context = amby_core::vault_context::VaultContext::default();
    context.reserve_desktop(&root).unwrap();
    context.reserve_desktop(&root).unwrap();

    structural_success(&root, &["rename", "Original.md", "original", "--dry-run"]);
    for args in [&["rename", "Original.md", "original"][..], &["recover"][..]] {
        let (code, body) = structural_command(&root, args);
        assert_eq!(code, Some(7), "{body}");
        assert_eq!(body["error"]["code"], "vaultBusy");
    }
    drop(context);
    structural_success(&root, &["rename", "Original.md", "original"]);
    assert!(fs::read_dir(&root)
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| entry.file_name() == "original.md"));
}

#[test]
fn bundle_rename_preserves_manifest_identity_and_moves_the_whole_tree() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    fs::create_dir(root.join("Bundle")).unwrap();
    fs::write(root.join("Bundle/Bundle.md"), "Main").unwrap();
    fs::write(root.join("Bundle/Bundle.canvas"), "{}").unwrap();
    fs::write(root.join("Bundle/Child.md"), "Child").unwrap();
    fs::write(
        root.join("Bundle/Bundle.json"),
        r#"{"name":"Bundle","id":"keep-id","future":{"key":true}}"#,
    )
    .unwrap();
    structural_success(root, &["rename", "Bundle/Bundle.md", "Renamed"]);
    assert!(!root.join("Bundle").exists());
    assert_eq!(
        fs::read_to_string(root.join("Renamed/Renamed.md")).unwrap(),
        "Main"
    );
    assert_eq!(
        fs::read_to_string(root.join("Renamed/Renamed.canvas")).unwrap(),
        "{}"
    );
    assert_eq!(
        fs::read_to_string(root.join("Renamed/Child.md")).unwrap(),
        "Child"
    );
    let manifest: Value =
        serde_json::from_slice(&fs::read(root.join("Renamed/Renamed.json")).unwrap()).unwrap();
    assert_eq!(
        manifest,
        serde_json::json!({"name":"Renamed","id":"keep-id","future":{"key":true}})
    );
    structural_success(root, &["archive", "Renamed/Renamed.md"]);
    structural_success(root, &["restore", "Renamed"]);
    assert_eq!(
        fs::read_to_string(root.join("Renamed/Child.md")).unwrap(),
        "Child"
    );
}

#[test]
fn busy_vault_routes_to_one_authenticated_desktop_request() {
    use amby_core::cli_ipc::{self, Action, Payload};
    use amby_core::structural::Outcome;

    let profile = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    fs::write(root.join("Original.md"), "Body").unwrap();
    let _lease = amby_core::structural::try_lease(&root).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut listener = {
        let _scope = runtime.enter();
        let listener = cli_ipc::Listener::bind(profile.path()).unwrap();
        assert!(cli_ipc::Listener::bind(profile.path()).is_err());
        listener
    };
    let invoke = || {
        cli(profile.path())
            .arg("--vault")
            .arg(&root)
            .args(["--json", "rename", "Original.md", "Renamed"])
            .output()
            .expect("run the CLI in an isolated profile")
    };

    std::thread::scope(|scope| {
        let cli = scope.spawn(invoke);
        runtime.block_on(async {
            let mut stream =
                tokio::time::timeout(std::time::Duration::from_secs(10), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            let request = cli_ipc::read_request(&mut stream).await.unwrap().unwrap();
            assert_eq!(request.vault, root);
            assert_eq!(request.version, cli_ipc::VERSION);
            assert!(matches!(
                request.action,
                Action::Rename { path, name } if path == "Original.md" && name == "Renamed"
            ));
            cli_ipc::write_response(
                &mut stream,
                Ok(Payload::Mutation(Outcome {
                    source: "Original.md".into(),
                    destination: "Renamed.md".into(),
                    rewritten_paths: vec!["Related.md".into()],
                    dry_run: false,
                })),
            )
            .await
            .unwrap();
        });
        let output = cli.join().unwrap();
        assert!(output.status.success());
        assert_eq!(json(output)["data"]["rewrittenPaths"][0], "Related.md");
    });

    std::thread::scope(|scope| {
        let cli = scope.spawn(invoke);
        runtime.block_on(async {
            let mut stream =
                tokio::time::timeout(std::time::Duration::from_secs(10), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            cli_ipc::read_request(&mut stream).await.unwrap().unwrap();
            drop(stream);
            // Let Tokio finish closing the pipe while the child observes EOF.
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                while !cli.is_finished() {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("CLI exits after the interrupted response");
        });
        let output = cli.join().unwrap();
        assert!(!output.status.success());
        assert_eq!(json(output)["error"]["code"], "desktopRequestInterrupted");
    });
    assert!(!root.join("Renamed.md").exists());
    assert_eq!(
        fs::read_to_string(root.join("Original.md")).unwrap(),
        "Body"
    );
}

fn tool_call(root: &Path, grant: Option<&str>, name: &str, args: Value) -> Value {
    let replies = mcp_writes(
        root,
        grant,
        &[serde_json::json!({
            "jsonrpc":"2.0", "id":1, "method":"tools/call",
            "params":{"name":name,"arguments":args}
        })],
    );
    let text = replies[0]["result"]["content"][0]["text"]
        .as_str()
        .expect("tool returns a text representation");
    serde_json::from_str(text).expect("tool returns valid JSON")
}

#[test]
fn mcp_structural_preview_and_commit_check_every_rewritten_path() {
    use serde_json::json;
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let grant = Some("--allow-write=Projects");
    fs::create_dir(root.join("Projects")).unwrap();
    fs::create_dir(root.join("Projects/Sub")).unwrap();
    fs::create_dir(root.join("Projects2")).unwrap();
    fs::write(root.join("Projects/Topic.md"), "Body\n").unwrap();
    fs::write(root.join("Projects/Local.md"), "[[Topic]]\n").unwrap();
    let outside = root.join("Projects2/Outside.md");
    fs::write(&outside, "[[Topic]]\n").unwrap();
    for dry in [true, false] {
        let result = tool_call(
            root,
            grant,
            "rename_item",
            json!({
                "path":"Projects/Topic.md", "name":"New", "dryRun":dry
            }),
        );
        assert_eq!(result["error"], "outsideWriteScope", "{result}");
        assert!(root.join("Projects/Topic.md").exists());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "[[Topic]]\n");
        assert!(!root.join(".amby/recovery/cli/structural.json").exists());
    }
    fs::remove_file(outside).unwrap();
    let preview = tool_call(
        root,
        grant,
        "rename_item",
        json!({
            "path":"Projects/Topic.md", "name":"New", "dryRun":true
        }),
    );
    assert_eq!(preview["dryRun"], true, "{preview}");
    assert_eq!(
        preview["affectedPaths"],
        json!(["Projects/Local.md", "Projects/New.md", "Projects/Topic.md"])
    );
    assert!(root.join("Projects/Topic.md").exists());
    let result = tool_call(
        root,
        grant,
        "rename_item",
        json!({"path":"Projects/Topic.md", "name":"New"}),
    );
    assert_eq!(result["destination"], "Projects/New.md", "{result}");
    assert_eq!(
        fs::read_to_string(root.join("Projects/Local.md")).unwrap(),
        "[[New]]\n"
    );

    for (tool, arguments, expected) in [
        (
            "move_item",
            json!({"path":"Projects/New.md","folder":"Projects2"}),
            None,
        ),
        (
            "move_item",
            json!({"path":"Projects/New.md","folder":"Projects/Sub"}),
            Some("Projects/Sub/New.md"),
        ),
        (
            "archive_item",
            json!({"path":"Projects/Sub/New.md"}),
            Some("Projects/Sub/New.md"),
        ),
        (
            "restore_item",
            json!({"path":"Projects/Sub/New.md"}),
            Some("Projects/Sub/New.md"),
        ),
    ] {
        let result = tool_call(root, grant, tool, arguments);
        if let Some(expected) = expected {
            assert_eq!(result["destination"], expected, "{result}");
        } else {
            assert_eq!(result["error"], "outsideWriteScope", "{result}");
        }
    }
    assert!(root.join("Projects/Sub/New.md").is_file());
}

#[test]
fn mcp_manages_database_rows_and_rejects_stale_revisions() {
    use serde_json::json;
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    fs::create_dir(root.join("Work")).unwrap();
    fs::create_dir(root.join("Other")).unwrap();
    let grant = Some("--allow-write=Work");
    let result = tool_call(
        root,
        grant,
        "create_database",
        json!({"parent":"Other","name":"Tasks"}),
    );
    assert_eq!(result["error"], "outsideWriteScope", "{result}");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(root.join("Other"), root.join("Work/Alias")).unwrap();
        let result = tool_call(
            root,
            grant,
            "create_database",
            json!({"parent":"Work","name":"Alias"}),
        );
        assert_eq!(result["error"], "accessDenied", "{result}");
        assert!(!root.join("Other/Alias.json").exists());
    }
    let db = tool_call(
        root,
        grant,
        "create_database",
        json!({"parent":"Work","name":"Tasks"}),
    );
    let db_id = db["databaseId"].as_str().unwrap_or_else(|| panic!("{db}"));
    let property = tool_call(
        root,
        grant,
        "add_database_property",
        json!({
            "databaseId":db_id,"name":"Done","propertyType":"checkbox","expectedRevision":db["revision"]
        }),
    );
    let property_id = property["propertyId"]
        .as_str()
        .unwrap_or_else(|| panic!("{property}"));
    for title in ["First task", "Second task"] {
        let page = tool_call(
            root,
            grant,
            "create_database_row",
            json!({"databaseId":db_id,"title":title}),
        );
        assert!(page["noteId"].is_string(), "{page}");
    }

    let first = tool_call(
        root,
        None,
        "query_database",
        json!({"databaseId":db_id,"limit":1}),
    );
    assert_eq!(first["totalCount"], 2, "{first}");
    let row = &first["rows"][0];
    let next = tool_call(
        root,
        None,
        "query_database",
        json!({
            "databaseId":db_id,"limit":1,"cursor":first["nextCursor"]
        }),
    );
    assert_ne!(row["noteId"], next["rows"][0]["noteId"], "{next}");
    let mut arguments = json!({
        "databaseId":db_id,"noteId":row["noteId"],"propertyId":property_id,"expectedRevision":row["revision"],
        "operationId":"complete-task","value":{"type":"checkbox","checked":true}
    });
    // Scope applies to recovery as well as the requested row. The existing
    // desktop batch writer may reconcile other operations, so plant an actual
    // interrupted batch in another folder and verify the MCP worker skips it.
    let recovery = root.join(".amby/recovery/database_batches");
    let backup = ".amby/recovery/database_batches/unrelated/BackedUp.md";
    fs::create_dir_all(recovery.join("unrelated")).unwrap();
    fs::write(root.join(backup), "before").unwrap();
    fs::write(root.join("Other/Unrelated.md"), "interrupted").unwrap();
    let unrelated = recovery.join("unrelated.json");
    let journal = json!({
        "format":"amby-database-recovery", "formatVersion":1, "operationId":"unrelated",
        "databaseId":db_id, "requestRevision":"fixture", "status":"inProgress",
        "steps":[{
            "recordPath":"Other/Unrelated.md", "backupPath":backup, "status":"planned",
            "originalRevision":amby_core::database::format::raw_revision(b"before"),
            "targetRevision":amby_core::database::format::raw_revision(b"interrupted")
        }]
    })
    .to_string();
    fs::write(&unrelated, &journal).unwrap();
    let changed = tool_call(root, grant, "set_database_value", arguments.clone());
    assert!(changed["revisions"][0]["revision"].is_string(), "{changed}");
    assert_eq!(
        fs::read_to_string(root.join("Other/Unrelated.md")).unwrap(),
        "interrupted"
    );
    assert_eq!(fs::read_to_string(unrelated).unwrap(), journal);
    let replay = tool_call(root, grant, "set_database_value", arguments.clone());
    assert_eq!(changed["revisions"], replay["revisions"], "{replay}");
    arguments["value"]["checked"] = json!(false);
    let reused = tool_call(root, grant, "set_database_value", arguments.clone());
    assert_eq!(reused["error"], "operationIdReused", "{reused}");
    arguments["operationId"] = json!("stale-task");
    let stale = tool_call(root, grant, "set_database_value", arguments);
    assert_eq!(stale["error"], "revisionConflict", "{stale}");

    let read = tool_call(root, None, "read_database", json!({"databaseId":db_id}));
    assert_eq!(read["properties"][0]["id"], property_id, "{read}");
    let row_path = root.join(row["path"].as_str().unwrap());
    let raw = fs::read_to_string(&row_path).unwrap();
    assert!(raw.contains("Done: true"), "{raw}");
    let renamed = tool_call(
        root,
        grant,
        "rename_database",
        json!({
            "databaseId":db_id,"name":"Project Tasks","expectedRevision":property["revision"]
        }),
    );
    assert_eq!(renamed["name"], "Project Tasks", "{renamed}");
    let stale = tool_call(
        root,
        grant,
        "rename_database_property",
        json!({
            "databaseId":db_id,"propertyId":property_id,"name":"Complete","expectedRevision":property["revision"]
        }),
    );
    assert_eq!(stale["error"], "revisionConflict", "{stale}");
    let field = tool_call(
        root,
        grant,
        "rename_database_property",
        json!({
            "databaseId":db_id,"propertyId":property_id,"name":"Complete","expectedRevision":renamed["revision"]
        }),
    );
    assert_eq!(field["name"], "Complete", "{field}");
    assert_eq!(fs::read_to_string(row_path).unwrap(), raw);
    assert!(!root.join(".amby/notes.db").exists());
}

#[test]
fn mcp_manages_workshops_with_operation_replay_and_folder_scope() {
    use serde_json::json;
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    fs::create_dir(root.join("Writing")).unwrap();
    fs::create_dir(root.join("Other")).unwrap();
    fs::create_dir(root.join(".amby")).unwrap();
    fs::write(
        root.join(".amby/workspace.json"),
        r#"{"profile":{"id":"custom"},"enabledModules":["amby.databases","amby.creative"]}"#,
    )
    .unwrap();
    let grant = Some("--allow-write=Writing");
    let request = json!({"parent":"Writing","name":"World","operationId":"world"});
    let created = tool_call(root, grant, "create_workshop", request.clone());
    let id = created["workshopId"]
        .as_str()
        .unwrap_or_else(|| panic!("{created}"));
    let replay = tool_call(root, grant, "create_workshop", request);
    assert_eq!(replay["workshopId"], id, "{replay}");
    assert_eq!(replay["replayed"], true, "{replay}");

    let story = json!({"workshopId":id,"title":"Beginning","operationId":"beginning"});
    let denied = tool_call(
        root,
        Some("--allow-write=Other"),
        "create_story",
        story.clone(),
    );
    assert_eq!(denied["error"], "outsideWriteScope", "{denied}");
    let story = tool_call(root, grant, "create_story", story);
    assert!(story["storyId"].is_string(), "{story}");
    let section = tool_call(
        root,
        grant,
        "create_workshop_section",
        json!({
            "workshopId":id,"name":"Research","operationId":"research","expectedRevision":created["revision"]
        }),
    );
    assert!(section["section"]["databaseId"].is_string(), "{section}");
    let story_id = story["storyId"].as_str().expect("story ID");
    let text = tool_call(root, None, "read_story", json!({"storyId":story_id}));
    let level = text["text"]["levels"][0]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("{text}"));
    let page_args =
        json!({"storyId":story_id,"title":"Chapter One","levelId":level,"orderKey":"a0"});
    let denied = tool_call(
        root,
        Some("--allow-write=Other"),
        "create_text_page",
        page_args.clone(),
    );
    assert_eq!(denied["error"], "outsideWriteScope", "{denied}");
    let page = tool_call(root, grant, "create_text_page", page_args);
    assert!(page["noteId"].is_string(), "{page}");
    assert!(root.join(page["path"].as_str().unwrap()).is_file());
    let deeper = text["text"]["levels"][1]["id"]
        .as_str()
        .expect("second text level");
    let child = tool_call(
        root,
        grant,
        "create_text_page",
        json!({
            "storyId":story_id,"title":"Scene One","levelId":deeper,"orderKey":"a1","parentNoteId":page["noteId"]
        }),
    );
    assert_eq!(child["parentNoteId"], page["noteId"], "{child}");

    let update = json!({
        "workshopId":id,"name":"Worldbuilding","tags":["draft"],
        "operationId":"workshop-details","expectedRevision":section["revision"]
    });
    let updated = tool_call(root, grant, "update_workshop", update.clone());
    assert_eq!(updated["name"], "Worldbuilding", "{updated}");
    assert_eq!(updated["tags"], json!(["draft"]));
    let replay = tool_call(root, grant, "update_workshop", update);
    assert_eq!(replay["replayed"], true, "{replay}");
    let catalog = tool_call(root, None, "read_workshop", json!({"workshopId":id}));
    assert_eq!(
        catalog["stories"][0]["storyId"], story["storyId"],
        "{catalog}"
    );
    assert!(catalog["sections"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["name"] == "Research"));
}

#[test]
fn mcp_rechecks_module_switches_between_requests_in_the_same_session() {
    use serde_json::json;
    use std::io::{BufRead, BufReader};

    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    fs::create_dir(root.join(".amby")).unwrap();
    let settings = root.join(".amby/workspace.json");
    let mut child = cli(root)
        .arg("--vault")
        .arg(root)
        .args(["mcp", "--allow-write"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut request = |method, params: Value| {
        writeln!(
            input,
            "{}",
            json!({"jsonrpc":"2.0","id":1,"method":method,"params":params})
        )
        .expect("send");
        input.flush().expect("flush");
        let mut line = String::new();
        output.read_line(&mut line).expect("response");
        serde_json::from_str::<Value>(&line).expect("JSON")
    };
    let has = |result: &Value, name: &str| {
        result["result"]["tools"]
            .as_array()
            .is_some_and(|tools| tools.iter().any(|tool| tool["name"] == name))
    };
    let decode = |response: &Value| -> Value {
        serde_json::from_str(
            response["result"]["content"][0]["text"]
                .as_str()
                .expect("tool text"),
        )
        .expect("tool result")
    };
    let workshops = json!({"name":"list_workshops","arguments":{}});
    let standard = request("tools/list", json!({}));
    assert!(has(&standard, "list_databases"));
    assert!(!has(&standard, "list_workshops"));
    assert_eq!(
        decode(&request("tools/call", workshops.clone()))["error"],
        "moduleDisabled"
    );

    fs::write(
        &settings,
        r#"{"profile":{"id":"custom"},"enabledModules":["databases","creative"]}"#,
    )
    .unwrap();
    let custom = request("tools/list", json!({}));
    assert!(has(&custom, "list_workshops"));
    assert!(has(&custom, "create_workshop"));
    assert_eq!(
        decode(&request("tools/call", workshops.clone()))["workshops"],
        json!([])
    );

    fs::write(
        &settings,
        r#"{"profile":{"id":"custom"},"enabledModules":["amby.creative"]}"#,
    )
    .unwrap();
    let disabled = request("tools/list", json!({}));
    assert!(!has(&disabled, "list_workshops"));
    assert!(!has(&disabled, "read_story"));
    assert!(!has(&disabled, "create_text_page"));
    assert!(!has(&disabled, "rename_database"));

    assert!(!has(&disabled, "create_database"));
    assert!(has(&disabled, "rename_item"));
    for (name, args) in [
        ("create_database", json!({"parent":".","name":"Tasks"})),
        (
            "create_workshop",
            json!({"parent":".","name":"Drafts","operationId":"blocked"}),
        ),
    ] {
        let result = request("tools/call", json!({"name":name,"arguments":args}));
        assert_eq!(decode(&result)["error"], "moduleDisabled");
    }
    assert!(!root.join("Tasks").exists());
    assert!(!root.join("Drafts").exists());
    assert!(!root.join(".amby/operation.lock").exists());

    fs::write(&settings, b"not JSON").unwrap();
    let result = request("tools/call", workshops);
    assert_eq!(decode(&result)["error"], "moduleSettingsUnavailable");
    drop(input);
    assert!(child.wait().unwrap().success());
}

#[test]
fn mcp_relation_checks_both_manifests_and_removed_inverse_records() {
    use serde_json::json;
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    fs::create_dir(root.join("Allowed")).unwrap();
    fs::create_dir(root.join("Other")).unwrap();
    let full = Some("--allow-write");
    let scoped = Some("--allow-write=Allowed");
    let source = tool_call(
        root,
        full,
        "create_database",
        json!({"parent":"Allowed","name":"Source"}),
    );
    let target = tool_call(
        root,
        full,
        "create_database",
        json!({"parent":"Other","name":"Target"}),
    );
    let source_schema = root.join("Allowed/Source/Source.json");
    let target_schema = root.join("Other/Target/Target.json");
    let schemas_before = [&source_schema, &target_schema].map(|path| fs::read(path).unwrap());
    let schema_request = json!({
        "databaseId":source["databaseId"],"targetDatabaseId":target["databaseId"],
        "name":"Related","inverseName":"Backlinks","expectedRevision":source["revision"],
        "expectedTargetRevision":target["revision"],"operationId":"pair"
    });
    let denied = tool_call(
        root,
        scoped,
        "create_database_relation",
        schema_request.clone(),
    );
    assert_eq!(denied["error"], "outsideWriteScope", "{denied}");
    assert_eq!(
        [&source_schema, &target_schema].map(|path| fs::read(path).unwrap()),
        schemas_before
    );
    let relation = tool_call(
        root,
        full,
        "create_database_relation",
        schema_request.clone(),
    );
    assert!(relation["inversePropertyId"].is_string(), "{relation}");
    let replay = tool_call(root, full, "create_database_relation", schema_request);
    assert_eq!(relation["propertyId"], replay["propertyId"], "{replay}");

    let left = tool_call(
        root,
        full,
        "create_database_row",
        json!({"databaseId":source["databaseId"],"title":"Left"}),
    );
    let right = tool_call(
        root,
        full,
        "create_database_row",
        json!({"databaseId":target["databaseId"],"title":"Right"}),
    );
    let left_path = root.join(left["path"].as_str().unwrap());
    let right_path = root.join(right["path"].as_str().unwrap());
    let before = [&left_path, &right_path].map(|path| fs::read(path).unwrap());
    let link = json!({
        "databaseId":source["databaseId"],"noteId":left["noteId"],"propertyId":relation["propertyId"],
        "targetNoteIds":[right["noteId"]],"expectedRevision":left["revision"],"operationId":"link"
    });
    let mut preview = link.clone();
    preview["dryRun"] = true.into();
    for request in [link.clone(), preview.clone()] {
        let denied = tool_call(root, scoped, "set_database_relation", request);
        assert_eq!(
            denied["error"], "outsideWriteScope",
            "{denied} input = {link}"
        );
    }
    let preview = tool_call(root, full, "set_database_relation", preview);
    assert_eq!(
        preview["affectedPaths"],
        json!([left["path"], right["path"]]),
        "{preview}"
    );
    assert_eq!(preview["dryRun"], true);
    assert_eq!(
        [&left_path, &right_path].map(|path| fs::read(path).unwrap()),
        before
    );

    let linked = tool_call(root, full, "set_database_relation", link.clone());
    assert_eq!(
        linked["affectedPaths"], preview["affectedPaths"],
        "{linked}"
    );
    assert!(fs::read_to_string(&left_path)
        .unwrap()
        .contains(right["noteId"].as_str().unwrap()));
    assert!(fs::read_to_string(&right_path)
        .unwrap()
        .contains(left["noteId"].as_str().unwrap()));
    let replay = tool_call(root, full, "set_database_relation", link);
    assert_eq!(replay["replayed"], true, "{replay}");

    let revision = linked["revisions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["noteId"] == left["noteId"])
        .unwrap();
    let clear = json!({
        "databaseId":source["databaseId"],"noteId":left["noteId"],"propertyId":relation["propertyId"],
        "targetNoteIds":[],"expectedRevision":revision["revision"],"operationId":"clear"
    });
    let linked_bytes = [&left_path, &right_path].map(|path| fs::read(path).unwrap());
    let denied = tool_call(root, scoped, "set_database_relation", clear.clone());
    assert_eq!(denied["error"], "outsideWriteScope", "{denied}");
    assert_eq!(
        [&left_path, &right_path].map(|path| fs::read(path).unwrap()),
        linked_bytes
    );
    let cleared = tool_call(root, full, "set_database_relation", clear);
    assert_eq!(
        cleared["affectedPaths"],
        json!([left["path"], right["path"]]),
        "{cleared}"
    );
    assert!(!fs::read_to_string(&left_path)
        .unwrap()
        .contains(right["noteId"].as_str().unwrap()));
    assert!(!fs::read_to_string(&right_path)
        .unwrap()
        .contains(left["noteId"].as_str().unwrap()));
}
