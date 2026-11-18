//! Simple edits that leave indexing and watcher notification to the desktop.

use std::fs;
use std::path::{Component, Path, PathBuf};

use ulid::Ulid;

use crate::atomic_fs::{self, AtomicCreateError};
use crate::frontmatter;
use crate::history;
use crate::paths;
use crate::vault::scan::{is_markdown, is_service_directory};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EditKind {
    New,
    Append,
    Write,
}

pub struct Edit {
    relative: String,
    path: PathBuf,
    before: Option<String>,
    after: String,
}

impl Edit {
    pub fn prepare(
        root: &Path,
        relative: &str,
        scope: Option<&Path>,
        kind: EditKind,
        input: &str,
    ) -> Result<Self, &'static str> {
        let mut relative = relative.replace('\\', "/");
        if kind == EditKind::New && !is_markdown(Path::new(&relative)) {
            relative.push_str(".md");
        }
        let path = edit_path(root, &relative, scope)?;
        let before = match fs::symlink_metadata(&path) {
            Ok(_) if kind == EditKind::New => return Err("alreadyExists"),
            Ok(metadata) if metadata.is_file() => Some(read_source(&path)?),
            Ok(_) => return Err("accessDenied"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if kind != EditKind::New {
                    return Err("notFound");
                }
                None
            }
            Err(_) => return Err("unavailable"),
        };
        let after = match before.as_deref() {
            None => frontmatter::body_with_id(input, &Ulid::generate().to_string())
                .map_err(|_| "invalidFrontmatter")?,
            Some(source) => edit_source(source, input, kind)?,
        };
        Ok(Self {
            relative,
            path,
            before,
            after,
        })
    }

    pub fn path(&self) -> &str {
        &self.relative
    }

    pub fn before(&self) -> Option<&str> {
        self.before.as_deref()
    }

    pub fn after(&self) -> &str {
        &self.after
    }

    pub fn changed(&self) -> bool {
        self.before() != Some(self.after())
    }

    pub fn commit(
        &self,
        root: &Path,
        scope: Option<&Path>,
        ai: bool,
    ) -> Result<Option<String>, &'static str> {
        let check_path = || {
            if edit_path(root, &self.relative, scope)? != self.path {
                return Err("revisionConflict");
            }
            Ok(())
        };
        let Some(before) = self.before() else {
            let _write_lock = paths::lock_text_write(root).map_err(|_| "unavailable")?;
            crate::structural::ensure_clean_for_text_edit(root)?;
            check_path()?;
            return atomic_fs::atomic_write_new(&self.path, &self.after)
                .map(|()| None)
                .map_err(|error| match error {
                    AtomicCreateError::AlreadyExists => "alreadyExists",
                    _ => "unavailable",
                });
        };
        let unchanged = || {
            check_path()?;
            if read_source(&self.path).as_deref() != Ok(before) {
                return Err("revisionConflict");
            }
            Ok(())
        };
        if !self.changed() {
            unchanged()?;
            return Ok(None);
        }
        let _write_lock = paths::lock_text_write(root).map_err(|_| "unavailable")?;
        crate::structural::ensure_clean_for_text_edit(root)?;
        unchanged()?;
        let reason = if ai {
            history::AI_EDIT_REASON
        } else {
            history::CLI_EDIT_REASON
        };
        let snapshot =
            history::snapshot_before_write(root, &self.path, self.after.as_bytes(), reason)
                .map_err(|_| "historyFailed")?
                .ok_or("revisionConflict")?;
        atomic_fs::atomic_write_bytes_checked(&self.path, self.after.as_bytes(), || {
            unchanged().map_err(str::to_owned)
        })
        .map_err(|error| match error.as_str() {
            "revisionConflict" => "revisionConflict",
            "accessDenied" => "accessDenied",
            _ => "unavailable",
        })?;
        Ok(Some(snapshot))
    }
}

fn read_source(path: &Path) -> Result<String, &'static str> {
    fs::read_to_string(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::InvalidData => "invalidEncoding",
        std::io::ErrorKind::NotFound => "notFound",
        _ => "unavailable",
    })
}

/// The same visible note boundary applies to preview and publication. The
/// parent must already exist, and MCP's scope is a component-wise prefix.
fn edit_path(root: &Path, relative: &str, scope: Option<&Path>) -> Result<PathBuf, &'static str> {
    let path = Path::new(relative);
    if !is_markdown(path) || !root.canonicalize().is_ok_and(|real| real == root) {
        return Err("accessDenied");
    }
    for component in path.components() {
        let Component::Normal(name) = component else {
            return Err("accessDenied");
        };
        let name = name.to_str().ok_or("accessDenied")?;
        if name.starts_with('.')
            || is_service_directory(&name.to_ascii_lowercase())
            || name.eq_ignore_ascii_case("metadata.md")
            || crate::bundle::validate_item_name("note", name) != Ok(name)
        {
            return Err("accessDenied");
        }
    }
    let target = paths::confine_rel_no_symlinks(root, relative).map_err(|_| "accessDenied")?;
    if scope.is_some_and(|folder| target == folder || !target.starts_with(folder)) {
        return Err("accessDenied");
    }
    if !target.parent().is_some_and(Path::is_dir) {
        return Err("notFound");
    }
    Ok(target)
}

/// Keep the original envelope and existing content. Normalize only the input
/// fragment to the existing body's text convention.
fn edit_source(source: &str, input: &str, kind: EditKind) -> Result<String, &'static str> {
    let without_bom = source.strip_prefix('\u{feff}').unwrap_or(source);
    let bom = &source[..source.len() - without_bom.len()];
    let (envelope, body) = match frontmatter::split_frontmatter_envelope(source) {
        Some(parts) => parts,
        None if frontmatter::parse_markdown(source).has_frontmatter => {
            return Err("invalidFrontmatter")
        }
        None => (bom, without_bom),
    };
    if kind == EditKind::Write && input == body {
        return Ok(source.to_owned());
    }
    let template = if body.contains('\n') {
        body
    } else {
        &envelope[bom.len()..]
    };
    let input =
        frontmatter::text_bytes_from_template(template, input).map_err(|_| "invalidEncoding")?;
    let input = std::str::from_utf8(&input).map_err(|_| "invalidEncoding")?;
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    if kind == EditKind::Append && input.is_empty() {
        return Ok(source.to_owned());
    }
    // Appending after a final line without a terminator begins a new line.
    // This also covers a valid frontmatter closing fence at EOF.
    let prefix = if kind == EditKind::Append {
        source
    } else {
        envelope
    };
    let separator = if !input.is_empty()
        && prefix.len() > bom.len()
        && !prefix.ends_with('\n')
        && (kind == EditKind::Append || body.is_empty())
    {
        if frontmatter::text_bytes_from_template(template, "\n")
            .is_ok_and(|eol| eol.ends_with(b"\r\n"))
        {
            "\r\n"
        } else {
            "\n"
        }
    } else {
        ""
    };
    if kind == EditKind::Write && frontmatter::parse_markdown(input).has_frontmatter {
        return Err("invalidFrontmatter");
    }
    let next = format!("{prefix}{separator}{input}");
    if envelope == bom && frontmatter::parse_markdown(&next).has_frontmatter {
        return Err("invalidFrontmatter");
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prepared_edit_cannot_replace_a_newer_version() {
        let root = std::env::temp_dir().join(format!("amby-edit-{}", Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let path = root.join("Note.md");
        fs::write(&path, "original").unwrap();
        let first = Edit::prepare(&root, "Note.md", None, EditKind::Append, "first").unwrap();
        let second = Edit::prepare(&root, "Note.md", None, EditKind::Append, "second").unwrap();
        first.commit(&root, None, false).unwrap();
        assert_eq!(second.commit(&root, None, false), Err("revisionConflict"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "original\nfirst");
        assert_eq!(history::list_snapshots(&root, &path).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_unavailable_history_leaves_original_bytes() {
        let root = std::env::temp_dir().join(format!("amby-edit-{}", Ulid::generate()));
        fs::create_dir_all(root.join(".amby")).unwrap();
        let root = root.canonicalize().unwrap();
        fs::write(root.join(".amby/history"), "not a directory").unwrap();
        let path = root.join("Note.md");
        fs::write(&path, "old source").unwrap();
        let edit = Edit::prepare(&root, "Note.md", None, EditKind::Write, "new source").unwrap();
        assert_eq!(edit.commit(&root, None, true), Err("historyFailed"));
        assert_eq!(fs::read_to_string(path).unwrap(), "old source");
        fs::remove_dir_all(root).unwrap();
    }
}
