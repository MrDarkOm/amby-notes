use std::path::{Path, PathBuf};

use crate::model::ImportedAsset;

use super::path_string;
use super::scan::is_bundle_main_note;

pub const MAX_ATTACHMENT_FILE_SIZE: u64 = 100 * 1024 * 1024; // 100 MB
pub const MAX_PASTED_BYTES: usize = 25 * 1024 * 1024; // 25 MB
pub const MAX_EXT_LEN: usize = 16;

pub(crate) const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"];

pub(crate) fn sanitize_ext(ext: &str) -> String {
    let trimmed = ext.trim_start_matches('.').trim().to_ascii_lowercase();
    if trimmed.is_empty() || trimmed.len() > MAX_EXT_LEN {
        return "bin".to_string();
    }
    if !trimmed.chars().all(|c| c.is_ascii_alphanumeric()) {
        return "bin".to_string();
    }
    trimmed
}

pub(crate) fn sniff_image_format(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.len() >= 3 && bytes.starts_with(b"\xFF\xD8\xFF") {
        Some("jpg")
    } else if bytes.len() >= 6 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        Some("gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.len() >= 2 && bytes.starts_with(b"BM") {
        Some("bmp")
    } else {
        None
    }
}

pub(crate) fn classify_ext(ext: &str) -> &'static str {
    let ext = ext.to_ascii_lowercase();
    if IMAGE_EXTS.iter().any(|e| *e == ext) {
        "image"
    } else {
        "file"
    }
}

pub(crate) fn assets_dir_for(vault: &Path, note: &Path) -> PathBuf {
    if is_bundle_main_note(note) {
        if let Some(parent) = note.parent() {
            return parent.join("assets");
        }
    }
    vault.join("assets")
}

pub(crate) fn random_asset_name(ext: &str) -> String {
    let ext = sanitize_ext(ext);
    let prefix = match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif" | "bmp" => "img",
        "pdf" => "pdf",
        "mp3" | "wav" | "ogg" | "m4a" | "flac" | "opus" | "aac" => "audio",
        "mp4" | "webm" | "mov" | "mkv" => "video",
        _ => "file",
    };
    format!("{prefix}_{}.{ext}", ulid::Ulid::generate())
}

fn relative_for_markdown(vault: &Path, note: &Path, asset_abs: &Path) -> String {
    // Prefer note-relative path (works for bundle assets like `assets/foo.png`).
    if let Some(note_dir) = note.parent() {
        if let Ok(rel) = asset_abs.strip_prefix(note_dir) {
            return path_string(rel).replace('\\', "/");
        }
    }
    if let Ok(rel) = asset_abs.strip_prefix(vault) {
        return path_string(rel).replace('\\', "/");
    }
    path_string(asset_abs)
}

pub(crate) fn build_imported_asset(
    vault: &Path,
    note: &Path,
    abs_path: PathBuf,
    file_name: String,
) -> ImportedAsset {
    let ext = abs_path
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let kind = classify_ext(&ext).to_string();
    let rel_path = relative_for_markdown(vault, note, &abs_path);
    ImportedAsset {
        rel_path,
        abs_path: path_string(&abs_path),
        file_name,
        kind,
    }
}
