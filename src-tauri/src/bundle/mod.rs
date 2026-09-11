//! Stable bundle-domain facade. Commands and sibling modules continue to use
//! `crate::bundle` while implementation ownership is split by responsibility.

mod assets;
mod execute;
mod layers;
mod notes;
mod path_ops;
mod planning;
mod rollback;
mod scan;

pub(crate) use assets::{
    assets_dir_for, build_imported_asset, now_millis, sanitize_ext, sniff_image_format,
    unique_name, IMAGE_EXTS, MAX_ATTACHMENT_FILE_SIZE, MAX_PASTED_BYTES,
};
pub(crate) use execute::{move_item_impl, rename_item_impl};
pub(crate) use layers::{
    attach_canvas_impl, create_canvas_impl, create_layer_impl, delete_layer_impl, unlink_layer_impl,
};
#[cfg(test)]
pub(crate) use notes::create_note_impl;
pub(crate) use notes::rollback_bundle_promotion;
pub(crate) use notes::{
    ensure_bundle_path, prepare_create_note_impl, resolve_item_root, CreateNotePlan,
};
pub(crate) use path_ops::{file_stem, path_string};
pub(crate) use planning::{preview_move_item, preview_rename_item};
pub(crate) use rollback::{rollback_move_item, rollback_rename_item};
pub(crate) use scan::is_bundle_main_note;

#[cfg(test)]
mod tests;
