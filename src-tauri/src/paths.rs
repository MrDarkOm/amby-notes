use crate::vault_context::VaultContext;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Compatibility name for commands that use only the active vault root. It is
/// the same managed state as the SQLite connection, never a second mutex.
pub type VaultScope = VaultContext;

/// Resolve `candidate` and verify it stays within `vault`. Works for paths that
/// don't exist yet (a file about to be created): the longest existing ancestor
/// is canonicalized (resolving symlinks), then the remaining tail is appended
/// after rejecting `..` traversal. Returns the resolved real path on success.
///
/// Security follow-up: this pathname-based check reduces traversal and symlink
/// escapes but cannot eliminate a post-check symlink-swap (TOCTOU) race. Evaluate
/// a cross-platform directory-handle API such as `cap-std`; Unix-only `openat`
/// is not sufficient for the Windows target.
pub fn confine(vault: &Path, candidate: &Path) -> Result<PathBuf, String> {
    // Reject traversal syntactically before Win32 interprets a verbatim path.
    // Otherwise '\\?\...\..' can fail as an opaque OS error before scoping.
    if candidate
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(format!("Path escapes vault: {}", candidate.display()));
    }
    #[cfg(windows)]
    for component in candidate.components() {
        if let std::path::Component::Normal(name) = component {
            let name = name.to_string_lossy();
            let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
            let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && stem.len() == 4
                    && matches!(stem.as_bytes()[3], b'1'..=b'9');
            if device
                || name.ends_with(['.', ' '])
                || name.contains([':', '<', '>', '"', '|', '?', '*'])
            {
                return Err(format!("Invalid Windows path component: {name}"));
            }
        }
    }
    let vault_real = vault
        .canonicalize()
        .map_err(|e| format!("Vault not accessible ({}): {e}", vault.display()))?;

    let mut existing = candidate.to_path_buf();
    let mut tail: Vec<OsString> = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name().map(|n| n.to_os_string()) else {
            break;
        };
        tail.push(name);
        match existing.parent() {
            Some(parent) => existing = parent.to_path_buf(),
            None => break,
        }
    }

    let mut resolved = existing
        .canonicalize()
        .map_err(|e| format!("Path not accessible ({}): {e}", existing.display()))?;
    for name in tail.iter().rev() {
        if name == ".." {
            return Err(format!("Path escapes vault: {}", candidate.display()));
        }
        if name == "." {
            continue;
        }
        resolved.push(name);
    }

    if resolved.starts_with(&vault_real) {
        Ok(resolved)
    } else {
        Err(format!("Path escapes vault: {}", candidate.display()))
    }
}

/// Guard a raw path against the active vault scope (managed state).
pub fn guard(context: &VaultContext, candidate: &str) -> Result<PathBuf, String> {
    confine(&context.root()?, Path::new(candidate))
}

/// Resolve a *relative* path `rel` under `root` and verify it stays inside.
/// `root` must already exist (callers create it first). Rejects absolute paths
/// and `..` traversal — used by the app-data / vault-meta storage commands where
/// the webview supplies only a relative file name (e.g. `blocks/<id>.json`).
pub fn confine_rel(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.has_root()
        || rel_path
            .components()
            .any(|part| matches!(part, std::path::Component::Prefix(_)))
    {
        return Err(format!("Path must be relative: {rel}"));
    }
    confine(root, &root.join(rel_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("amby-paths-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn allows_existing_path_inside_vault() {
        let vault = temp_dir("inside");
        let note = vault.join("note.md");
        fs::write(&note, "hi").unwrap();
        assert_eq!(
            confine(&vault, &note).unwrap(),
            note.canonicalize().unwrap()
        );
    }

    #[test]
    fn allows_not_yet_existing_path_inside_vault() {
        let vault = temp_dir("new");
        // Nested file that doesn't exist yet, parent dir also missing.
        assert_eq!(
            confine(&vault, &vault.join("sub/new.md")).unwrap(),
            vault.canonicalize().unwrap().join("sub/new.md")
        );
    }

    #[test]
    fn rejects_path_outside_vault() {
        let vault = temp_dir("outside");
        let outside = vault.parent().unwrap().join("secret.md");
        fs::write(&outside, "x").unwrap();
        assert!(confine(&vault, &outside).is_err());
    }

    #[test]
    fn rejects_dotdot_traversal() {
        let vault = temp_dir("traversal");
        let escape = vault.join("../../etc/passwd");
        assert!(confine(&vault, &escape).is_err());
    }

    #[test]
    fn rejects_sibling_with_a_matching_string_prefix() {
        let vault = temp_dir("prefix");
        let sibling = vault.parent().unwrap().join(format!(
            "{}-sibling",
            vault.file_name().unwrap().to_string_lossy()
        ));
        fs::create_dir_all(&sibling).unwrap();
        let outside = sibling.join("note.md");
        fs::write(&outside, "x").unwrap();

        assert!(confine(&vault, &outside).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_existing_path_through_a_symlink_outside_the_vault() {
        let vault = temp_dir("symlink-existing");
        let outside = temp_dir("symlink-existing-outside");
        let secret = outside.join("secret.md");
        fs::write(&secret, "x").unwrap();
        symlink(&outside, vault.join("escape")).unwrap();

        assert!(confine(&vault, &vault.join("escape/secret.md")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_missing_file_under_a_symlinked_parent_outside_the_vault() {
        let vault = temp_dir("symlink-new");
        let outside = temp_dir("symlink-new-outside");
        symlink(&outside, vault.join("escape")).unwrap();

        assert!(confine(&vault, &vault.join("escape/new.md")).is_err());
    }

    #[test]
    fn confine_rel_allows_nested_relative() {
        let root = temp_dir("rel-ok");
        assert!(confine_rel(&root, "blocks/abc.json").is_ok());
    }

    #[test]
    fn confine_rel_rejects_absolute_and_escape() {
        let root = temp_dir("rel-bad");
        assert!(confine_rel(&root, "/etc/passwd").is_err());
        assert!(confine_rel(&root, "../escape.json").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_relative_api_rejects_drive_unc_device_and_stream_paths() {
        let root = temp_dir("windows-paths");
        for path in [
            r"C:\outside.md",
            r"C:outside.md",
            r"\outside.md",
            r"\\server\share\outside.md",
            r"..\outside.md",
            "CON.md",
            "NUL",
            "LPT1.txt",
            "Note.md:stream",
            "trailing.",
            "trailing ",
        ] {
            assert!(confine_rel(&root, path).is_err(), "{path}");
        }
        assert!(confine_rel(&root, r"folder\Unicode 日本語.md").is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires Windows symlink permission; run explicitly and record result"]
    fn windows_symlink_escape_is_rejected() {
        let root = temp_dir("windows-link");
        let outside = temp_dir("windows-link-outside");
        let link = root.join("escape");
        std::os::windows::fs::symlink_dir(&outside, &link)
            .expect("Windows symlink permission required");
        let result = confine_rel(&root, r"escape\new.md");
        fs::remove_dir(&link).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
        assert!(result.is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_escape_is_rejected_without_symlink_privilege() {
        let root = temp_dir("windows-junction");
        let outside = temp_dir("windows-junction-outside");
        fs::write(outside.join("secret.md"), "outside").unwrap();
        let link = root.join("escape");
        let status = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .status()
            .expect("run mklink for disposable directories");
        assert!(status.success(), "create disposable junction");

        let existing = confine_rel(&root, r"escape\secret.md");
        let not_yet_existing = confine_rel(&root, r"escape\new.md");

        fs::remove_dir(&link).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
        assert!(existing.is_err());
        assert!(not_yet_existing.is_err());
    }
}
