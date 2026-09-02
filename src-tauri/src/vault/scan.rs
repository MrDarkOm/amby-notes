pub use crate::frontmatter::is_amby_id;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::DirEntry;

pub struct ScannedNote {
    pub frontmatter_status: crate::model::FrontmatterStatus,
    pub path: PathBuf,
    pub rel_path: String,
    pub parsed_id: Option<String>,
    pub identity_error: Option<String>,
    pub body: String,
    pub frontmatter_tags: Vec<String>,
    pub mtime: i64,
    pub mtime_ns: Option<i64>,
    pub size: i64,
    /// Set when the file's precise mtime+size match the index, so its body was not read
    /// and the existing row can be kept as-is.
    pub unchanged: bool,
}

pub fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub fn normalize_rel_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub fn abs_from_rel(vault: &Path, rel_path: &str) -> PathBuf {
    rel_path
        .split('/')
        .filter(|p| !p.is_empty())
        .fold(vault.to_path_buf(), |acc, part| acc.join(part))
}

pub fn is_markdown(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "md")
}

pub fn is_canvas(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "canvas")
}

pub fn file_stem(path: &Path) -> String {
    path.file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string()
}

pub fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string()
}

pub fn is_hidden(entry: &DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .map(|name| name.starts_with('.') && name != ".")
        .unwrap_or(false)
}

pub fn is_bundle_dir(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let name = file_name(dir);
    dir.join(format!("{name}.md")).is_file()
}

pub fn should_descend(entry: &DirEntry) -> bool {
    if is_hidden(entry) {
        return false;
    }
    let name = entry.file_name().to_string_lossy();
    !matches!(
        name.as_ref(),
        ".amby" | ".obsidian" | ".git" | ".trash" | "assets"
    )
}

pub struct FileStamp {
    /// Unix seconds retained for UI date compatibility.
    pub mtime: i64,
    /// Unknown or unrepresentable timestamps must never qualify for a cache hit.
    pub mtime_ns: Option<i64>,
    pub size: i64,
}

pub fn metadata_stamp(path: &Path) -> Result<FileStamp, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok());
    Ok(FileStamp {
        mtime: modified.map(|d| d.as_secs() as i64).unwrap_or(0),
        mtime_ns: modified.and_then(|d| i64::try_from(d.as_nanos()).ok()),
        size: meta.len() as i64,
    })
}

pub fn word_count(content: &str) -> usize {
    content
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            let hashes = trimmed.bytes().take_while(|byte| *byte == b'#').count();
            if (1..=6).contains(&hashes) && trimmed.as_bytes().get(hashes) == Some(&b' ') {
                &trimmed[hashes + 1..]
            } else {
                line
            }
        })
        .flat_map(str::split_whitespace)
        .count()
}

pub fn title_for(path: &Path, body: &str) -> String {
    body.lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| file_stem(path))
}
