//! Isolation tests for the Codex home. Written before the implementation and frozen.

use super::*;
use std::sync::atomic::{AtomicU32, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "amby-codex-home-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

fn os(value: &str) -> OsString {
    OsString::from(value)
}

fn vars(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    pairs.iter().map(|(k, v)| (os(k), os(v))).collect()
}

fn lookup(env: &[(OsString, OsString)], key: &str) -> Vec<String> {
    env.iter()
        .filter(|(k, _)| k == key)
        .map(|(_, v)| v.to_string_lossy().into_owned())
        .collect()
}

// ---- config.toml -----------------------------------------------------------

#[test]
fn every_listed_feature_is_switched_off() {
    let config = config_toml();
    let section: Vec<&str> = config
        .lines()
        .skip_while(|line| line.trim() != "[features]")
        .skip(1)
        .take_while(|line| !line.trim_start().starts_with('['))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    for feature in DISABLED_FEATURES {
        assert!(
            section.contains(&format!("{feature} = false").as_str()),
            "{feature} is not switched off in:\n{config}"
        );
    }
    assert!(
        !section.iter().any(|line| line.ends_with("= true")),
        "something is switched on: {section:?}"
    );
}

#[test]
fn the_config_has_no_mcp_servers_no_web_search_and_no_project_docs() {
    let config = config_toml();
    assert!(!config.contains("mcp_servers"));
    assert!(config.contains("web_search = \"disabled\""));
    assert!(config.contains("project_doc_max_bytes = 0"));
}

#[test]
fn the_config_is_stable_text() {
    assert_eq!(config_toml(), config_toml());
    assert!(config_toml().ends_with('\n'));
}

// ---- the directory ---------------------------------------------------------

#[test]
fn the_home_and_an_empty_workspace_are_created_inside_the_root() {
    let root = scratch();
    let home = prepare_home(&root).unwrap();
    assert_eq!(home.home, root.join("codex"));
    assert_eq!(home.workspace, root.join("codex").join("workspace"));
    assert!(home.workspace.is_dir());
    assert_eq!(std::fs::read_dir(&home.workspace).unwrap().count(), 0);
    assert_eq!(
        std::fs::read_to_string(home.home.join("config.toml")).unwrap(),
        config_toml()
    );
}

#[test]
fn preparing_twice_changes_nothing() {
    let root = scratch();
    let first = prepare_home(&root).unwrap();
    let second = prepare_home(&root).unwrap();
    assert_eq!(first, second);
    assert_eq!(
        std::fs::read_to_string(first.home.join("config.toml")).unwrap(),
        config_toml()
    );
}

#[test]
fn a_tampered_config_is_restored() {
    let root = scratch();
    let home = prepare_home(&root).unwrap();
    std::fs::write(
        home.home.join("config.toml"),
        "[mcp_servers.evil]\ncommand = \"sh\"\n",
    )
    .unwrap();
    prepare_home(&root).unwrap();
    assert_eq!(
        std::fs::read_to_string(home.home.join("config.toml")).unwrap(),
        config_toml()
    );
}

#[test]
fn what_codex_keeps_there_is_left_alone_and_strays_in_the_workspace_are_removed() {
    let root = scratch();
    let home = prepare_home(&root).unwrap();
    std::fs::write(home.home.join("auth.json"), b"{\"keep\":true}").unwrap();
    std::fs::write(home.workspace.join("stray.txt"), b"x").unwrap();
    std::fs::create_dir(home.workspace.join("nested")).unwrap();
    std::fs::write(home.workspace.join("nested").join("deep.txt"), b"x").unwrap();
    prepare_home(&root).unwrap();
    assert_eq!(
        std::fs::read(home.home.join("auth.json")).unwrap(),
        b"{\"keep\":true}"
    );
    assert_eq!(std::fs::read_dir(&home.workspace).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn a_home_that_is_a_symlink_is_refused() {
    let root = scratch();
    let elsewhere = scratch();
    std::os::unix::fs::symlink(&elsewhere, root.join("codex")).unwrap();
    assert_eq!(prepare_home(&root), Err(CodexError::Io));
    assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn a_workspace_that_is_a_symlink_is_refused() {
    let root = scratch();
    let elsewhere = scratch();
    std::fs::write(elsewhere.join("precious.txt"), b"x").unwrap();
    std::fs::create_dir(root.join("codex")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, root.join("codex").join("workspace")).unwrap();
    assert_eq!(prepare_home(&root), Err(CodexError::Io));
    assert!(elsewhere.join("precious.txt").exists());
}

#[test]
fn a_missing_root_is_an_error_not_a_creation_elsewhere() {
    assert_eq!(
        prepare_home(Path::new("relative/root")),
        Err(CodexError::Io)
    );
}

// ---- the environment -------------------------------------------------------

#[test]
fn secrets_and_the_users_codex_settings_never_reach_the_process() {
    let env = sanitized_env(
        vars(&[
            ("PATH", "/usr/bin"),
            ("HOME", "/Users/me"),
            ("OPENAI_API_KEY", "sk-secret"),
            ("CODEX_API_KEY", "secret"),
            ("CODEX_HOME", "/Users/me/.codex"),
            ("CODEX_SANDBOX", "x"),
            ("GITHUB_TOKEN", "ghp_secret"),
            ("ANTHROPIC_API_KEY", "secret"),
            ("AWS_SECRET_ACCESS_KEY", "secret"),
            ("SSH_AUTH_SOCK", "/tmp/agent"),
            ("AMBY_MCP_TOKEN", "secret"),
            ("RANDOM_THING", "x"),
        ]),
        Path::new("/app/codex"),
    );
    for name in [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "CODEX_SANDBOX",
        "GITHUB_TOKEN",
        "ANTHROPIC_API_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "SSH_AUTH_SOCK",
        "AMBY_MCP_TOKEN",
        "RANDOM_THING",
    ] {
        assert!(lookup(&env, name).is_empty(), "{name} leaked");
    }
    assert_eq!(lookup(&env, "CODEX_HOME"), vec!["/app/codex"]);
}

#[test]
fn what_the_process_needs_to_run_and_reach_the_network_is_kept() {
    let env = sanitized_env(
        vars(&[
            ("PATH", "/usr/bin"),
            ("HOME", "/Users/me"),
            ("USER", "me"),
            ("LANG", "ru_RU.UTF-8"),
            ("LC_ALL", "ru_RU.UTF-8"),
            ("TMPDIR", "/tmp"),
            ("HTTPS_PROXY", "http://proxy:3128"),
            ("https_proxy", "http://proxy:3128"),
            ("NO_PROXY", "localhost"),
            ("SSL_CERT_FILE", "/etc/ssl/cert.pem"),
        ]),
        Path::new("/app/codex"),
    );
    for (name, value) in [
        ("PATH", "/usr/bin"),
        ("HOME", "/Users/me"),
        ("USER", "me"),
        ("LANG", "ru_RU.UTF-8"),
        ("LC_ALL", "ru_RU.UTF-8"),
        ("TMPDIR", "/tmp"),
        ("HTTPS_PROXY", "http://proxy:3128"),
        ("https_proxy", "http://proxy:3128"),
        ("NO_PROXY", "localhost"),
        ("SSL_CERT_FILE", "/etc/ssl/cert.pem"),
    ] {
        assert_eq!(lookup(&env, name), vec![value], "{name}");
    }
}

#[test]
fn codex_home_is_set_exactly_once_even_if_the_parent_had_one() {
    let env = sanitized_env(
        vars(&[("CODEX_HOME", "/Users/me/.codex")]),
        Path::new("/app/codex"),
    );
    assert_eq!(lookup(&env, "CODEX_HOME"), vec!["/app/codex"]);
}

#[test]
fn windows_style_names_are_kept_regardless_of_case() {
    let env = sanitized_env(
        vars(&[
            ("SystemRoot", "C:\\Windows"),
            ("USERPROFILE", "C:\\Users\\me"),
            ("LOCALAPPDATA", "C:\\Users\\me\\AppData\\Local"),
            ("Path", "C:\\Windows"),
            ("OPENAI_API_KEY", "x"),
        ]),
        Path::new("C:\\app\\codex"),
    );
    for name in ["SystemRoot", "USERPROFILE", "LOCALAPPDATA", "Path"] {
        assert_eq!(lookup(&env, name).len(), 1, "{name}");
    }
    assert!(lookup(&env, "OPENAI_API_KEY").is_empty());
}

// ---- the tool bridge in the config -----------------------------------------

#[test]
fn the_bridge_config_adds_only_amby_on_loopback_and_keeps_every_feature_off() {
    let config = config_toml_with_bridge(51234);
    assert!(
        config.starts_with(&config_toml()),
        "the isolated base must come first"
    );
    assert!(config.contains("[mcp_servers.amby]"));
    assert!(config.contains("url = \"http://127.0.0.1:51234/mcp\""));
    assert!(config.contains(&format!("bearer_token_env_var = \"{BRIDGE_TOKEN_ENV}\"")));
    assert!(config.contains("default_tools_approval_mode = \"approve\""));
    assert_eq!(config.matches("[mcp_servers.").count(), 1);
    assert!(!config.contains("localhost") && !config.contains("0.0.0.0"));
    assert!(
        !config.contains("bearer_token ="),
        "the token itself must never be in the file"
    );
}

#[test]
fn a_turn_with_the_bridge_writes_it_and_the_next_plain_prepare_removes_it() {
    let root = scratch();
    let home = prepare_home_with_bridge(&root, 4242).unwrap();
    let path = home.home.join("config.toml");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        config_toml_with_bridge(4242)
    );
    assert_eq!(home.bridge_token, None);
    prepare_home(&root).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), config_toml());
}

#[test]
fn the_token_is_kept_out_of_debug_output() {
    let root = scratch();
    let home = prepare_home(&root)
        .unwrap()
        .with_bridge_token("super-secret-token".into());
    assert_eq!(home.bridge_token.as_deref(), Some("super-secret-token"));
    assert!(!format!("{home:?}").contains("super-secret-token"));
}
