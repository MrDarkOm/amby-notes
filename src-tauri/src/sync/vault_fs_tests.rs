//! The local file system of the engine over a real vault in a temporary folder (docs/sync-plan.md,
//! Р4, Р8, Р10, Д17, Д53, Д59). Each test names the rule it holds.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use amby_sync_core::engine::{FsError, LocalFs, LocalKind, RootState, SnapshotReason, TrashReason};

use super::vault_fs::{pending_journals, FsHooks, VaultFs};
use crate::{history, recycle_bin};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A vault in a temporary folder, removed when the test ends.
struct Vault {
    root: PathBuf,
}

impl Vault {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "amby-vaultfs-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        Self {
            root: root.canonicalize().unwrap(),
        }
    }

    fn fs(&self) -> VaultFs {
        VaultFs::new(self.root.clone())
    }

    fn put(&self, rel: &str, bytes: &[u8]) -> PathBuf {
        let path = self.root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }

    fn read(&self, rel: &str) -> Option<Vec<u8>> {
        fs::read(self.root.join(rel)).ok()
    }

    fn history_off(&self) {
        self.put(".amby/workspace.json", br#"{"history":{"enabled":false}}"#);
    }

    fn snapshots(&self, rel: &str) -> Vec<(String, String)> {
        history::list_snapshots(&self.root, &self.root.join(rel))
            .unwrap_or_default()
            .into_iter()
            .map(|entry| {
                let text = history::read_snapshot_text(&self.root, &entry.id)
                    .map(|snapshot| snapshot.content)
                    .unwrap_or_default();
                (entry.reason, text)
            })
            .collect()
    }

    fn temp_files(&self) -> Vec<String> {
        let mut found = Vec::new();
        for entry in walkdir::WalkDir::new(&self.root).into_iter().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.contains(".amby-tmp-") {
                found.push(name);
            }
        }
        found
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn write(fs: &mut VaultFs, path: &str, bytes: &[u8], snapshot: Option<SnapshotReason>) {
    let mut staged = fs.begin_write(path).unwrap();
    staged.write(bytes).unwrap();
    staged.publish(snapshot).unwrap();
}

// ----- the root and the listing -----

#[test]
fn the_root_is_present_or_missing() {
    // Р8, С8, Д55
    let vault = Vault::new();
    let mut fs = vault.fs();
    assert_eq!(fs.root_state().unwrap(), RootState::Present);
    fs::remove_dir_all(&vault.root).unwrap();
    assert_eq!(fs.root_state().unwrap(), RootState::Missing);
}

#[test]
fn the_listing_has_files_folders_sizes_and_times() {
    // Д12, Р10: path, kind, size and mtime_ns are the fast check
    let vault = Vault::new();
    vault.put("Notes/a.md", b"hello");
    vault.put("Notes/deep/b.bin", &[0u8; 300]);
    fs::create_dir_all(vault.root.join("Empty")).unwrap();
    let listing = vault.fs().list().unwrap();
    let find = |path: &str| {
        listing
            .entries
            .iter()
            .find(|entry| entry.path == path)
            .unwrap_or_else(|| panic!("{path} is not listed: {:?}", listing.entries))
    };
    assert_eq!(find("Notes/a.md").kind, LocalKind::File);
    assert_eq!(find("Notes/a.md").size, 5);
    assert!(find("Notes/a.md").mtime_ns > 1_000_000_000_000_000_000);
    assert_eq!(find("Notes/deep/b.bin").size, 300);
    assert_eq!(find("Notes").kind, LocalKind::Folder);
    assert_eq!(find("Notes/deep").kind, LocalKind::Folder);
    assert_eq!(find("Empty").kind, LocalKind::Folder);
    assert!(listing.not_utf8.is_empty());
    assert!(
        listing
            .entries
            .iter()
            .all(|entry| !entry.path.contains('\\')),
        "separators are /"
    );
}

#[test]
fn the_mtime_changes_when_the_file_changes() {
    // Д12: the fast check must notice an edit of the same size
    let vault = Vault::new();
    vault.put("a.md", b"aaaa");
    let first = vault.fs().list().unwrap().entries[0].mtime_ns;
    std::thread::sleep(std::time::Duration::from_millis(20));
    vault.put("a.md", b"bbbb");
    let second = vault.fs().list().unwrap().entries[0].mtime_ns;
    assert_ne!(first, second);
}

#[test]
fn service_folders_are_named_but_not_entered() {
    // Р4: .git, .obsidian, .trash and the private parts of .amby are never synchronised, so the
    // listing does not walk them; the documented .amby files are listed.
    let vault = Vault::new();
    vault.put("Notes/a.md", b"a");
    vault.put(".git/objects/aa/bb", b"x");
    vault.put(".obsidian/app.json", b"{}");
    vault.put(".trash/old.md", b"x");
    vault.put(".amby/history/manifest.json", b"{}");
    vault.put(".amby/recovery/draft.json", b"{}");
    vault.put(".amby/trash/01/a.md", b"x");
    vault.put(".amby/sync/state.db", b"x");
    vault.put(".amby/properties.json", b"{}");
    vault.put(".amby/blocks/n.json", b"{}");
    vault.put(".amby/graph-layout.json", b"{}");
    let listing = vault.fs().list().unwrap();
    let paths: Vec<&str> = listing.entries.iter().map(|e| e.path.as_str()).collect();
    for kept in [
        "Notes/a.md",
        ".amby/properties.json",
        ".amby/blocks",
        ".amby/blocks/n.json",
        ".amby/graph-layout.json",
        ".git",
        ".obsidian",
        ".trash",
        ".amby/history",
        ".amby/recovery",
        ".amby/trash",
        ".amby/sync",
    ] {
        assert!(paths.contains(&kept), "{kept} missing from {paths:?}");
    }
    for skipped in [
        ".git/objects",
        ".git/objects/aa/bb",
        ".obsidian/app.json",
        ".trash/old.md",
        ".amby/history/manifest.json",
        ".amby/recovery/draft.json",
        ".amby/trash/01/a.md",
        ".amby/sync/state.db",
    ] {
        assert!(!paths.contains(&skipped), "{skipped} was walked: {paths:?}");
    }
}

#[cfg(unix)]
#[test]
fn a_symbolic_link_is_a_link_and_is_not_followed() {
    // Р4: links are never synchronised, so they must be reported as links
    let vault = Vault::new();
    vault.put("real/inside.md", b"x");
    std::os::unix::fs::symlink(vault.root.join("real"), vault.root.join("link")).unwrap();
    std::os::unix::fs::symlink(
        vault.root.join("real/inside.md"),
        vault.root.join("file-link"),
    )
    .unwrap();
    let listing = vault.fs().list().unwrap();
    let kind = |path: &str| {
        listing
            .entries
            .iter()
            .find(|e| e.path == path)
            .map(|e| e.kind)
    };
    assert_eq!(kind("link"), Some(LocalKind::Symlink));
    assert_eq!(kind("file-link"), Some(LocalKind::Symlink));
    assert_eq!(
        kind("link/inside.md"),
        None,
        "a linked folder is not entered"
    );
}

#[cfg(unix)]
#[test]
fn a_name_that_is_not_utf8_is_reported_lossily() {
    // Р4, Д11
    use std::os::unix::ffi::OsStrExt;
    let vault = Vault::new();
    vault.put("ok.md", b"x");
    let odd = std::ffi::OsStr::from_bytes(b"odd-\xff\xfe.md");
    fs::write(vault.root.join(odd), b"x").unwrap();
    let listing = vault.fs().list().unwrap();
    assert_eq!(listing.not_utf8.len(), 1, "{:?}", listing.not_utf8);
    assert!(listing.not_utf8[0].starts_with("odd-"));
    assert!(listing
        .entries
        .iter()
        .all(|e| e.path != listing.not_utf8[0]));
    assert!(listing.entries.iter().any(|e| e.path == "ok.md"));
}

// ----- reading -----

#[test]
fn a_file_is_read_whole_and_a_missing_one_is_not_found() {
    let vault = Vault::new();
    vault.put("Notes/a.md", "тест\r\n".as_bytes());
    let mut fs = vault.fs();
    assert_eq!(fs.read("Notes/a.md").unwrap(), "тест\r\n".as_bytes());
    assert!(matches!(fs.read("nope.md"), Err(FsError::NotFound(_))));
}

#[cfg(unix)]
#[test]
fn a_file_the_system_refuses_is_access_denied_not_a_vague_error() {
    // Э4 (from Э3): one unreadable file stops only itself
    use std::os::unix::fs::PermissionsExt;
    let vault = Vault::new();
    let path = vault.put("locked.md", b"secret");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::File::open(&path).is_ok() {
        // Running as root: permissions do not apply, nothing to test.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        return;
    }
    let result = vault.fs().read("locked.md");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        matches!(result, Err(FsError::AccessDenied(_))),
        "{result:?}"
    );
}

// ----- writing -----

#[test]
fn a_write_is_atomic_through_a_temporary_file_next_to_the_target() {
    // С3, Р4, Ф24: nothing is visible at the target until the publish
    let vault = Vault::new();
    let mut fs = vault.fs();
    let mut staged = fs.begin_write("Notes/new/a.md").unwrap();
    staged.write(b"first ").unwrap();
    staged.write(b"second").unwrap();
    assert!(vault.read("Notes/new/a.md").is_none(), "not visible yet");
    let temps = vault.temp_files();
    assert_eq!(temps.len(), 1, "{temps:?}");
    assert!(temps[0].starts_with(".a.md.amby-tmp-"), "{temps:?}");
    staged.publish(None).unwrap();
    assert_eq!(vault.read("Notes/new/a.md").unwrap(), b"first second");
    assert!(vault.temp_files().is_empty(), "no temporary file is left");
}

#[test]
fn an_aborted_write_leaves_the_target_and_no_temporary_file() {
    // С3
    let vault = Vault::new();
    vault.put("a.md", b"old");
    let mut fs = vault.fs();
    let mut staged = fs.begin_write("a.md").unwrap();
    staged.write(b"half").unwrap();
    staged.abort();
    assert_eq!(vault.read("a.md").unwrap(), b"old");
    assert!(vault.temp_files().is_empty());
}

#[test]
fn replacing_a_file_makes_a_sync_overwrite_snapshot_first() {
    // Р8, Д53: the old content is kept in the history with the reason sync-overwrite
    let vault = Vault::new();
    vault.put("Notes/a.md", b"old content");
    let mut fs = vault.fs();
    write(
        &mut fs,
        "Notes/a.md",
        b"from the server",
        Some(SnapshotReason::SyncOverwrite),
    );
    assert_eq!(vault.read("Notes/a.md").unwrap(), b"from the server");
    assert_eq!(
        vault.snapshots("Notes/a.md"),
        vec![("sync-overwrite".to_string(), "old content".to_string())]
    );
}

#[test]
fn the_snapshot_is_made_even_when_the_history_is_switched_off() {
    // Р8: "even if the history is switched off", like note-rewrite
    let vault = Vault::new();
    vault.history_off();
    vault.put("a.md", b"precious");
    let mut fs = vault.fs();
    write(&mut fs, "a.md", b"new", Some(SnapshotReason::SyncOverwrite));
    assert_eq!(
        vault.snapshots("a.md"),
        vec![("sync-overwrite".to_string(), "precious".to_string())]
    );
}

#[test]
fn snapshots_of_overwrites_are_not_merged_with_each_other() {
    // Р8: "it is not merged with the snapshots of autosave"
    let vault = Vault::new();
    vault.put("a.md", b"v1");
    let mut fs = vault.fs();
    write(&mut fs, "a.md", b"v2", Some(SnapshotReason::SyncOverwrite));
    write(&mut fs, "a.md", b"v3", Some(SnapshotReason::SyncOverwrite));
    let mut kept: Vec<String> = vault.snapshots("a.md").into_iter().map(|s| s.1).collect();
    kept.sort();
    assert_eq!(kept, vec!["v1".to_string(), "v2".to_string()]);
}

#[test]
fn a_new_file_or_a_write_without_a_snapshot_makes_none() {
    let vault = Vault::new();
    let mut fs = vault.fs();
    write(&mut fs, "new.md", b"x", Some(SnapshotReason::SyncOverwrite));
    assert!(vault.snapshots("new.md").is_empty(), "nothing was replaced");
    write(&mut fs, "new.md", b"y", None);
    assert!(
        vault.snapshots("new.md").is_empty(),
        "the engine asked for none"
    );
}

#[test]
fn a_failed_snapshot_fails_the_write_and_keeps_the_old_file() {
    // Р8, Д53: "a failure of the snapshot fails the publish and leaves the old file"
    let vault = Vault::new();
    vault.put("a.md", b"old");
    // The history folder cannot be made: a plain file is in its place.
    vault.put(".amby/history", b"not a folder");
    let mut fs = vault.fs();
    let mut staged = fs.begin_write("a.md").unwrap();
    staged.write(b"new").unwrap();
    let result = staged.publish(Some(SnapshotReason::SyncOverwrite));
    assert!(result.is_err());
    assert_eq!(vault.read("a.md").unwrap(), b"old", "the old file stays");
    assert!(
        vault.temp_files().is_empty(),
        "the temporary file is cleaned up"
    );
}

#[test]
fn the_write_of_the_engine_is_seen_by_the_watcher_as_an_external_change() {
    // Р7: "if the note is open and unsaved, the write of synchronisation is an ordinary external
    // edit" — it must not be registered as a write of the application, so that the editor hears
    // about it and the usual conflict dialog works. Checked with the real watcher of the system.
    use crate::watcher::{queue_external_changes, WatcherState};
    use notify::Watcher;
    use std::collections::HashSet;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let vault = Vault::new();
    vault.put("Notes/open.md", b"what the editor loaded");
    let (sender, receiver) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = sender.send(event);
    })
    .unwrap();
    watcher
        .watch(&vault.root, notify::RecursiveMode::Recursive)
        .unwrap();
    std::thread::sleep(Duration::from_millis(300));

    let mut fs = vault.fs();
    write(
        &mut fs,
        "Notes/open.md",
        b"from another device",
        Some(SnapshotReason::SyncOverwrite),
    );

    let state = WatcherState::new();
    let index_changes = Mutex::new(HashSet::new());
    let target = vault.root.join("Notes/open.md");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut heard = false;
    while Instant::now() < deadline && !heard {
        let Ok(event) = receiver.recv_timeout(Duration::from_millis(200)) else {
            continue;
        };
        let payloads =
            queue_external_changes(event, &vault.root, &state.own_writes, 1, &index_changes);
        heard = payloads
            .iter()
            .any(|payload| Path::new(&payload.path) == target);
    }
    assert!(heard, "the watcher never reported the write of the engine");
}

// ----- folders, renames, the trash -----

#[test]
fn a_folder_is_made_with_its_parents_and_may_exist() {
    let vault = Vault::new();
    let mut fs = vault.fs();
    fs.create_dir("A/B/C").unwrap();
    assert!(vault.root.join("A/B/C").is_dir());
    fs.create_dir("A/B/C").unwrap();
    vault.put("file", b"x");
    assert!(matches!(
        fs.create_dir("file"),
        Err(FsError::AlreadyExists(_))
    ));
}

#[test]
fn a_rename_never_overwrites_and_makes_the_parents_of_the_target() {
    // Д17, Р7: an existing target is AlreadyExists and both files stay
    let vault = Vault::new();
    vault.put("a.md", b"A");
    vault.put("b.md", b"B");
    let mut fs = vault.fs();
    assert!(matches!(
        fs.rename("a.md", "b.md"),
        Err(FsError::AlreadyExists(_))
    ));
    assert_eq!(vault.read("a.md").unwrap(), b"A");
    assert_eq!(vault.read("b.md").unwrap(), b"B");
    fs.rename("a.md", "New/Deeper/c.md").unwrap();
    assert!(vault.read("a.md").is_none());
    assert_eq!(vault.read("New/Deeper/c.md").unwrap(), b"A");
    assert!(matches!(
        fs.rename("ghost.md", "x.md"),
        Err(FsError::NotFound(_))
    ));
}

#[test]
fn a_folder_is_renamed_with_everything_in_it_and_never_onto_another_folder() {
    let vault = Vault::new();
    vault.put("Old/x.md", b"x");
    vault.put("Old/sub/y.md", b"y");
    vault.put("Taken/z.md", b"z");
    let mut fs = vault.fs();
    assert!(matches!(
        fs.rename("Old", "Taken"),
        Err(FsError::AlreadyExists(_))
    ));
    fs.rename("Old", "New").unwrap();
    assert_eq!(vault.read("New/x.md").unwrap(), b"x");
    assert_eq!(vault.read("New/sub/y.md").unwrap(), b"y");
    assert!(!vault.root.join("Old").exists());
}

#[test]
fn a_removed_file_goes_to_the_trash_of_the_vault_and_can_be_restored() {
    // Р8, О4: "whatever delete mode"; the entry is the same as for Amby's own trash
    let vault = Vault::new();
    vault.put("Notes/a.md", b"keep me");
    let mut fs = vault.fs();
    fs.move_to_trash("Notes/a.md", TrashReason::RemoteDeletion)
        .unwrap();
    assert!(vault.read("Notes/a.md").is_none());
    let entries = recycle_bin::list(&vault.root);
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0].original_path, "Notes/a.md");
    recycle_bin::restore(&vault.root, &entries[0].id).unwrap();
    assert_eq!(vault.read("Notes/a.md").unwrap(), b"keep me");
}

#[test]
fn the_trash_works_with_the_history_off_and_keeps_every_deletion() {
    // Р8: not tied to history or to the delete mode
    let vault = Vault::new();
    vault.history_off();
    vault.put("a.md", b"1");
    vault.put("b.md", b"2");
    let mut fs = vault.fs();
    fs.move_to_trash("a.md", TrashReason::RemoteDeletion)
        .unwrap();
    fs.move_to_trash("b.md", TrashReason::RemoteDeletion)
        .unwrap();
    let mut originals: Vec<String> = recycle_bin::list(&vault.root)
        .into_iter()
        .map(|e| e.original_path)
        .collect();
    originals.sort();
    assert_eq!(originals, vec!["a.md", "b.md"]);
}

#[test]
fn only_the_named_file_goes_to_the_trash_not_its_bundle() {
    // Р8: `Proj/Proj.md` is the main note of a bundle; the delete command of Amby would take the
    // whole folder, the engine deletes exactly the file the server deleted
    let vault = Vault::new();
    vault.put("Proj/Proj.md", b"main");
    vault.put("Proj/other.md", b"other");
    let mut fs = vault.fs();
    fs.move_to_trash("Proj/Proj.md", TrashReason::RemoteDeletion)
        .unwrap();
    assert!(vault.read("Proj/Proj.md").is_none());
    assert_eq!(vault.read("Proj/other.md").unwrap(), b"other");
    let entries = recycle_bin::list(&vault.root);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].original_path, "Proj/Proj.md");
}

#[test]
fn trashing_a_missing_file_is_not_found() {
    let vault = Vault::new();
    assert!(matches!(
        vault
            .fs()
            .move_to_trash("ghost.md", TrashReason::RemoteDeletion),
        Err(FsError::NotFound(_))
    ));
}

#[test]
fn an_empty_folder_is_removed_and_a_full_or_missing_one_is_not() {
    let vault = Vault::new();
    fs::create_dir_all(vault.root.join("Empty")).unwrap();
    vault.put("Full/x.md", b"x");
    let mut fs = vault.fs();
    assert!(fs.remove_empty_dir("Empty").unwrap());
    assert!(!vault.root.join("Empty").exists());
    assert!(!fs.remove_empty_dir("Full").unwrap());
    assert!(vault.root.join("Full/x.md").exists());
    assert!(!fs.remove_empty_dir("Ghost").unwrap());
}

// ----- leftovers, journals, rules, batches -----

#[test]
fn leftover_temporary_files_are_removed_everywhere_and_nothing_else() {
    // С3, Д10
    let vault = Vault::new();
    vault.put(".a.md.amby-tmp-1-1", b"half");
    vault.put("Deep/er/.b.md.amby-tmp-77-3", b"half");
    vault.put("keep.md", b"keep");
    vault.put(".hidden-but-ours", b"keep");
    vault.put("Deep/er/c.md", b"keep");
    vault.fs().cleanup_staged().unwrap();
    assert!(vault.temp_files().is_empty());
    assert!(vault.read("keep.md").is_some());
    assert!(vault.read(".hidden-but-ours").is_some());
    assert!(vault.read("Deep/er/c.md").is_some());
}

fn journal(vault: &Vault, folder: &str, name: &str, status: &str) {
    vault.put(
        &format!(".amby/recovery/{folder}/{name}.json"),
        format!(r#"{{"format":"x","status":"{status}","operationId":"{name}"}}"#).as_bytes(),
    );
}

#[test]
fn an_unfinished_journal_is_pending_and_a_finished_one_is_not() {
    // Р8, Д59: "while a journal is unfinished, outgoing changes are not sent"
    let vault = Vault::new();
    assert!(!pending_journals(&vault.root), "no .amby at all");
    vault.put(
        ".amby/recovery/draft-a.json",
        br#"{"id":"a","content":"unsaved text"}"#,
    );
    assert!(
        !pending_journals(&vault.root),
        "an editor draft is not a journal"
    );
    journal(&vault, "database_relations", "op1", "completed");
    journal(&vault, "database_relation_schemas", "op2", "rolledBack");
    assert!(!pending_journals(&vault.root), "finished journals");
    journal(&vault, "database_relations", "op3", "inProgress");
    assert!(pending_journals(&vault.root));
}

#[test]
fn every_kind_of_multi_file_journal_counts() {
    for (folder, status) in [
        ("database_relations", "planned"),
        ("database_relations", "inProgress"),
        ("database_relation_schemas", "inProgress"),
        ("database_batches", "planned"),
        ("creative", "inProgress"),
        ("projects", "inProgress"),
    ] {
        let vault = Vault::new();
        journal(&vault, folder, "op", status);
        assert!(pending_journals(&vault.root), "{folder} {status}");
        let mut fs = vault.fs();
        assert!(fs.recovery_pending().unwrap(), "{folder} {status}");
    }
    let vault = Vault::new();
    vault.put(".amby/migrations/mig.json", br#"{"status":"inProgress"}"#);
    assert!(pending_journals(&vault.root), "an id migration journal");
}

#[test]
fn a_journal_that_cannot_be_read_holds_outgoing_changes_back() {
    // Safe side: a half-done operation must not leave the computer
    let vault = Vault::new();
    vault.put(
        ".amby/recovery/database_relations/broken.json",
        b"{ not json",
    );
    assert!(pending_journals(&vault.root));
    // A journal moved to quarantine is no longer blocking.
    let vault = Vault::new();
    vault.put(
        ".amby/recovery/database_batches/quarantine/broken.json",
        b"{ not json",
    );
    assert!(!pending_journals(&vault.root));
}

#[test]
fn the_rules_of_names_follow_the_system() {
    // Р9
    let rules = vault_rules();
    if cfg!(target_os = "macos") {
        assert!(rules.case_insensitive && !rules.windows_names);
        assert_eq!(rules.max_path_bytes, 1024);
    } else if cfg!(windows) {
        assert!(rules.case_insensitive && rules.windows_names);
        assert_eq!(rules.max_path_bytes, 259);
    } else {
        assert!(!rules.case_insensitive && !rules.windows_names);
        assert_eq!(rules.max_path_bytes, 4096);
    }
    assert_eq!(rules.max_segment_bytes, 255);
}

fn vault_rules() -> amby_sync_core::engine::NameRules {
    Vault::new().fs().name_rules()
}

#[derive(Default)]
struct Recorder(Mutex<Vec<&'static str>>);

impl FsHooks for Recorder {
    fn batch_begin(&self) {
        self.0.lock().unwrap().push("begin");
    }
    fn batch_end(&self) {
        self.0.lock().unwrap().push("end");
    }
}

#[test]
fn batches_are_reported_to_the_application() {
    // Р8: events of the watcher are merged and the index is updated once
    let vault = Vault::new();
    let hooks = Arc::new(Recorder::default());
    let mut fs = VaultFs::with_hooks(vault.root.clone(), hooks.clone());
    fs.batch_begin();
    fs.batch_end();
    fs.batch_begin();
    fs.batch_end();
    assert_eq!(
        *hooks.0.lock().unwrap(),
        vec!["begin", "end", "begin", "end"]
    );
}
