use std::path::Path;

use super::path_ops::file_stem;

pub(super) fn is_markdown(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "md")
}

pub(super) fn is_bundle_main_path(path: &Path) -> bool {
    if !is_markdown(path) {
        return false;
    }
    let Ok(stem) = file_stem(path) else {
        return false;
    };
    path.parent()
        .and_then(|parent| parent.file_name())
        .map(|name| name.to_string_lossy() == stem)
        .unwrap_or(false)
}

pub(super) fn is_bundle_main_note(path: &Path) -> bool {
    path.is_file() && is_bundle_main_path(path)
}
