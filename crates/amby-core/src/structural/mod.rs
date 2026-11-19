//! Journaled structural operations for the CLI. The desktop and CLI hold the same
//! process lease. Repairs use a versioned journal shared by both entry points.

mod journal;
mod plan;

use std::fs::{File, TryLockError};
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy)]
pub enum Operation<'a> {
    Rename { path: &'a str, name: &'a str },
    Move { path: &'a str, folder: &'a str },
    Archive { path: &'a str },
    Restore { path: &'a str },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub source: String,
    pub destination: String,
    pub rewritten_paths: Vec<String>,
    pub dry_run: bool,
}

pub fn try_lease(root: &Path) -> Result<File, &'static str> {
    let file =
        crate::paths::open_vault_lock(root, ".amby/operation.lock").map_err(|_| "unavailable")?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err("vaultBusy"),
        Err(TryLockError::Error(_)) => Err("unavailable"),
    }
}

/// Used by desktop activation while holding the vault's process lease.
pub fn recover_desktop(root: &Path) -> Result<bool, String> {
    let resume = || {
        if !journal::present(root)? {
            return Ok(false);
        }
        let _text = crate::paths::lock_text_write(root)?;
        journal::recover(root)
    };
    resume().map_err(|error: String| format!("vaultRecoveryRequired: {error}"))
}

pub fn ensure_clean_for_text_edit(root: &Path) -> Result<(), &'static str> {
    let root = root.canonicalize().map_err(|_| "recoveryRequired")?;
    match journal::present(&root) {
        Ok(false) => Ok(()),
        Ok(true) | Err(_) => Err("recoveryRequired"),
    }
}

pub fn recover(root: &Path) -> Result<bool, &'static str> {
    let _lease = try_lease(root)?;
    let pending = journal::present(root).map_err(|_| "recoveryRequired")?;
    crate::vault_context::recover_before_load(root).map_err(|_| "recoveryRequired")?;
    Ok(pending)
}

pub fn archive_list(root: &Path) -> Result<Vec<crate::archive::ArchiveEntry>, &'static str> {
    crate::paths::confine_rel_no_symlinks(root, ".amby/archive/.meta")
        .map_err(|_| "accessDenied")?;
    Ok(crate::archive::list(root))
}

pub fn execute(
    root: &Path,
    operation: Operation<'_>,
    dry_run: bool,
) -> Result<Outcome, &'static str> {
    if dry_run {
        ensure_clean_for_text_edit(root)?;
        let (mut outcome, _) = plan::prepare(root, operation)?;
        outcome.dry_run = true;
        return Ok(outcome);
    }
    let _lease = try_lease(root)?;
    // The shared activation recovery phase stops before assigning identities.
    crate::vault_context::recover_before_load(root).map_err(|_| "recoveryRequired")?;
    execute_active(root, operation, |_| {})
}

/// The desktop caller holds the process lease and its mutation gate. It
/// resolves any prior structural journal before invoking this operation.
pub fn execute_active(
    root: &Path,
    operation: Operation<'_>,
    before_publish: impl FnOnce(&[crate::model::PathChange]),
) -> Result<Outcome, &'static str> {
    execute_with_scope(root, operation, None, false, before_publish)
}

pub(crate) fn execute_granted(
    root: &Path,
    operation: Operation<'_>,
    scope: &Path,
    dry_run: bool,
    before_publish: impl FnOnce(&[crate::model::PathChange]),
) -> Result<Outcome, &'static str> {
    execute_with_scope(root, operation, Some(scope), dry_run, before_publish)
}

fn execute_with_scope(
    root: &Path,
    operation: Operation<'_>,
    scope: Option<&Path>,
    dry_run: bool,
    before_publish: impl FnOnce(&[crate::model::PathChange]),
) -> Result<Outcome, &'static str> {
    let _text = (!dry_run)
        .then(|| crate::paths::lock_text_write(root))
        .transpose()
        .map_err(|_| "unavailable")?;
    ensure_clean_for_text_edit(root)?;
    let (mut outcome, steps) = plan::prepare(root, operation)?;
    if let Some(scope) = scope {
        // Tool output includes the affected-path list. Keep it within the
        // response budget before publishing anything.
        if serde_json::to_vec(&outcome)
            .map_err(|_| "operationTooLarge")?
            .len()
            > 100 * 1024
        {
            return Err("operationTooLarge");
        }
        // The two roots cover every member moved with a folder or bundle.
        // Archive source/destination use the path at its logical vault location.
        let allowed = |path: &str| {
            let logical = path.strip_prefix(".amby/archive/").unwrap_or(path);
            root.join(logical).starts_with(scope)
        };
        if scope != root
            && (!allowed(&outcome.source)
                || !allowed(&outcome.destination)
                || outcome.rewritten_paths.iter().any(|path| !allowed(path)))
        {
            return Err("outsideWriteScope");
        }
    }
    outcome.dry_run = dry_run;
    if dry_run {
        return Ok(outcome);
    }
    if !steps.is_empty() {
        let moves = steps.iter().find_map(|step| match step {
            journal::Step::History { changes } => Some(
                changes
                    .iter()
                    .map(|(old, new)| crate::model::PathChange {
                        old_path: crate::bundle::path_string(&root.join(old)),
                        new_path: crate::bundle::path_string(&root.join(new)),
                    })
                    .collect::<Vec<_>>(),
            ),
            _ => None,
        });
        before_publish(moves.as_deref().unwrap_or_default());
        journal::start(root, steps)?;
    }
    Ok(outcome)
}
