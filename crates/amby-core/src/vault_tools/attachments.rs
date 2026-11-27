//! Attachments of notes for the CLI and MCP (docs/cli.md, docs/mcp.md): the local files a
//! note links or embeds, and new attachments copied into the note's assets folder under a
//! random name, as the editor imports them (docs/vault-format.md, «Attachments»).

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::atomic_fs::{atomic_copy_file_new, atomic_write_bytes_new, AtomicCreateError};
use crate::bundle::{
    assets_dir_for, build_imported_asset, random_asset_name, MAX_ATTACHMENT_FILE_SIZE,
    MAX_PASTED_BYTES,
};
use crate::index::protected_markdown_ranges;
use crate::vault::scan::normalize_rel_path;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// Vault-relative path; for a missing file, where the link points.
    pub path: String,
    /// `image`, `pdf`, `audio`, `video` or `file`.
    pub kind: String,
    pub exists: bool,
    pub size: Option<u64>,
    /// How the note first refers to it.
    pub reference: String,
}

/// The kind of a file by its extension, as attachment names are prefixed.
pub fn kind_of(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif" | "bmp" => "image",
        "pdf" => "pdf",
        "mp3" | "wav" | "ogg" | "m4a" | "flac" | "opus" | "aac" => "audio",
        "mp4" | "webm" | "mov" | "mkv" => "video",
        _ => "file",
    }
}

/// The MIME type sent with attachment contents.
pub fn mime_of(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

fn is_note(path: &str) -> bool {
    Path::new(path)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
}

/// A target that names a local file: no URL scheme, no anchor-only link, an extension that is
/// not a note's.
fn local_file(target: &str) -> bool {
    let target = target.trim();
    if target.is_empty() || target.starts_with('#') || target.starts_with('/') {
        return false;
    }
    let scheme = target.split_once(':').is_some_and(|(scheme, _)| {
        !scheme.is_empty()
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    !scheme && Path::new(target).extension().is_some() && !is_note(target)
}

fn percent_decode(text: &str) -> String {
    let hex = |byte: u8| (byte as char).to_digit(16);
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' && at + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[at + 1]), hex(bytes[at + 2])) {
                out.push((high * 16 + low) as u8);
                at += 3;
                continue;
            }
        }
        out.push(bytes[at]);
        at += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_owned())
}

/// Markdown link and image targets, `[..](target)` and `![..](target)`, outside code.
fn markdown_targets(content: &str) -> Vec<String> {
    let protected = protected_markdown_ranges(content);
    let mut targets = Vec::new();
    let mut cursor = 0;
    while let Some(found) = content[cursor..].find("](") {
        let open = cursor + found + 2;
        cursor = open;
        if protected
            .iter()
            .any(|(from, to)| open >= *from && open < *to)
        {
            continue;
        }
        let rest = &content[open..];
        let target = if let Some(inner) = rest.strip_prefix('<') {
            match inner.find('>') {
                Some(end) => &inner[..end],
                None => continue,
            }
        } else {
            let end = rest
                .find(|c: char| c == ')' || c.is_whitespace())
                .unwrap_or(rest.len());
            &rest[..end]
        };
        if !target.contains('\n') {
            targets.push(percent_decode(target));
        }
    }
    targets
}

/// Wiki embeds and links to files, `![[file.png]]` and `[[file.pdf|label]]`.
fn wiki_targets(content: &str) -> Vec<String> {
    crate::index::extract_links(content)
        .into_iter()
        .map(|(raw, _, _)| {
            let target = raw.split('|').next().unwrap_or(&raw);
            target.split('#').next().unwrap_or(target).trim().to_owned()
        })
        .collect()
}

/// `base` joined with a relative path, or `None` when it would leave the vault or enter a
/// hidden or service folder.
fn join_inside(root: &Path, base: &Path, target: &str) -> Option<PathBuf> {
    let mut path = base.to_path_buf();
    for component in Path::new(target).components() {
        match component {
            Component::Normal(name) => {
                let name = name.to_str()?;
                // `assets/` is where attachments live; only hidden folders are Amby's.
                if name.starts_with('.') {
                    return None;
                }
                path.push(name);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !path.pop() || !path.starts_with(root) {
                    return None;
                }
            }
            _ => return None,
        }
    }
    path.starts_with(root).then_some(path)
}

/// Visible non-note files of the vault by lowercase file name, for wiki embeds by name.
pub(crate) fn files_by_name(root: &Path) -> BTreeMap<String, Vec<PathBuf>> {
    let mut names = BTreeMap::<String, Vec<PathBuf>>::new();
    let walker = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| !name.starts_with('.'))
        });
    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if is_note(&name) {
            continue;
        }
        names.entry(name).or_default().push(entry.into_path());
    }
    names
}

fn relative(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root).ok().map(normalize_rel_path)
}

/// A visible file at a vault-relative path for attachment reads: no hidden component, no
/// symbolic link, inside the vault. Unlike notes, `assets/` folders are visible.
pub fn visible_attachment(root: &Path, relative: &str) -> Result<PathBuf, &'static str> {
    if relative.is_empty() || Path::new(relative).is_absolute() {
        return Err("accessDenied");
    }
    for component in Path::new(relative).components() {
        let Component::Normal(name) = component else {
            return Err("accessDenied");
        };
        if name.to_str().is_none_or(|name| name.starts_with('.')) {
            return Err("accessDenied");
        }
    }
    let path = crate::paths::confine_rel_no_symlinks(root, relative).map_err(|_| "accessDenied")?;
    if !path.is_file() {
        return Err("notFound");
    }
    Ok(path)
}

/// The attachments of a note, in the order the note first names them: Markdown links and
/// images to local files (missing ones too), and wiki embeds of files that exist.
pub fn list(root: &Path, note: &Path, content: &str) -> Vec<Attachment> {
    let base = note.parent().unwrap_or(root);
    let mut by_name = None;
    let mut seen = Vec::<String>::new();
    let mut found = Vec::new();
    let mut add = |path: PathBuf, reference: &str, found: &mut Vec<Attachment>| {
        let Some(relative) = relative(root, &path) else {
            return;
        };
        if seen.contains(&relative) {
            return;
        }
        seen.push(relative.clone());
        let metadata = std::fs::symlink_metadata(&path)
            .ok()
            .filter(|meta| meta.is_file());
        found.push(Attachment {
            kind: kind_of(&relative).to_owned(),
            exists: metadata.is_some(),
            size: metadata.map(|meta| meta.len()),
            path: relative,
            reference: reference.to_owned(),
        });
    };
    for target in markdown_targets(content) {
        if !local_file(&target) {
            continue;
        }
        let beside = join_inside(root, base, &target);
        let from_root = join_inside(root, root, &target);
        let chosen = match (beside, from_root) {
            (Some(beside), _) if beside.is_file() => Some(beside),
            (_, Some(from_root)) if from_root.is_file() => Some(from_root),
            (beside, from_root) => beside.or(from_root),
        };
        if let Some(path) = chosen {
            add(path, &target, &mut found);
        }
    }
    for target in wiki_targets(content) {
        if !local_file(&target) {
            continue;
        }
        let direct = join_inside(root, root, &target)
            .filter(|path| path.is_file())
            .or_else(|| join_inside(root, base, &target).filter(|path| path.is_file()));
        let path = direct.or_else(|| {
            let name = Path::new(&target)
                .file_name()?
                .to_string_lossy()
                .to_lowercase();
            let names = by_name.get_or_insert_with(|| files_by_name(root));
            names.get(&name).and_then(|paths| paths.first().cloned())
        });
        // A wiki link to a file that does not exist is an unresolved link, not an attachment.
        if let Some(path) = path {
            add(path, &target, &mut found);
        }
    }
    found
}

/// Where a new attachment goes and how the note links to it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    /// Vault-relative path of the new file.
    pub path: String,
    /// The path as the note's link writes it.
    pub link_target: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
}

pub enum Source<'a> {
    File(&'a Path),
    Bytes(&'a [u8]),
}

/// Copies a new attachment next to the note under a random name; it never replaces a file.
pub fn import(
    root: &Path,
    note: &Path,
    name: &str,
    source: Source<'_>,
) -> Result<Imported, &'static str> {
    let name = name.trim();
    if name.is_empty() || name.len() > 255 || name.contains(['/', '\\', '\n', '\r']) {
        return Err("invalidArguments");
    }
    let ext = Path::new(name)
        .extension()
        .map(|ext| ext.to_string_lossy().into_owned())
        .unwrap_or_default();
    let size = match source {
        Source::File(path) => {
            let meta = std::fs::metadata(path).map_err(|_| "notFound")?;
            if !meta.is_file() {
                return Err("notFound");
            }
            if meta.len() > MAX_ATTACHMENT_FILE_SIZE {
                return Err("attachmentTooLarge");
            }
            meta.len()
        }
        Source::Bytes(bytes) => {
            if bytes.len() > MAX_PASTED_BYTES {
                return Err("attachmentTooLarge");
            }
            bytes.len() as u64
        }
    };
    let dir = assets_dir_for(root, note);
    let dir = crate::paths::confine(root, &dir).map_err(|_| "accessDenied")?;
    for _ in 0..1_000 {
        let destination = dir.join(random_asset_name(&ext));
        let written = match source {
            Source::File(path) => {
                atomic_copy_file_new(path, &destination, MAX_ATTACHMENT_FILE_SIZE).map(|_| ())
            }
            Source::Bytes(bytes) => atomic_write_bytes_new(&destination, bytes),
        };
        match written {
            Ok(()) => {
                let asset = build_imported_asset(root, note, destination.clone(), name.to_owned());
                return Ok(Imported {
                    path: relative(root, &destination).ok_or("accessDenied")?,
                    link_target: asset.rel_path,
                    name: name.to_owned(),
                    kind: kind_of(&asset.abs_path).to_owned(),
                    size,
                });
            }
            Err(AtomicCreateError::AlreadyExists) => continue,
            Err(AtomicCreateError::Other(_)) => return Err("unavailable"),
        }
    }
    Err("unavailable")
}

/// The Markdown that links an imported attachment: an image is embedded.
pub fn link_markdown(imported: &Imported) -> String {
    let label: String = imported
        .name
        .chars()
        .map(|c| if matches!(c, '[' | ']') { '_' } else { c })
        .collect();
    let target = if imported.link_target.contains([' ', '(', ')']) {
        format!("<{}>", imported.link_target)
    } else {
        imported.link_target.clone()
    };
    let bang = if imported.kind == "image" { "!" } else { "" };
    format!("{bang}[{label}]({target})\n")
}
