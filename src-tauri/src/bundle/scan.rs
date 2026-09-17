use std::path::Path;

use super::path_ops::file_stem;

pub(super) fn is_markdown(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "md")
}

pub(super) fn is_canvas(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "canvas")
}

pub(super) fn is_sketch(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "excalidraw")
}

pub(super) fn is_database(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext == "json" || ext == "database")
}

pub(super) fn is_supported_document(path: &Path) -> bool {
    is_markdown(path) || is_canvas(path) || is_sketch(path) || is_database(path)
}

pub(super) fn is_bundle_main_path(path: &Path) -> bool {
    if !is_supported_document(path) {
        return false;
    }
    if crate::database::discovery::is_manifest_file_candidate(path) {
        return true;
    }
    let Ok(stem) = file_stem(path) else {
        return false;
    };
    path.parent()
        .and_then(|parent| parent.file_name())
        .map(|name| name.to_string_lossy() == stem)
        .unwrap_or(false)
}

pub(crate) fn is_bundle_main_note(path: &Path) -> bool {
    path.is_file() && is_bundle_main_path(path)
}
