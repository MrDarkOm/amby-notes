//! Shared fixtures of the CLI contract tests: a disposable vault, the JSON envelope and
//! one MCP session per call.
#![allow(dead_code)]

use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

pub const ID_MEETING: &str = "01JC0000000000000000000001";
pub const ID_PLAN: &str = "01JC0000000000000000000002";
pub const LAYOUT: &str =
    "{\"groups\":16,\"hash\":\"blake3-first-hex\",\"template\":1,\"version\":1}\n";
pub const MEETING: &str = "---\r\namby-id: 01JC0000000000000000000001\r\nstatus: active\r\ntags: [work, meeting]\r\n---\r\n# Meeting\r\n\r\nAgenda for [[Plan]]. #todo\r\n";

pub struct Vault {
    _dir: tempfile::TempDir,
    _home: tempfile::TempDir,
    pub root: PathBuf,
    pub home: PathBuf,
}

/// A vault in the property-group format with three notes in two folders.
#[allow(
    clippy::unwrap_used,
    reason = "a fixture that cannot be set up fails the test"
)]
pub fn vault(groups: bool) -> Vault {
    let dir = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    fs::create_dir_all(root.join("Projects")).unwrap();
    fs::create_dir_all(root.join("Daily")).unwrap();
    if groups {
        fs::create_dir_all(root.join(".amby/properties")).unwrap();
        fs::write(root.join(".amby/properties/layout.json"), LAYOUT).unwrap();
    }
    fs::write(root.join("Projects/Meeting.md"), MEETING).unwrap();
    fs::write(
        root.join("Projects/Plan.md"),
        format!("---\namby-id: {ID_PLAN}\nstatus: done\n---\n# Plan\n\nSee [[Meeting]].\n"),
    )
    .unwrap();
    fs::write(
        root.join("Daily/My note.md"),
        "---\nstatus: active\n---\n# My note\n\nWorked on #work today.\n",
    )
    .unwrap();
    let home_path = home.path().to_owned();
    Vault {
        _dir: dir,
        _home: home,
        root,
        home: home_path,
    }
}

#[allow(
    clippy::unwrap_used,
    reason = "a fixture that cannot be set up fails the test"
)]
impl Vault {
    pub fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_amby"))
            .env("AMBY_APP_DATA_DIR", &self.home)
            .env_remove("AMBY_VAULT")
            .env("LANG", "en_US.UTF-8")
            .arg("--vault")
            .arg(&self.root)
            .args(args)
            .output()
            .unwrap()
    }

    /// `--json` envelope and the exit code.
    pub fn json(&self, args: &[&str]) -> (Option<i32>, Value) {
        let mut all = vec!["--json"];
        all.extend_from_slice(args);
        let output = self.run(&all);
        let value: Value = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|_| panic!("JSON envelope for {args:?}: {output:?}"));
        (output.status.code(), value)
    }

    pub fn ok(&self, args: &[&str]) -> Value {
        let (code, value) = self.json(args);
        assert_eq!(code, Some(0), "{args:?}: {value}");
        assert_eq!(value["ok"], true, "{value}");
        value["data"].clone()
    }

    pub fn error(&self, args: &[&str]) -> (Option<i32>, String) {
        let (code, value) = self.json(args);
        assert_eq!(value["ok"], false, "{args:?}: {value}");
        (code, value["error"]["code"].as_str().unwrap().to_owned())
    }

    pub fn read(&self, path: &str) -> String {
        fs::read_to_string(self.root.join(path)).unwrap()
    }

    /// Every JSON-RPC response of one MCP session.
    pub fn mcp(&self, flag: Option<&str>, calls: &[Value]) -> Vec<Value> {
        let mut child = Command::new(env!("CARGO_BIN_EXE_amby"))
            .env("AMBY_APP_DATA_DIR", &self.home)
            .arg("--vault")
            .arg(&self.root)
            .arg("mcp")
            .args(flag)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let initialize = json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{
            "protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}});
        writeln!(input, "{initialize}").unwrap();
        for call in calls {
            writeln!(input, "{call}").unwrap();
        }
        drop(input);
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// The structured result of one tool call.
    pub fn tool(&self, flag: Option<&str>, name: &str, arguments: Value) -> Value {
        let replies = self.mcp(
            flag,
            &[json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
                "params":{"name":name,"arguments":arguments}})],
        );
        let text = replies[1]["result"]["content"][0]["text"].as_str().unwrap();
        serde_json::from_str(text).unwrap()
    }

    pub fn tool_names(&self, flag: Option<&str>) -> Vec<String> {
        let replies = self.mcp(
            flag,
            &[json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})],
        );
        replies[1]["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect()
    }

    /// Files under `.amby/history` (snapshots taken before writes).
    pub fn snapshots(&self) -> usize {
        fs::read_dir(self.root.join(".amby/history"))
            .map(|entries| {
                entries
                    .filter(|entry| {
                        entry.as_ref().is_ok_and(|entry| {
                            entry
                                .path()
                                .extension()
                                .is_some_and(|ext| ext == "snapshot")
                        })
                    })
                    .count()
            })
            .unwrap_or(0)
    }
}

#[allow(
    clippy::unwrap_used,
    reason = "a fixture that cannot be set up fails the test"
)]
pub fn property<'a>(listing: &'a Value, name: &str) -> &'a Value {
    listing["properties"]
        .as_array()
        .unwrap_or_else(|| panic!("properties array in {listing}"))
        .iter()
        .find(|property| property["name"] == name)
        .unwrap_or_else(|| panic!("property {name} in {listing}"))
}

#[allow(
    clippy::unwrap_used,
    reason = "a fixture that cannot be set up fails the test"
)]
pub fn paths(results: &Value) -> Vec<String> {
    let mut paths: Vec<String> = results
        .as_array()
        .unwrap()
        .iter()
        .map(|hit| hit["path"].as_str().unwrap().to_owned())
        .collect();
    paths.sort();
    paths
}
