//! Forward-only recovery. Before each no-replace move or checked rewrite, the
//! journal names the exact pre- and post-state. The cursor advances separately.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use walkdir::WalkDir;

use crate::{atomic_fs, durable, history};

const RELATIVE: &str = ".amby/recovery/cli/structural.json";
const CURSOR: &str = ".amby/recovery/cli/cursor";
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const STAGING_PREFIX: &str = ".amby-tmp-cli-";

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum Step {
    Move {
        from: String,
        to: String,
        digest: String,
    },
    Rewrite {
        path: String,
        before: String,
        after: String,
        snapshot: String,
    },
    ArchiveRecord {
        path: String,
        before: Option<String>,
        after: Option<String>,
    },
    History {
        changes: Vec<(String, String)>,
    },
}

#[derive(Deserialize, Serialize)]
struct Journal {
    version: u32,
    steps: Vec<Step>,
}

fn path(root: &Path) -> Result<PathBuf, String> {
    durable::guarded_path(root, RELATIVE, "structural recovery")
}

pub(super) fn present(root: &Path) -> Result<bool, String> {
    present_path(&path(root)?)
}

fn present_path(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn packed(journal: &Journal) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(journal).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Structural journal exceeds its size limit".into());
    }
    Ok(bytes)
}

pub(super) fn start(root: &Path, steps: Vec<Step>) -> Result<(), &'static str> {
    let journal = Journal { version: 1, steps };
    let destination = path(root).map_err(|_| "accessDenied")?;
    validate(&journal).map_err(|_| "invalidArguments")?;
    let bytes = packed(&journal).map_err(|_| "operationTooLarge")?;
    let cursor = cursor_path(root).map_err(|_| "accessDenied")?;
    if present_path(&destination).map_err(|_| "unavailable")? {
        return Err("recoveryRequired");
    }
    // An unreferenced cursor may remain if the journal was removed just
    // before a process interruption. It must never apply to a new plan.
    remove_if_present(&cursor).map_err(|_| "unavailable")?;
    durable::create_new(&destination, &bytes, "structural journal").map_err(|_| "unavailable")?;
    sync_path_parents(root, &destination).map_err(|_| "recoveryRequired")?;
    complete(root, &destination, journal).map_err(|_| "recoveryRequired")
}

pub(super) fn recover(root: &Path) -> Result<bool, String> {
    let journal_path = path(root)?;
    if !present_path(&journal_path)? {
        return Ok(false);
    }
    if !fs::symlink_metadata(&journal_path)
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Structural journal is not a regular file".into());
    }
    let bytes = File::open(&journal_path)
        .and_then(|file| {
            let mut bytes = Vec::new();
            file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
            Ok(bytes)
        })
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Structural journal exceeds its size limit".into());
    }
    let journal: Journal =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid structural journal")?;
    validate(&journal)?;
    complete(root, &journal_path, journal)?;
    Ok(true)
}

fn cursor_path(root: &Path) -> Result<PathBuf, String> {
    durable::guarded_path(root, CURSOR, "structural recovery cursor")
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn read_cursor(path: &Path, total: usize) -> Result<usize, String> {
    if !present_path(path)? {
        return Ok(0);
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > 32 {
        return Err("Invalid structural recovery cursor".into());
    }
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    text.parse::<usize>()
        .ok()
        .filter(|next| *next <= total)
        .ok_or_else(|| "Invalid structural recovery cursor".into())
}

fn complete(root: &Path, journal_path: &Path, journal: Journal) -> Result<(), String> {
    let cursor_path = cursor_path(root)?;
    let next = read_cursor(&cursor_path, journal.steps.len())?;
    for (index, step) in journal.steps.iter().enumerate().skip(next) {
        apply(root, step)?;
        atomic_fs::atomic_write_bytes(&cursor_path, (index + 1).to_string().as_bytes())?;
    }
    fs::remove_file(journal_path).map_err(|error| error.to_string())?;
    durable::sync_directory(journal_path.parent().ok_or("Missing journal parent")?)?;
    remove_if_present(&cursor_path)
}

pub(super) fn visible(relative: &str) -> bool {
    durable::relative_components(relative, "vault").is_ok_and(|parts| {
        parts.iter().all(|name| {
            !name.starts_with('.')
                && !crate::vault::scan::is_service_directory(&name.to_ascii_lowercase())
        })
    })
}

pub(super) fn refactor_path(relative: &str) -> bool {
    visible(relative) || relative.strip_prefix(".amby/archive/").is_some_and(visible)
}

fn data_path(relative: &str) -> bool {
    refactor_path(relative)
        || relative.rsplit_once('/').map_or_else(
            || stage_name(relative),
            |(dir, name)| visible(dir) && stage_name(name),
        )
}

fn stage_name(name: &str) -> bool {
    name.strip_prefix(STAGING_PREFIX)
        .is_some_and(|suffix| suffix.parse::<ulid::Ulid>().is_ok())
}

fn record_path(path: &str) -> bool {
    path.strip_prefix(".amby/archive/.meta/")
        .and_then(|name| name.strip_suffix(".json"))
        .is_some_and(durable::valid_operation_id)
}

fn validate(journal: &Journal) -> Result<(), String> {
    if journal.version != 1 {
        return Err("Unsupported or invalid structural journal".into());
    }
    for step in &journal.steps {
        let valid = match step {
            Step::Move { from, to, digest } => {
                from != to && data_path(from) && data_path(to) && durable::valid_revision(digest)
            }
            Step::Rewrite {
                path,
                before,
                after,
                snapshot,
            } => {
                refactor_path(path)
                    && snapshot.parse::<ulid::Ulid>().is_ok()
                    && before != after
                    && (crate::vault::scan::is_markdown(Path::new(path))
                        || Path::new(path)
                            .extension()
                            .and_then(|ext| ext.to_str())
                            .is_some_and(|ext| {
                                matches!(ext, "canvas" | "excalidraw" | "json" | "database")
                            }))
            }
            Step::ArchiveRecord {
                path,
                before,
                after,
            } => record_path(path) && (before.is_some() != after.is_some()),
            Step::History { changes } => changes
                .iter()
                .all(|(old, new)| visible(old) && visible(new)),
        };
        if !valid {
            return Err("Unsafe structural journal step".into());
        }
    }
    Ok(())
}

fn guarded(root: &Path, relative: &str) -> Result<PathBuf, String> {
    durable::guarded_path(root, relative, "structural mutation")
}

fn sync_path_parents(root: &Path, path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing parent")?;
    for directory in parent
        .ancestors()
        .take_while(|ancestor| ancestor.starts_with(root))
    {
        durable::sync_directory(directory)?;
    }
    Ok(())
}

fn apply(root: &Path, step: &Step) -> Result<(), String> {
    match step {
        Step::Move { from, to, digest } => {
            let from = guarded(root, from)?;
            let to = guarded(root, to)?;
            match (exact_exists(&from)?, exact_exists(&to)?) {
                (true, false) if fingerprint(&from)? == *digest => {
                    let parent = to.parent().ok_or("Missing destination parent")?;
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                    atomic_fs::rename_no_replace_strict(&from, &to)
                        .map_err(|error| error.to_string())?;
                }
                (false, true) if fingerprint(&to)? == *digest => {}
                _ => return Err("Move paths changed during structural recovery".into()),
            }
            sync_path_parents(root, &to)?;
            durable::sync_directory(from.parent().ok_or("Missing source parent")?)
        }
        Step::Rewrite {
            path,
            before,
            after,
            snapshot,
        } => {
            let path = guarded(root, path)?;
            let current = read_text(&path)?;
            if current.as_deref() == Some(after) {
                return durable::sync_directory(path.parent().ok_or("Missing rewrite parent")?);
            }
            if current.as_deref() != Some(before) {
                return Err("Rewrite source changed during structural recovery".into());
            }
            let snapshot = snapshot
                .parse::<ulid::Ulid>()
                .map_err(|error| error.to_string())?;
            history::snapshot_before_structural_write(root, &path, after.as_bytes(), snapshot)?;
            atomic_fs::atomic_write_bytes_checked(&path, after.as_bytes(), || {
                if read_text(&path)?.as_deref() == Some(before) {
                    Ok(())
                } else {
                    Err("Rewrite source changed before publication".into())
                }
            })
        }
        Step::ArchiveRecord {
            path,
            before,
            after,
        } => {
            let path = guarded(root, path)?;
            let current = read_text(&path)?;
            if &current == after {
                return durable::sync_directory(
                    path.parent().ok_or("Missing archive record parent")?,
                );
            }
            if &current != before {
                return Err("Archive record changed during structural recovery".into());
            }
            if let Some(after) = after {
                durable::create_new(&path, after.as_bytes(), "archive record")
            } else {
                fs::remove_file(&path).map_err(|error| error.to_string())?;
                durable::sync_directory(path.parent().ok_or("Missing archive record parent")?)
            }
        }
        Step::History { changes } => {
            let changes = changes
                .iter()
                .map(|(old, new)| crate::model::PathChange {
                    old_path: crate::bundle::path_string(&root.join(old)),
                    new_path: crate::bundle::path_string(&root.join(new)),
                })
                .collect::<Vec<_>>();
            history::move_snapshot_sources(root, &changes).map(|_| ())
        }
    }
}

pub(super) fn read_text(path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => fs::read_to_string(path)
            .map(Some)
            .map_err(|e| e.to_string()),
        Ok(_) => Err("Expected a regular file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Distinguish the exact spellings of case-only moves on insensitive volumes.
fn exact_exists(path: &Path) -> Result<bool, String> {
    if !present_path(path)? {
        return Ok(false);
    }
    let parent = path.parent().ok_or("Missing parent")?;
    let expected = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid filename")?;
    for entry in fs::read_dir(parent).map_err(|error| error.to_string())? {
        let name = entry.map_err(|error| error.to_string())?.file_name();
        if name
            .to_str()
            .is_some_and(|name| name.nfc().eq(expected.nfc()))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn movement(
    root: &Path,
    observed: &Path,
    from: &Path,
    to: &Path,
    case_only: bool,
) -> Result<Vec<Step>, String> {
    movement_with_digest(root, from, to, case_only, fingerprint(observed)?)
}

pub(super) fn movement_with_digest(
    root: &Path,
    from: &Path,
    to: &Path,
    case_only: bool,
    digest: String,
) -> Result<Vec<Step>, String> {
    if from == to {
        return Ok(Vec::new());
    }
    let step = |from: &Path, to: &Path| {
        Ok::<_, String>(Step::Move {
            from: durable::relative_string(root, from, "source")?,
            to: durable::relative_string(root, to, "target")?,
            digest: digest.clone(),
        })
    };
    if case_only {
        let staging = from.with_file_name(format!("{STAGING_PREFIX}{}", ulid::Ulid::generate()));
        Ok(vec![step(from, &staging)?, step(&staging, to)?])
    } else {
        Ok(vec![step(from, to)?])
    }
}

/// Hash bytes and relative entry names without following symlinks. The root
/// entry has an empty relative name so a rename keeps its fingerprint.
pub(super) fn fingerprint(path: &Path) -> Result<String, String> {
    let mut digest = Sha256::new();
    for entry in WalkDir::new(path)
        .follow_links(false)
        .follow_root_links(false)
        .sort_by_file_name()
    {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.depth() > 0 && crate::self_write::is_amby_temporary_file(entry.path()) {
            return Err("The moved tree contains an unpublished write".into());
        }
        let relative = entry
            .path()
            .strip_prefix(path)
            .map_err(|error| error.to_string())?
            .to_str()
            .ok_or("Non-UTF-8 moved path")?;
        digest.update((relative.len() as u64).to_le_bytes());
        digest.update(relative.as_bytes());
        if entry.file_type().is_dir() {
            digest.update(b"d");
        } else if entry.file_type().is_file() {
            digest.update(b"f");
            let mut file = File::open(entry.path()).map_err(|error| error.to_string())?;
            let mut contents = FileDigest(Sha256::new());
            std::io::copy(&mut file, &mut contents).map_err(|error| error.to_string())?;
            digest.update(contents.0.finalize());
        } else {
            return Err("The moved tree contains a symbolic link or special file".into());
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

struct FileDigest(Sha256);

impl Write for FileDigest {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestVault(PathBuf);

    impl TestVault {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("amby-cli-{}", ulid::Ulid::generate()));
            fs::create_dir(&directory).unwrap();
            Self(directory.canonicalize().unwrap())
        }
    }

    impl Drop for TestVault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn interrupted(vault: &TestVault) -> Journal {
        let root = &vault.0;
        let source = root.join("Original.md");
        let dest = root.join("Renamed.md");
        fs::write(&source, "Body\r\n").unwrap();
        let mut steps = movement(root, &source, &source, &dest, false).unwrap();
        steps.push(Step::Rewrite {
            path: "Renamed.md".into(),
            before: "Body\r\n".into(),
            after: "Updated\r\n".into(),
            snapshot: ulid::Ulid::generate().to_string(),
        });
        let record = Journal { version: 1, steps };
        durable::create_new(
            &path(root).unwrap(),
            &packed(&record).unwrap(),
            "test journal",
        )
        .unwrap();
        apply(root, &record.steps[0]).unwrap();
        record
    }

    #[test]
    fn desktop_activation_replays_a_move_published_before_its_checkpoint() {
        let vault = TestVault::new();
        interrupted(&vault);
        assert_eq!(
            crate::recovery::sweep_expired_recovery(&vault.0).unwrap(),
            0
        );
        assert!(present(&vault.0).unwrap());
        let context = crate::vault_context::VaultContext::default();
        context.reserve_desktop(&vault.0).unwrap();
        crate::vault_context::recover_before_load(&vault.0).unwrap();

        assert!(!vault.0.join("Original.md").exists());
        assert_eq!(
            fs::read(vault.0.join("Renamed.md")).unwrap(),
            b"Updated\r\n"
        );
        assert!(!present(&vault.0).unwrap());
        assert!(!super::super::recover_desktop(&vault.0).unwrap());
    }

    #[test]
    fn index_refresh_does_not_assign_identities_during_pending_recovery() {
        let vault = TestVault::new();
        interrupted(&vault);
        let connection = crate::vault_index::open_connection(&vault.0).unwrap();
        let error = crate::vault_index::sync_vault(&connection, &vault.0).unwrap_err();
        assert_eq!(error, "recoveryRequired");
        assert_eq!(fs::read(vault.0.join("Renamed.md")).unwrap(), b"Body\r\n");
        assert!(recover(&vault.0).unwrap());
    }

    #[test]
    fn recovery_preserves_an_external_edit_and_keeps_the_journal() {
        let vault = TestVault::new();
        interrupted(&vault);
        let dest = vault.0.join("Renamed.md");
        fs::write(&dest, "External edit").unwrap();
        assert_eq!(super::super::recover(&vault.0), Err("recoveryRequired"));
        assert_eq!(fs::read_to_string(dest).unwrap(), "External edit");
        assert!(present(&vault.0).unwrap());

        use crate::note_edit::{Edit, EditKind};
        let edit = Edit::prepare(&vault.0, "Renamed.md", None, EditKind::Append, "More").unwrap();
        assert_eq!(edit.commit(&vault.0, None, false), Err("recoveryRequired"));
    }

    #[test]
    fn a_snapshot_published_before_the_rewrite_is_reused() {
        let vault = TestVault::new();
        let record = interrupted(&vault);
        let path = vault.0.join("Renamed.md");
        let Step::Rewrite {
            after, snapshot, ..
        } = &record.steps[1]
        else {
            panic!("expected a rewrite");
        };
        let id = snapshot.parse::<ulid::Ulid>().unwrap();
        history::snapshot_before_structural_write(&vault.0, &path, after.as_bytes(), id).unwrap();
        assert!(recover(&vault.0).unwrap());

        let entries = history::list_snapshots(&vault.0, &path).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, *snapshot);
    }

    #[test]
    fn recovery_rejects_unsafe_paths_before_applying_any_step() {
        let vault = TestVault::new();
        let mut record = interrupted(&vault);
        record.steps.push(Step::Rewrite {
            path: "../escaped.md".into(),
            before: "External".into(),
            after: "Overwritten".into(),
            snapshot: ulid::Ulid::generate().to_string(),
        });
        atomic_fs::atomic_write_bytes(&path(&vault.0).unwrap(), &packed(&record).unwrap()).unwrap();
        assert!(recover(&vault.0).unwrap_err().contains("Unsafe"));
        assert_eq!(fs::read(vault.0.join("Renamed.md")).unwrap(), b"Body\r\n");
    }
}
