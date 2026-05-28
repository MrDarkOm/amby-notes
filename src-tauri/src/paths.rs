use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Managed Tauri state: canonicalized root of the currently open vault.
/// Set on `load_vault`; read by path guards so commands that receive a raw
/// path (e.g. `read_file`) can still be confined to the vault.
#[derive(Default)]
pub struct VaultScope(pub Mutex<Option<PathBuf>>);

impl VaultScope {
    pub fn set(&self, vault: PathBuf) {
        *self.0.lock().unwrap() = Some(vault);
    }

    pub fn get(&self) -> Result<PathBuf, String> {
        self.0
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "No vault is open".to_string())
    }
}

/// Resolve `candidate` and verify it stays within `vault`. Works for paths that
/// don't exist yet (a file about to be created): the longest existing ancestor
/// is canonicalized (resolving symlinks), then the remaining tail is appended
/// after rejecting `..` traversal. Returns the resolved real path on success.
pub fn confine(vault: &Path, candidate: &Path) -> Result<PathBuf, String> {
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
pub fn guard(scope: &VaultScope, candidate: &str) -> Result<(), String> {
    confine(&scope.get()?, Path::new(candidate)).map(|_| ())
}

/// Guard a raw path against an explicitly-provided vault root.
pub fn guard_in(vault: &str, candidate: &str) -> Result<(), String> {
    confine(Path::new(vault), Path::new(candidate)).map(|_| ())
}

/// Resolve a *relative* path `rel` under `root` and verify it stays inside.
/// `root` must already exist (callers create it first). Rejects absolute paths
/// and `..` traversal — used by the app-data / vault-meta storage commands where
/// the webview supplies only a relative file name (e.g. `blocks/<id>.json`).
pub fn confine_rel(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err(format!("Path must be relative: {rel}"));
    }
    confine(root, &root.join(rel_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
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
        fs::write(vault.join("note.md"), "hi").unwrap();
        assert!(confine(&vault, &vault.join("note.md")).is_ok());
    }

    #[test]
    fn allows_not_yet_existing_path_inside_vault() {
        let vault = temp_dir("new");
        // Nested file that doesn't exist yet, parent dir also missing.
        assert!(confine(&vault, &vault.join("sub/new.md")).is_ok());
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
}
