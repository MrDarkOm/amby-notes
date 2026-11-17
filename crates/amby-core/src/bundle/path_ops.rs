use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static CASE_RENAME_COUNTER: AtomicU64 = AtomicU64::new(0);

/// The name a person typed for a new or renamed item, trimmed, or an
/// `Invalid <label> name: ...` error (classified as `invalidPath`).
///
/// A vault is shared with other systems, so the rules are the strictest of
/// Windows, macOS and Linux: no path separators, control or bidirectional
/// override characters, none of `: < > " | ? *`, no trailing dot, no
/// Windows device names (`CON`, `NUL.txt`, `COM1`...), no names made only of
/// dots, none of the service directories Amby and its neighbours own
/// (`.git`, `.amby`, `.obsidian`, `.trash`), and at most [`MAX_ITEM_NAME_BYTES`]
/// bytes so the extension and sidecar suffixes still fit in 255.
pub fn validate_item_name<'a>(label: &str, name: &'a str) -> Result<&'a str, String> {
    let trimmed = name.trim();
    let reason = item_name_problem(trimmed);
    match reason {
        Some(reason) => Err(format!("Invalid {label} name: {reason}")),
        None => Ok(trimmed),
    }
}

/// Longest accepted item name, in bytes.
const MAX_ITEM_NAME_BYTES: usize = 200;

fn item_name_problem(name: &str) -> Option<&'static str> {
    if name.is_empty() {
        return Some("empty");
    }
    if name.len() > MAX_ITEM_NAME_BYTES {
        return Some("too long");
    }
    if name.chars().any(|c| {
        c.is_control()
            || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
            || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    }) {
        return Some("forbidden character");
    }
    if name.chars().all(|c| c == '.') || name.ends_with('.') {
        return Some("dots");
    }
    let lower = name.to_lowercase();
    if matches!(
        lower.as_str(),
        ".git" | ".amby" | ".obsidian" | ".trash" | ".ds_store"
    ) {
        return Some("reserved name");
    }
    let stem = lower.split('.').next().unwrap_or("");
    let device = matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if device {
        return Some("reserved name");
    }
    None
}

pub fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub fn file_stem(path: &Path) -> Result<String, String> {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Invalid note path: {}", path_string(path)))
}

pub(super) fn file_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Invalid path: {}", path_string(path)))
}

/// True only when both spellings resolve to the same existing filesystem entry.
/// On case-sensitive filesystems differently cased names can be distinct user
/// files, so equality is determined by canonical paths (and Unix inode/device
/// identity as a fallback), never by case-folding strings alone.
pub(super) fn same_filesystem_entry(source: &Path, target: &Path) -> Result<bool, String> {
    if source == target {
        return Ok(true);
    }
    let source_real = source.canonicalize().map_err(|error| error.to_string())?;
    let target_real = match target.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    let same_path = source_real == target_real;

    #[cfg(unix)]
    {
        if same_path {
            return Ok(true);
        }
        use std::os::unix::fs::MetadataExt;
        let source_metadata = fs::metadata(source).map_err(|error| error.to_string())?;
        let target_metadata = fs::metadata(target).map_err(|error| error.to_string())?;
        Ok(source_metadata.dev() == target_metadata.dev()
            && source_metadata.ino() == target_metadata.ino())
    }

    #[cfg(not(unix))]
    Ok(same_path)
}

fn rename_temp_sibling(source: &Path) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| format!("Path has no parent: {}", path_string(source)))?;
    let name = source
        .file_name()
        .ok_or_else(|| format!("Path has no name: {}", path_string(source)))?
        .to_string_lossy();
    for _ in 0..128 {
        let counter = CASE_RENAME_COUNTER.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".{name}.amby-case-rename-{}-{counter}",
            std::process::id()
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Could not reserve a temporary rename path beside {}",
        path_string(source)
    ))
}

pub(super) fn ensure_rename_target_available(source: &Path, target: &Path) -> Result<bool, String> {
    let same_entry = same_filesystem_entry(source, target)?;
    if target.exists() && !same_entry {
        return Err(format!("Target already exists: {}", path_string(target)));
    }
    Ok(same_entry)
}

/// Rename without overwriting a distinct target. Case-only renames go through
/// a unique sibling so macOS and Windows do not collapse the operation into a
/// no-op. A failed second rename restores the original spelling.
pub(super) fn rename_path_case_safe(source: &Path, target: &Path) -> Result<(), String> {
    rename_path_case_safe_after_check(source, target, || {})
}

/// Plain rename that the kernel refuses when `target` exists, so a file that
/// appears after the availability check is never replaced (CORE-12).
fn rename_refusing_to_replace(source: &Path, target: &Path) -> Result<(), String> {
    crate::atomic_fs::rename_no_replace(source, target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            format!("Target already exists: {}", path_string(target))
        } else {
            error.to_string()
        }
    })
}

/// [`rename_path_case_safe`] with a seam: `between_check_and_rename` runs after
/// the "is the target free" check and before the rename, which is the window a
/// concurrent writer can use.
pub(super) fn rename_path_case_safe_after_check(
    source: &Path,
    target: &Path,
    between_check_and_rename: impl FnOnce(),
) -> Result<(), String> {
    let same_entry = ensure_rename_target_available(source, target)?;
    if source == target {
        return Ok(());
    }
    between_check_and_rename();
    if !same_entry {
        return rename_refusing_to_replace(source, target);
    }

    let temporary = rename_temp_sibling(source)?;
    fs::rename(source, &temporary).map_err(|error| error.to_string())?;
    if let Err(error) = rename_refusing_to_replace(&temporary, target) {
        return match fs::rename(&temporary, source) {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(format!(
                "Case-only rename failed: {error}; rollback failed: {rollback_error}"
            )),
        };
    }
    Ok(())
}
