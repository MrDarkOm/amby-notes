use super::*;
use std::sync::atomic::{AtomicU32, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "amby-claude-home-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

fn vars(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    pairs
        .iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect()
}

#[test]
fn the_environment_keeps_only_what_the_process_needs() {
    let env = sanitized_env(
        vars(&[
            ("PATH", "/bin"),
            ("HOME", "/home/u"),
            ("LC_ALL", "C"),
            ("Path", "C:\\x"),
            ("ANTHROPIC_API_KEY", "sk-secret"),
            ("ANTHROPIC_AUTH_TOKEN", "t"),
            ("CLAUDE_CODE_OAUTH_TOKEN", "t"),
            ("CLAUDE_CONFIG_DIR", "/home/u/.claude"),
            ("AWS_SECRET_ACCESS_KEY", "x"),
            ("AMBY_MCP_TOKEN", "stale"),
            ("OPENAI_API_KEY", "x"),
        ]),
        Path::new("/app/claude"),
    );
    let names: Vec<String> = env
        .iter()
        .map(|(k, _)| k.to_string_lossy().into_owned())
        .collect();
    for kept in ["PATH", "HOME", "LC_ALL", "Path"] {
        assert!(names.contains(&kept.to_owned()), "{kept}");
    }
    for dropped in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "AWS_SECRET_ACCESS_KEY",
        "AMBY_MCP_TOKEN",
        "OPENAI_API_KEY",
    ] {
        assert!(!names.contains(&dropped.to_owned()), "{dropped}");
    }
    // The user's own config directory is replaced, never passed on.
    let dirs: Vec<_> = env
        .iter()
        .filter(|(k, _)| k == "CLAUDE_CONFIG_DIR")
        .collect();
    assert_eq!(dirs.len(), 1);
    assert_eq!(dirs[0].1, OsString::from("/app/claude"));
}

#[test]
fn the_home_has_an_empty_workspace_and_keeps_the_sign_in() {
    let root = scratch();
    let home = prepare_home(&root).unwrap();
    assert_eq!(home.home, root.join("claude"));
    std::fs::write(home.home.join(".credentials.json"), b"keep").unwrap();
    std::fs::write(home.workspace.join("stray.txt"), b"x").unwrap();
    std::fs::create_dir(home.workspace.join("dir")).unwrap();
    let again = prepare_home(&root).unwrap();
    assert_eq!(std::fs::read_dir(&again.workspace).unwrap().count(), 0);
    assert_eq!(
        std::fs::read(home.home.join(".credentials.json")).unwrap(),
        b"keep"
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_home_is_refused() {
    let root = scratch();
    let elsewhere = scratch();
    std::os::unix::fs::symlink(&elsewhere, root.join("claude")).unwrap();
    assert_eq!(prepare_home(&root), Err(ClaudeError::Io));
}

#[test]
fn a_relative_or_missing_root_is_refused() {
    assert_eq!(prepare_home(Path::new("relative")), Err(ClaudeError::Io));
    assert_eq!(
        prepare_home(&scratch().join("missing")),
        Err(ClaudeError::Io)
    );
}

#[test]
fn the_debug_output_never_shows_the_token() {
    let home = prepare_home(&scratch())
        .unwrap()
        .with_bridge_token("secret-token".into());
    assert!(!format!("{home:?}").contains("secret-token"));
}
