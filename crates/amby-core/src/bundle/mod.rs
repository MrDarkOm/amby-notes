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

pub use assets::{
    assets_dir_for, build_imported_asset, random_asset_name, sanitize_ext, sniff_image_format,
    IMAGE_EXTS, MAX_ATTACHMENT_FILE_SIZE, MAX_PASTED_BYTES,
};
pub(crate) use execute::render_manifest_name;
pub use execute::{move_item_impl, rename_item_impl};
pub use layers::{
    attach_canvas_impl, attach_sketch_impl, create_canvas_impl, create_layer_impl,
    create_sketch_impl, delete_layer_impl, unlink_layer_impl,
};
#[cfg(any(test, feature = "test-support"))]
pub use notes::create_note_impl;
pub(crate) use notes::rollback_bundle_promotion;
pub use notes::{
    ensure_bundle_path, prepare_create_note_impl, preview_ensure_bundle_path, resolve_item_root,
    CreateNotePlan,
};
pub(crate) use path_ops::ensure_rename_target_available;
pub use path_ops::{file_stem, path_string, validate_item_name};
pub use planning::{preview_move_item, preview_rename_item};
pub use rollback::{rollback_move_item, rollback_rename_item};
pub use scan::is_bundle_main_note;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod vault_root_tests;
