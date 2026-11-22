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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct TestVault(PathBuf);

    impl TestVault {
        /// A vault with a bundle `Project/` (text, canvas and a child note) and a plain note.
        fn new(supernotes: bool) -> Self {
            let directory =
                std::env::temp_dir().join(format!("amby-bundle-ops-{}", ulid::Ulid::generate()));
            fs::create_dir_all(directory.join("Project")).unwrap();
            fs::create_dir_all(directory.join("Other")).unwrap();
            fs::create_dir_all(directory.join(".amby")).unwrap();
            fs::write(directory.join("Project/Project.md"), "# Project\n").unwrap();
            fs::write(directory.join("Project/Project.canvas"), "{}").unwrap();
            fs::write(directory.join("Project/Child.md"), "# Child\n").unwrap();
            fs::write(directory.join("Plain.md"), "# Plain\n").unwrap();
            let modules = if supernotes {
                r#"["amby.supernotes","amby.databases"]"#
            } else {
                r#"["amby.databases"]"#
            };
            fs::write(
                directory.join(".amby/workspace.json"),
                format!(
                    r#"{{"profile":{{"id":"custom","catalogRevision":"2026-11-21"}},"enabledModules":{modules}}}"#
                ),
            )
            .unwrap();
            Self(directory.canonicalize().unwrap())
        }
    }

    impl Drop for TestVault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn archiving_a_bundle_text_takes_the_whole_bundle_only_with_supernotes() {
        let on = TestVault::new(true);
        let outcome = execute(
            &on.0,
            Operation::Archive {
                path: "Project/Project.md",
            },
            true,
        )
        .unwrap();
        assert_eq!(outcome.source, "Project");

        let off = TestVault::new(false);
        let outcome = execute(
            &off.0,
            Operation::Archive {
                path: "Project/Project.md",
            },
            true,
        )
        .unwrap();
        assert_eq!(outcome.source, "Project/Project.md");
    }

    #[test]
    fn archiving_a_file_with_supernotes_off_leaves_the_rest_of_the_folder() {
        let off = TestVault::new(false);
        execute(
            &off.0,
            Operation::Archive {
                path: "Project/Project.md",
            },
            false,
        )
        .unwrap();
        assert!(!off.0.join("Project/Project.md").exists());
        assert!(off.0.join("Project/Project.canvas").exists());
        assert_eq!(
            fs::read_to_string(off.0.join("Project/Child.md")).unwrap(),
            "# Child\n"
        );
    }

    #[test]
    fn a_bundle_file_is_not_renamed_or_moved_alone_with_supernotes_off() {
        let off = TestVault::new(false);
        let rename = Operation::Rename {
            path: "Project/Project.md",
            name: "Renamed",
        };
        let relocate = Operation::Move {
            path: "Project/Project.md",
            folder: "Other",
        };
        assert_eq!(execute(&off.0, rename, true).err(), Some("moduleDisabled"));
        assert_eq!(
            execute(&off.0, relocate, true).err(),
            Some("moduleDisabled")
        );
        assert_eq!(execute(&off.0, rename, false).err(), Some("moduleDisabled"));
        assert!(off.0.join("Project/Project.md").is_file());

        let on = TestVault::new(true);
        assert!(execute(&on.0, rename, true).is_ok());
        assert!(execute(&on.0, relocate, true).is_ok());
    }

    #[test]
    fn the_folder_row_and_plain_notes_keep_working_with_supernotes_off() {
        let off = TestVault::new(false);
        let outcome = execute(
            &off.0,
            Operation::Rename {
                path: "Project",
                name: "Renamed",
            },
            true,
        )
        .unwrap();
        assert_eq!(outcome.destination, "Renamed");
        let outcome = execute(
            &off.0,
            Operation::Move {
                path: "Plain.md",
                folder: "Other",
            },
            true,
        )
        .unwrap();
        assert_eq!(outcome.destination, "Other/Plain.md");
        assert!(execute(
            &off.0,
            Operation::Rename {
                path: "Plain.md",
                name: "Fresh"
            },
            true
        )
        .is_ok());
    }
}
