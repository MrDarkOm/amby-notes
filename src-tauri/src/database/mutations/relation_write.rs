use std::fs;
use std::path::{Path, PathBuf};

use crate::frontmatter::{self};

use super::*;

pub(in crate::database) struct RelationPlannedWrite {
    pub(in crate::database) path: PathBuf,
    pub(in crate::database) post_bytes: Vec<u8>,
    pub(in crate::database) pre_bytes: Vec<u8>,
    pub(in crate::database) affected_note: DatabaseAffectedNote,
}

#[cfg(test)]
pub(in crate::database) type RelationBeforePublishHook = Box<dyn FnOnce()>;
#[cfg(test)]
pub(in crate::database) type RelationBeforeWriteHook = Box<dyn FnMut(usize)>;

#[cfg(test)]
thread_local! {
    pub(super) static RELATION_BEFORE_PUBLISH_HOOK: std::cell::RefCell<Option<RelationBeforePublishHook>> = const { std::cell::RefCell::new(None) };
    pub(super) static RELATION_BEFORE_WRITE_HOOK: std::cell::RefCell<Option<RelationBeforeWriteHook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(in crate::database) fn set_relation_before_publish_hook(hook: RelationBeforePublishHook) {
    RELATION_BEFORE_PUBLISH_HOOK.with(|pending| *pending.borrow_mut() = Some(hook));
}

#[cfg(test)]
pub(in crate::database) fn set_relation_before_write_hook(hook: RelationBeforeWriteHook) {
    RELATION_BEFORE_WRITE_HOOK.with(|pending| *pending.borrow_mut() = Some(hook));
}

pub(in crate::database) fn check_relation_file_revision(
    vault: &Path,
    path: &Path,
    expected: &[u8],
    kind: &str,
) -> Result<(), String> {
    if crate::paths::confine(vault, path)? != path {
        return Err(format!("Relation {kind} path changed before publication"));
    }
    let current =
        fs::read(path).map_err(|error| format!("Relation {kind} revision conflict: {error}"))?;
    if current != expected {
        return Err(format!("Relation {kind} revision conflict"));
    }
    Ok(())
}

pub(in crate::database) fn check_relation_manifest_revisions(
    vault: &Path,
    manifests: &[(PathBuf, Vec<u8>)],
) -> Result<(), String> {
    for (path, bytes) in manifests {
        check_relation_file_revision(vault, path, bytes, "manifest")?;
    }
    Ok(())
}

pub(in crate::database) fn rollback_relation_writes(
    vault: &Path,
    written: &[&RelationPlannedWrite],
) -> Vec<String> {
    let mut errors = Vec::new();
    for planned in written.iter().rev() {
        let result = (|| {
            if crate::paths::confine(vault, &planned.path)? != planned.path {
                return Err("path changed; rollback refused".to_owned());
            }
            let current = fs::read(&planned.path).map_err(|error| error.to_string())?;
            if current == planned.pre_bytes {
                return Ok(());
            }
            if current != planned.post_bytes {
                return Err("file changed externally; rollback refused".to_owned());
            }
            frontmatter::atomic_write_bytes(&planned.path, &planned.pre_bytes)
        })();
        if let Err(error) = result {
            errors.push(format!("{}: {error}", planned.affected_note.note_id));
        }
    }
    errors
}
