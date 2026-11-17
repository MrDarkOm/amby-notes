//! Shared primitives for durable multi-file operations (see
//! `docs/mutation-protocol.md`). Journals are untrusted input: every path and
//! identifier is validated here before a domain journal acts on it. Domain
//! modules pass a `label` ("Relation recovery") that only shapes error text.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::frontmatter::{self, AtomicCreateError};

/// Operation IDs become file names, so they are restricted to a portable subset.
pub(crate) fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// A revision is the lowercase hex SHA-256 of raw bytes.
pub(crate) fn valid_revision(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Splits a journal-relative path into safe components: `/`-separated, no
/// empty, `.`/`..`, absolute, drive or backslash parts.
pub(crate) fn relative_components<'a>(
    relative: &'a str,
    label: &str,
) -> Result<Vec<&'a str>, String> {
    let unsafe_path = || format!("Unsafe path in {label} journal");
    if relative.is_empty()
        || relative.contains('\\')
        || Path::new(relative)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(unsafe_path());
    }
    let components = relative.split('/').collect::<Vec<_>>();
    if components
        .iter()
        .any(|component| component.is_empty() || matches!(*component, "." | ".."))
    {
        return Err(unsafe_path());
    }
    Ok(components)
}

/// Joins `relative` under `vault`, rejecting symlinks anywhere on the way
/// (including aliases that stay inside the vault) and paths that canonicalize
/// elsewhere.
pub(crate) fn guarded_path(vault: &Path, relative: &str, label: &str) -> Result<PathBuf, String> {
    let mut path = vault.to_path_buf();
    for component in relative_components(relative, label)? {
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!("Symlink in {label} path"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    if crate::paths::confine(vault, &path)? != path {
        return Err(format!("{label} path changed"));
    }
    Ok(path)
}

/// Inverse of [`guarded_path`]: a vault-relative `/`-joined string.
pub(crate) fn relative_string(vault: &Path, path: &Path, label: &str) -> Result<String, String> {
    let relative = path
        .strip_prefix(vault)
        .map_err(|_| format!("{label} path is outside the vault"))?;
    let parts = relative
        .components()
        .map(|component| match component {
            Component::Normal(name) => name
                .to_str()
                .ok_or_else(|| format!("Non-UTF-8 {label} path")),
            _ => Err(format!("Unsafe {label} path")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(parts.join("/"))
}

/// Creates a file that must not exist yet (no-replace).
pub(crate) fn create_new(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    match frontmatter::atomic_write_bytes_new(path, bytes) {
        Ok(()) => Ok(()),
        Err(AtomicCreateError::AlreadyExists) => Err(format!("{label} file already exists")),
        Err(AtomicCreateError::Other(error)) => Err(error),
    }
}

#[cfg(unix)]
pub(crate) fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
pub(crate) fn sync_directory(_path: &Path) -> Result<(), String> {
    // Match the cross-platform atomic-write helper's directory-sync policy.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("amby-durable-{name}-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
    }

    #[test]
    fn operation_ids_and_revisions_are_strictly_validated() {
        assert!(valid_operation_id("op-1_A"));
        for bad in ["", "a/b", "a.b", "..", "a b", &"x".repeat(161)] {
            assert!(!valid_operation_id(bad), "{bad}");
        }
        assert!(valid_revision(&"a0".repeat(32)));
        for bad in [&"A0".repeat(32), &"a".repeat(63), "", &"g".repeat(64)] {
            assert!(!valid_revision(bad), "{bad}");
        }
    }

    #[test]
    fn relative_components_reject_unsafe_forms() {
        assert_eq!(
            relative_components("a/b.json", "Test").unwrap(),
            vec!["a", "b.json"]
        );
        for bad in ["", "/abs", "a//b", "a/../b", "./a", "a\\b", "a/", "../a"] {
            assert!(relative_components(bad, "Test").is_err(), "{bad}");
        }
    }

    #[test]
    fn guarded_path_rejects_symlinks_and_round_trips() {
        let vault = temp("guard");
        fs::create_dir_all(vault.join("real")).unwrap();
        let path = guarded_path(&vault, "real/file.json", "Test").unwrap();
        assert_eq!(
            relative_string(&vault, &path, "Test").unwrap(),
            "real/file.json"
        );
        assert!(relative_string(&vault, Path::new("/elsewhere/x"), "Test").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(vault.join("real"), vault.join("alias")).unwrap();
            assert!(guarded_path(&vault, "alias/file.json", "Test").is_err());
        }
        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn create_new_never_replaces() {
        let vault = temp("create");
        let file = vault.join("j.json");
        create_new(&file, b"one", "Test").unwrap();
        assert!(create_new(&file, b"two", "Test")
            .unwrap_err()
            .contains("already exists"));
        assert_eq!(fs::read(&file).unwrap(), b"one");
        sync_directory(&vault).unwrap();
        fs::remove_dir_all(&vault).ok();
    }
}
