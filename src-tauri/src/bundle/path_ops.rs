use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static CASE_RENAME_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub(crate) fn file_stem(path: &Path) -> Result<String, String> {
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
    if source_real == target_real {
        return Ok(true);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let source_metadata = fs::metadata(source).map_err(|error| error.to_string())?;
        let target_metadata = fs::metadata(target).map_err(|error| error.to_string())?;
        Ok(source_metadata.dev() == target_metadata.dev()
            && source_metadata.ino() == target_metadata.ino())
    }

    #[cfg(not(unix))]
    Ok(false)
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
    let same_entry = ensure_rename_target_available(source, target)?;
    if source == target {
        return Ok(());
    }
    if !same_entry {
        return fs::rename(source, target).map_err(|error| error.to_string());
    }

    let temporary = rename_temp_sibling(source)?;
    fs::rename(source, &temporary).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temporary, target) {
        return match fs::rename(&temporary, source) {
            Ok(()) => Err(error.to_string()),
            Err(rollback_error) => Err(format!(
                "Case-only rename failed: {error}; rollback failed: {rollback_error}"
            )),
        };
    }
    Ok(())
}
