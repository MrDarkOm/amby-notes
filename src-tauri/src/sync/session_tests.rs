//! The engine inside the application: a session of a vault against the real server in the
//! process (docs/sync-plan.md, Р7–Р10, Д10, Д19, Д59, Д70; stage Э4). Two vaults on one computer
//! stand for two computers: each is a device of the same account.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use amby_sync_core::engine::RenameHint;

use super::session::{should_trigger, Schedule, SessionConfig, SyncSession};
use super::test_support::{pass, settle, wait_for, Env, TempVault};
use super::vault_types::{ApprovalKind, ConflictChoice, StopView, SyncPhase};

fn seconds(n: u64) -> Duration {
    Duration::from_secs(n)
}

// ----- when passes run -----

#[test]
fn the_pause_after_failures_doubles_up_to_the_cap() {
    // Д19: "repeat with a growing pause"
    let production = Schedule::production();
    let secs = |failures| production.backoff(failures).as_secs();
    assert_eq!(secs(0), 0);
    assert_eq!(
        (1..=8).map(secs).collect::<Vec<_>>(),
        vec![5, 10, 20, 40, 80, 160, 300, 300]
    );
    assert_eq!(production.backoff(u32::MAX), production.backoff_cap);
    let fast = Schedule::fast();
    assert!(fast.backoff(1) < fast.backoff(2));
    assert!(fast.backoff(30) <= fast.backoff_cap);
    assert!(fast.debounce < Duration::from_millis(500));
}

#[test]
fn only_changes_the_rules_do_not_exclude_start_a_pass() {
    // Р4, Р10: .git, .obsidian, .trash, the private parts of .amby, temporary files and system
    // litter never start a pass; the vault itself (an event without a path) does
    let vault = Path::new("/Users/me/Vault");
    for path in [
        "/Users/me/Vault/Notes/a.md",
        "/Users/me/Vault/a.png",
        "/Users/me/Vault/.amby/properties.json",
        "/Users/me/Vault/.amby/blocks/n1.json",
        "/Users/me/Vault/.amby/graph-layout.json",
        "/Users/me/Vault/Folder",
        "/Users/me/Vault",
    ] {
        assert!(should_trigger(vault, Path::new(path)), "{path}");
    }
    for path in [
        "/Users/me/Vault/.git/index",
        "/Users/me/Vault/Notes/.git/HEAD",
        "/Users/me/Vault/.obsidian/app.json",
        "/Users/me/Vault/.trash/x.md",
        "/Users/me/Vault/.amby/notes.db",
        "/Users/me/Vault/.amby/notes.db-wal",
        "/Users/me/Vault/.amby/history/manifest.json",
        "/Users/me/Vault/.amby/recovery/draft.json",
        "/Users/me/Vault/.amby/trash/x/a.md",
        "/Users/me/Vault/.amby/sync/state.db",
        "/Users/me/Vault/Notes/.a.md.amby-tmp-1-2",
        "/Users/me/Vault/.DS_Store",
        "/Users/me/Vault/Notes/._a.md",
        "/Users/me/Other/a.md",
        "/tmp/a.md",
    ] {
        assert!(!should_trigger(vault, Path::new(path)), "{path}");
    }
}

// ----- two computers -----

#[test]
fn two_vaults_end_up_with_the_same_files() {
    // The goal of the stage: a vault on one computer arrives on another, byte for byte
    let env = Env::new();
    let a = TempVault::new("a");
    let b = TempVault::new("b");
    a.put(
        "Welcome.md",
        "# Привет\r\nwith CRLF and a BOM\u{feff}".as_bytes(),
    );
    a.put("Notes/Идея 1.md", "текст".as_bytes());
    a.put(
        "Notes/deep/er/file.bin",
        &(0..=255u8).cycle().take(300_000).collect::<Vec<_>>(),
    );
    a.put("assets/pic.png", &[0x89, b'P', b'N', b'G', 0, 1, 2, 3]);
    std::fs::create_dir_all(a.root.join("Empty folder")).unwrap();
    let (session_a, _) = env.start(&a, &env.account);
    let other = env.another_computer("B");
    let (session_b, _) = env.start(&b, &other);
    settle(&session_a, &session_b);
    assert_eq!(a.files(), b.files());
    assert!(
        b.root.join("Empty folder").is_dir(),
        "an empty folder is a record too (Р2)"
    );
    assert_eq!(b.files().len(), 4);

    // And changes go both ways.
    b.put("Notes/from-b.md", b"hello from b");
    a.put("Welcome.md", b"edited on a");
    settle(&session_a, &session_b);
    assert_eq!(a.text("Notes/from-b.md").as_deref(), Some("hello from b"));
    assert_eq!(b.text("Welcome.md").as_deref(), Some("edited on a"));
    assert_eq!(a.files(), b.files());
    session_a.stop();
    session_b.stop();
}

#[test]
fn a_file_replaced_from_the_server_keeps_the_old_version_in_the_history() {
    // Р8, О4: sync-overwrite, even with the history off
    let env = Env::new();
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    b.history_off();
    a.put("Notes/n.md", b"version one");
    let (sa, _) = env.start(&a, &env.account);
    let (sb, _) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    a.put("Notes/n.md", b"version two");
    settle(&sa, &sb);
    assert_eq!(b.text("Notes/n.md").as_deref(), Some("version two"));
    assert_eq!(
        b.snapshots("Notes/n.md"),
        vec![("sync-overwrite".to_string(), "version one".to_string())]
    );
    sa.stop();
    sb.stop();
}

#[test]
fn a_deletion_from_another_computer_goes_to_the_trash_of_the_vault() {
    // Р8, О4: whatever the delete mode, it can be brought back inside Amby
    let env = Env::new();
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    a.put("Notes/gone.md", b"not forever");
    a.put("Notes/stays.md", b"stays");
    let (sa, _) = env.start(&a, &env.account);
    let (sb, _) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    a.remove("Notes/gone.md");
    settle(&sa, &sb);
    assert!(!b.exists("Notes/gone.md"));
    assert!(b.exists("Notes/stays.md"));
    assert_eq!(b.trashed(), vec!["Notes/gone.md"]);
    sa.stop();
    sb.stop();
}

#[test]
fn a_deletion_from_another_computer_is_reported_to_the_application_with_its_path() {
    // the interface warns about it only when the note is open, so it needs the path
    let env = Env::new();
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    a.put("Notes/gone.md", b"not forever");
    a.put("Notes/stays.md", b"stays");
    let (sa, _) = env.start(&a, &env.account);
    let (sb, recorder_b) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    assert!(
        recorder_b.deleted_remotely().is_empty(),
        "files that arrive are not deletions"
    );
    a.remove("Notes/gone.md");
    settle(&sa, &sb);
    assert_eq!(recorder_b.deleted_remotely(), vec!["Notes/gone.md"]);
    // the report names the vault it is for, so a window that has moved on can ignore it
    assert_eq!(recorder_b.deleted_remotely_vaults(), vec![b.root.clone()]);
    // a later pass that deletes nothing does not repeat it
    pass(&sb);
    assert_eq!(recorder_b.deleted_remotely(), vec!["Notes/gone.md"]);
    sa.stop();
    sb.stop();
}

#[test]
fn a_deletion_the_person_made_here_is_not_reported_as_remote() {
    let env = Env::new();
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    a.put("Notes/mine.md", b"mine");
    let (sa, recorder_a) = env.start(&a, &env.account);
    let (sb, _) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    a.remove("Notes/mine.md");
    settle(&sa, &sb);
    assert!(recorder_a.deleted_remotely().is_empty());
    sa.stop();
    sb.stop();
}

#[test]
fn what_came_from_the_server_is_not_sent_back() {
    // Р10, Д12: a write of synchronisation is not an edit of this computer
    let env = Env::new();
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    for n in 0..5 {
        a.put(&format!("Notes/{n}.md"), format!("note {n}").as_bytes());
    }
    let (sa, _) = env.start(&a, &env.account);
    let (sb, _) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    let head = env.head();
    // The files B wrote reach its watcher as changes; a pass because of them must find nothing.
    for n in 0..5 {
        sb.notify_path(&b.root.join(format!("Notes/{n}.md")));
    }
    let status = pass(&sb);
    assert_eq!(status.last.unwrap().uploaded, 0);
    pass(&sb);
    assert_eq!(env.head(), head, "the server got nothing new");
    sa.stop();
    sb.stop();
}

#[test]
fn a_batch_of_incoming_changes_is_reported_to_the_application() {
    // Р8: the events of the watcher are merged and the index is updated once per batch
    let env = Env::new();
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    a.put("one.md", b"1");
    a.put("two.md", b"2");
    let (sa, _) = env.start(&a, &env.account);
    let (sb, recorder_b) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    use std::sync::atomic::Ordering;
    let (begins, ends) = (
        recorder_b.begins.load(Ordering::SeqCst),
        recorder_b.ends.load(Ordering::SeqCst),
    );
    assert!(begins >= 1, "the download was a batch");
    assert_eq!(begins, ends, "every batch ended");
    let passes = recorder_b.passes_started() as u64;
    assert!(
        begins <= passes,
        "one batch per pass, not per file: {begins} batches in {passes} passes"
    );
    sa.stop();
    sb.stop();
}

#[test]
fn edits_on_both_computers_make_a_conflict_copy_and_lose_nothing() {
    // Р7: the first to reach the server keeps the name; the other version is a copy next to it
    let env = Env::new();
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    a.put("Notes/n.md", b"base");
    let (sa, _) = env.start(&a, &env.account);
    let (sb, _) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    a.put("Notes/n.md", b"edit on a");
    b.put("Notes/n.md", b"edit on b");
    pass(&sa);
    let status = pass(&sb);
    assert_eq!(
        b.text("Notes/n.md").as_deref(),
        Some("edit on a"),
        "the server's version keeps the name"
    );
    assert_eq!(status.conflicts.len(), 1, "{:?}", status.conflicts);
    let conflict = &status.conflicts[0];
    assert_eq!(conflict.kind, "bothEdited");
    assert_eq!(conflict.original_path, "Notes/n.md");
    assert!(
        conflict.copy_path.starts_with("Notes/n.") && conflict.copy_path.ends_with("-conflict.md")
    );
    assert_eq!(b.text(&conflict.copy_path).as_deref(), Some("edit on b"));
    // The copy reaches the other computer too: both versions exist everywhere.
    settle(&sa, &sb);
    assert_eq!(a.text(&conflict.copy_path).as_deref(), Some("edit on b"));
    assert_eq!(a.files(), b.files());
    sa.stop();
    sb.stop();
}

fn conflict_between_two(env: &Env) -> (TempVault, TempVault, SyncSession, SyncSession, String) {
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    a.put("Notes/n.md", b"base");
    let (sa, _) = env.start(&a, &env.account);
    let (sb, _) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    a.put("Notes/n.md", b"mine on a");
    b.put("Notes/n.md", b"theirs on b");
    pass(&sa);
    let status = pass(&sb);
    let id = status.conflicts[0].id.clone();
    (a, b, sa, sb, id)
}

#[test]
fn keeping_the_original_sends_the_copy_to_the_trash_everywhere() {
    // Р7: "keep mine"
    let env = Env::new();
    let (a, b, sa, sb, id) = conflict_between_two(&env);
    let copy = pass(&sb).conflicts[0].copy_path.clone();
    sb.resolve_conflict(&id, ConflictChoice::KeepOriginal)
        .unwrap();
    let status = pass(&sb);
    assert!(status.conflicts.is_empty(), "the entry left the list");
    assert!(!b.exists(&copy));
    assert_eq!(b.text("Notes/n.md").as_deref(), Some("mine on a"));
    assert!(b.trashed().contains(&copy));
    settle(&sa, &sb);
    assert!(!a.exists(&copy), "the deletion reached the other computer");
    assert_eq!(a.files(), b.files());
    sa.stop();
    sb.stop();
}

#[test]
fn keeping_the_copy_replaces_the_file_and_keeps_the_replaced_version() {
    // Р7: "keep the other"; the version it replaces is a snapshot in the history (Р8)
    let env = Env::new();
    let (a, b, sa, sb, id) = conflict_between_two(&env);
    let copy = pass(&sb).conflicts[0].copy_path.clone();
    sb.resolve_conflict(&id, ConflictChoice::KeepCopy).unwrap();
    pass(&sb);
    assert_eq!(b.text("Notes/n.md").as_deref(), Some("theirs on b"));
    assert!(!b.exists(&copy));
    assert!(
        b.snapshots("Notes/n.md")
            .iter()
            .any(|(reason, text)| reason == "sync-overwrite" && text == "mine on a"),
        "{:?}",
        b.snapshots("Notes/n.md")
    );
    settle(&sa, &sb);
    assert_eq!(a.text("Notes/n.md").as_deref(), Some("theirs on b"));
    assert_eq!(a.files(), b.files());
    assert!(sb.status().conflicts.is_empty());
    sa.stop();
    sb.stop();
}

#[test]
fn keeping_both_only_clears_the_entry() {
    let env = Env::new();
    let (a, b, sa, sb, id) = conflict_between_two(&env);
    let copy = pass(&sb).conflicts[0].copy_path.clone();
    sb.resolve_conflict(&id, ConflictChoice::KeepBoth).unwrap();
    let status = pass(&sb);
    assert!(status.conflicts.is_empty());
    assert!(b.exists(&copy) && b.exists("Notes/n.md"));
    settle(&sa, &sb);
    assert!(a.exists(&copy));
    sa.stop();
    sb.stop();
}

#[test]
fn an_unknown_conflict_is_not_found() {
    let env = Env::new();
    let a = TempVault::new("a");
    a.put("x.md", b"x");
    let (sa, _) = env.start(&a, &env.account);
    let error = sa
        .resolve_conflict("000000000000", ConflictChoice::KeepBoth)
        .unwrap_err();
    assert_eq!(error.code, "conflict_not_found");
    sa.stop();
}

#[test]
fn the_two_versions_of_a_conflict_can_be_read_from_the_file_and_its_copy() {
    // Э4б, К3/К4: the comparison reads both versions through the session, not by path
    let env = Env::new();
    let (_a, _b, sa, sb, id) = conflict_between_two(&env);
    let versions = sb.read_conflict_versions(&id).unwrap();
    assert_eq!(versions.original.as_deref(), Some("mine on a"));
    assert_eq!(versions.copy.as_deref(), Some("theirs on b"));
    sa.stop();
    sb.stop();
}

#[test]
fn a_version_that_is_not_text_is_not_returned_as_text() {
    let env = Env::new();
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    a.put("pic.bin", b"base");
    let (sa, _) = env.start(&a, &env.account);
    let (sb, _) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    a.put("pic.bin", &[0xff, 0xfe, 0x00, 0x80]);
    b.put("pic.bin", b"text on b");
    pass(&sa);
    let id = pass(&sb).conflicts[0].id.clone();
    let versions = sb.read_conflict_versions(&id).unwrap();
    assert_eq!(
        versions.original, None,
        "bytes that are not UTF-8 are not text"
    );
    assert_eq!(versions.copy.as_deref(), Some("text on b"));
    sa.stop();
    sb.stop();
}

#[test]
fn resolving_with_a_text_writes_exactly_that_text_and_clears_the_conflict_everywhere() {
    // К4: the assembled result goes in as given, the replaced version is a snapshot, the copy is trashed
    let env = Env::new();
    let (a, b, sa, sb, id) = conflict_between_two(&env);
    let copy = pass(&sb).conflicts[0].copy_path.clone();
    let assembled = "\u{feff}line one\r\n\r\nmine and theirs\r\n";
    let stamp = sb.read_conflict_versions(&id).unwrap().stamp;
    sb.resolve_conflict_with_text(&id, assembled, &stamp)
        .unwrap();
    let status = pass(&sb);
    assert!(status.conflicts.is_empty(), "the entry left the list");
    assert_eq!(
        b.text("Notes/n.md").as_deref(),
        Some(assembled),
        "byte for byte"
    );
    assert!(!b.exists(&copy));
    assert!(b.trashed().contains(&copy));
    assert!(
        b.snapshots("Notes/n.md")
            .iter()
            .any(|(reason, text)| reason == "sync-overwrite" && text == "mine on a"),
        "{:?}",
        b.snapshots("Notes/n.md")
    );
    settle(&sa, &sb);
    assert_eq!(a.text("Notes/n.md").as_deref(), Some(assembled));
    assert!(!a.exists(&copy));
    assert_eq!(a.files(), b.files());
    sa.stop();
    sb.stop();
}

#[test]
fn the_versions_carry_a_stamp_that_changes_with_either_file() {
    let env = Env::new();
    let (_a, b, sa, sb, id) = conflict_between_two(&env);
    let first = sb.read_conflict_versions(&id).unwrap().stamp;
    assert!(!first.is_empty());
    assert_eq!(sb.read_conflict_versions(&id).unwrap().stamp, first);
    b.put("Notes/n.md", b"edited meanwhile");
    assert_ne!(sb.read_conflict_versions(&id).unwrap().stamp, first);
    sa.stop();
    sb.stop();
}

#[test]
fn a_text_built_from_versions_that_changed_is_not_written() {
    // Э4б: "Done" must not overwrite what arrived while the person compared
    let env = Env::new();
    let (_a, b, sa, sb, id) = conflict_between_two(&env);
    let copy = pass(&sb).conflicts[0].copy_path.clone();
    let stamp = sb.read_conflict_versions(&id).unwrap().stamp;
    b.put("Notes/n.md", b"arrived while comparing");
    let error = sb
        .resolve_conflict_with_text(&id, "assembled", &stamp)
        .unwrap_err();
    assert_eq!(error.code, "conflict_changed");
    assert_eq!(
        b.text("Notes/n.md").as_deref(),
        Some("arrived while comparing")
    );
    assert!(b.exists(&copy), "the copy is still there");
    assert_eq!(sb.status().conflicts.len(), 1, "the conflict stays");
    // the copy changing counts as well
    let stamp = sb.read_conflict_versions(&id).unwrap().stamp;
    b.put(&copy, b"copy changed meanwhile");
    assert_eq!(
        sb.resolve_conflict_with_text(&id, "assembled", &stamp)
            .unwrap_err()
            .code,
        "conflict_changed"
    );
    // with a fresh stamp it goes through
    let stamp = sb.read_conflict_versions(&id).unwrap().stamp;
    sb.resolve_conflict_with_text(&id, "assembled", &stamp)
        .unwrap();
    assert_eq!(b.text("Notes/n.md").as_deref(), Some("assembled"));
    sa.stop();
    sb.stop();
}

#[test]
fn an_unknown_conflict_is_not_found_for_reading_and_for_resolving_with_a_text() {
    let env = Env::new();
    let a = TempVault::new("a");
    a.put("x.md", b"x");
    let (sa, _) = env.start(&a, &env.account);
    assert_eq!(
        sa.read_conflict_versions("000000000000").unwrap_err().code,
        "conflict_not_found"
    );
    assert_eq!(
        sa.resolve_conflict_with_text("000000000000", "x", "stamp")
            .unwrap_err()
            .code,
        "conflict_not_found"
    );
    assert_eq!(a.text("x.md").as_deref(), Some("x"), "nothing was written");
    sa.stop();
}

// ----- Р8: stops and journals -----

#[test]
fn an_unfinished_journal_holds_outgoing_changes_back() {
    // Р8, Д59: a half-done operation must not leave the computer
    let env = Env::new();
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    a.put("n.md", b"one");
    let (sa, _) = env.start(&a, &env.account);
    let (sb, _) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    a.put(
        ".amby/recovery/database_relations/op1.json",
        br#"{"status":"inProgress","operationId":"op1"}"#,
    );
    a.put("n.md", b"half-done change");
    let head = env.head();
    let status = pass(&sa);
    assert!(status.outgoing_paused);
    assert_eq!(env.head(), head, "nothing was sent");
    pass(&sb);
    assert_eq!(b.text("n.md").as_deref(), Some("one"));
    // The operation ends: the change goes.
    a.put(
        ".amby/recovery/database_relations/op1.json",
        br#"{"status":"completed","operationId":"op1"}"#,
    );
    let status = pass(&sa);
    assert!(!status.outgoing_paused);
    pass(&sb);
    assert_eq!(b.text("n.md").as_deref(), Some("half-done change"));
    sa.stop();
    sb.stop();
}

fn thirty_files(vault: &TempVault) {
    for n in 0..30 {
        vault.put(&format!("Notes/{n:02}.md"), format!("note {n}").as_bytes());
    }
}

#[test]
fn a_mass_deletion_stops_before_it_leaves_and_before_it_arrives() {
    // Р8, О6: 20 files and more than 10% stop the pass on both sides and show the list
    let env = Env::new();
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    thirty_files(&a);
    let (sa, _) = env.start(&a, &env.account);
    let (sb, _) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    assert_eq!(b.files().len(), 30);

    for n in 0..25 {
        a.remove(&format!("Notes/{n:02}.md"));
    }
    let head = env.head();
    let status = pass(&sa);
    assert_eq!(status.phase, SyncPhase::Stopped);
    match &status.stop {
        Some(StopView::MassChange {
            direction,
            total,
            files,
        }) => {
            assert_eq!(direction, "outgoing");
            assert_eq!(*total, 25);
            assert_eq!(files.len(), 25);
            assert!(files.iter().all(|f| f.action == "sendDelete"));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(env.head(), head, "nothing was sent");
    assert_eq!(pass(&sb).phase, SyncPhase::Idle);
    assert_eq!(b.files().len(), 30);

    // The person says yes: the deletions go; the other computer stops in its turn.
    sa.approve(ApprovalKind::MassChange);
    let status = pass(&sa);
    assert_eq!(status.phase, SyncPhase::Idle);
    assert!(env.head() > head);
    let status = pass(&sb);
    assert_eq!(status.phase, SyncPhase::Stopped);
    match &status.stop {
        Some(StopView::MassChange {
            direction, total, ..
        }) => {
            assert_eq!(direction, "incoming");
            assert_eq!(*total, 25);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(b.files().len(), 30, "nothing was touched on B");
    sb.approve(ApprovalKind::MassChange);
    pass(&sb);
    assert_eq!(b.files().len(), 5);
    assert_eq!(b.trashed().len(), 25, "all of them can be brought back");
    sa.stop();
    sb.stop();
}

#[test]
fn a_vault_folder_that_disappears_is_not_a_deletion() {
    // Р8, С8: an unplugged disk
    let env = Env::new();
    let a = TempVault::new("a");
    thirty_files(&a);
    let (sa, _) = env.start(&a, &env.account);
    pass(&sa);
    let head = env.head();
    let hidden = a.root.with_extension("away");
    std::fs::rename(&a.root, &hidden).unwrap();
    let status = pass(&sa);
    assert_eq!(status.phase, SyncPhase::Stopped);
    assert_eq!(status.stop, Some(StopView::VaultMissing));
    assert_eq!(env.head(), head, "nothing was deleted on the server");
    std::fs::rename(&hidden, &a.root).unwrap();
    let status = pass(&sa);
    assert_eq!(status.phase, SyncPhase::Idle, "it goes on by itself");
    assert_eq!(env.head(), head);
    assert_eq!(a.files().len(), 30);
    sa.stop();
}

#[test]
fn a_reset_server_stops_and_touches_no_local_file() {
    // Р8, С7: an empty server is never a command to delete
    let env = Env::new();
    let a = TempVault::new("a");
    thirty_files(&a);
    let (sa, _) = env.start(&a, &env.account);
    pass(&sa);
    let before = a.files();
    env.target
        .control()
        .expect("a server in the process")
        .restart_fresh();
    let status = pass(&sa);
    assert_eq!(status.phase, SyncPhase::Stopped);
    assert_eq!(status.stop, Some(StopView::ServerReset));
    assert_eq!(a.files(), before);
    assert!(a.trashed().is_empty());
    // It stays stopped on later passes: the person has not answered.
    assert_eq!(pass(&sa).stop, Some(StopView::ServerReset));
    sa.stop();
}

#[test]
fn a_disconnected_device_stops_and_asks_to_sign_in_again() {
    // С12, П5: the token was revoked
    let env = Env::new();
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    a.put("x.md", b"x");
    let second = env.another_computer("B");
    let (sa, _) = env.start(&a, &env.account);
    let (sb, _) = env.start(&b, &second);
    settle(&sa, &sb);
    env.account
        .delete(&format!("/v1/devices/{}", second.device_id))
        .expect(204);
    b.put("y.md", b"never leaves");
    let status = pass(&sb);
    assert_eq!(status.phase, SyncPhase::Stopped);
    assert_eq!(status.stop, Some(StopView::AuthRequired));
    assert_eq!(status.error_code.as_deref(), Some("token_revoked"));
    assert!(b.exists("x.md") && b.exists("y.md"));
    sa.stop();
    sb.stop();
}

// ----- timing: the watcher, the server, failures -----

#[test]
fn bursts_of_changes_make_few_passes() {
    // Д19, Р10: a pause merges a burst of notifications into one pass
    let env = Env::new();
    let a = TempVault::new("a");
    a.put("seed.md", b"seed");
    let (sa, recorder) = env.start(&a, &env.account);
    pass(&sa);
    let before = recorder.passes_started();
    for n in 0..40 {
        let path = a.put(&format!("burst/{n}.md"), format!("{n}").as_bytes());
        sa.notify_path(&path);
    }
    let items = |env: &Env| {
        let page = env
            .account
            .get(&format!(
                "/v1/spaces/{}/changes?since=0&limit=1000",
                hex::encode(env.space_id)
            ))
            .expect(200)
            .json();
        page["changes"].as_array().unwrap().len()
    };
    let deadline = std::time::Instant::now() + seconds(30);
    while items(&env) < 41 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(
        items(&env),
        41,
        "the seed and all 40 files reached the server"
    );
    let passes = recorder.passes_started() - before;
    assert!(passes <= 8, "40 notifications made {passes} passes");
    sa.stop();
}

#[test]
fn a_change_on_disk_starts_a_pass_by_itself() {
    // Р10: the watcher drives the sync; nobody presses a button
    let env = Env::new();
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    a.put("seed.md", b"seed");
    let (sa, _) = env.start(&a, &env.account);
    let (sb, _) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    let path = a.put("Notes/new.md", b"typed just now");
    sa.notify_path(&path);
    wait_for(&sb, seconds(30), |_| b.exists("Notes/new.md"))
        .expect("the other computer got the file without any button: the server told it (П34)");
    assert_eq!(b.text("Notes/new.md").as_deref(), Some("typed just now"));
    sa.stop();
    sb.stop();
}

#[test]
fn a_notification_for_an_excluded_path_starts_nothing() {
    let env = Env::new();
    let a = TempVault::new("a");
    a.put("seed.md", b"seed");
    let (sa, recorder) = env.start(&a, &env.account);
    pass(&sa);
    std::thread::sleep(Duration::from_millis(300));
    let before = recorder.passes_started();
    sa.notify_path(&a.root.join(".git/index"));
    sa.notify_path(&a.root.join(".amby/notes.db"));
    sa.notify_path(&a.root.join("Notes/.x.md.amby-tmp-1-1"));
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(recorder.passes_started(), before);
    sa.stop();
}

/// A relay to the server that can be cut and restored (a network that goes and comes back).
struct Relay {
    address: String,
    up: Arc<std::sync::atomic::AtomicBool>,
    streams: Arc<std::sync::Mutex<Vec<std::net::TcpStream>>>,
}

impl Relay {
    fn start(target: &str) -> Self {
        use std::io::{Read, Write};
        use std::net::{TcpListener, TcpStream};
        use std::sync::atomic::Ordering;
        let target = target.trim_start_matches("http://").to_string();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let up = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let streams: Arc<std::sync::Mutex<Vec<TcpStream>>> = Arc::default();
        let (flag, kept) = (up.clone(), streams.clone());
        std::thread::spawn(move || {
            for client in listener.incoming() {
                let Ok(client) = client else { break };
                if !flag.load(Ordering::SeqCst) {
                    drop(client);
                    continue;
                }
                let Ok(server) = TcpStream::connect(&target) else {
                    continue;
                };
                kept.lock().unwrap().push(client.try_clone().unwrap());
                kept.lock().unwrap().push(server.try_clone().unwrap());
                for (mut from, mut to) in [
                    (client.try_clone().unwrap(), server.try_clone().unwrap()),
                    (server, client),
                ] {
                    std::thread::spawn(move || {
                        let mut buffer = [0u8; 16 * 1024];
                        while let Ok(n) = from.read(&mut buffer) {
                            if n == 0 || to.write_all(&buffer[..n]).is_err() {
                                break;
                            }
                        }
                        let _ = to.shutdown(std::net::Shutdown::Both);
                    });
                }
            }
        });
        Self {
            address,
            up,
            streams,
        }
    }

    fn cut(&self) {
        use std::sync::atomic::Ordering;
        self.up.store(false, Ordering::SeqCst);
        for stream in self.streams.lock().unwrap().drain(..) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }

    fn restore(&self) {
        self.up.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

fn config_through(
    env: &Env,
    vault: &Path,
    relay: &Relay,
    hooks: Arc<super::test_support::Recorder>,
) -> SessionConfig {
    let mut config = env.config(vault, &env.account, hooks);
    config.client = amby_sync_client::SyncClient::new(
        &amby_sync_client::ServerUrl::parse(&relay.address, true).unwrap(),
    )
    .unwrap();
    config
}

#[test]
fn a_lost_network_waits_with_growing_pauses_and_recovers_by_itself() {
    // Д19, С1: nothing is lost, nothing is stopped for good
    let env = Env::new();
    let a = TempVault::new("a");
    a.put("seed.md", b"seed");
    let relay = Relay::start(env.target.api.base());
    let recorder = Arc::new(super::test_support::Recorder::default());
    let session =
        SyncSession::start(config_through(&env, &a.root, &relay, recorder.clone())).unwrap();
    pass(&session);
    assert_eq!(session.status().phase, SyncPhase::Idle);

    relay.cut();
    a.put("while-offline.md", b"written without a network");
    session.sync_now();
    let waiting = wait_for(&session, seconds(20), |s| s.phase == SyncPhase::Waiting).unwrap();
    assert_eq!(waiting.error_code.as_deref(), Some("network"));
    assert!(waiting.next_try_secs.is_some());
    // It keeps trying, again and again, by itself.
    let started = recorder.passes_started();
    std::thread::sleep(Duration::from_millis(1200));
    assert!(
        recorder.passes_started() >= started + 3,
        "retries: {}",
        recorder.passes_started() - started
    );
    assert!(a.exists("while-offline.md"), "nothing was touched");

    relay.restore();
    wait_for(&session, seconds(30), |s| {
        s.phase == SyncPhase::Idle && s.error_code.is_none()
    })
    .expect("it recovers without a button");
    assert!(env.head() >= 2);
    let page = env
        .account
        .get(&format!(
            "/v1/spaces/{}/changes?since=0",
            hex::encode(env.space_id)
        ))
        .expect(200)
        .json();
    assert_eq!(
        page["changes"].as_array().unwrap().len(),
        2,
        "both files are on the server"
    );
    session.stop();
}

#[test]
fn stopping_while_waiting_does_not_hang() {
    let env = Env::new();
    let a = TempVault::new("a");
    a.put("seed.md", b"seed");
    let relay = Relay::start(env.target.api.base());
    let recorder = Arc::new(super::test_support::Recorder::default());
    relay.cut();
    let session = SyncSession::start(config_through(&env, &a.root, &relay, recorder)).unwrap();
    wait_for(&session, seconds(20), |s| s.phase == SyncPhase::Waiting).unwrap();
    let started = std::time::Instant::now();
    session.stop();
    assert!(
        started.elapsed() < seconds(5),
        "took {:?}",
        started.elapsed()
    );
}

// ----- identity, restarts, locks -----

#[test]
fn a_second_session_on_the_same_vault_is_refused_until_the_first_stops() {
    // Р10, С14: a lock file keeps two processes from synchronising one vault
    let env = Env::new();
    let a = TempVault::new("a");
    a.put("x.md", b"x");
    let (first, _) = env.start(&a, &env.account);
    let second =
        SyncSession::start(env.config(&a.root, &env.account, Arc::new(super::session::NoHooks)));
    assert_eq!(second.err().expect("must be refused").code, "vault_locked");
    first.stop();
    let (again, _) = env.start(&a, &env.account);
    again.stop();
}

#[test]
fn a_restart_goes_on_from_the_state_and_uploads_nothing_again() {
    // Д4, Р10
    let env = Env::new();
    let a = TempVault::new("a");
    a.put("x.md", b"x");
    a.put("y/z.md", b"z");
    let (first, _) = env.start(&a, &env.account);
    pass(&first);
    first.stop();
    let head = env.head();
    let (again, _) = env.start(&a, &env.account);
    let status = pass(&again);
    assert_eq!(status.last.unwrap().uploaded, 0);
    assert_eq!(env.head(), head);
    again.stop();
}

#[test]
fn a_vault_copied_to_another_computer_reconciles_instead_of_posing_as_the_old_one() {
    // Р10: the identity of the device in the state differs from this device: full reconcile by
    // content — same files are linked, nothing is deleted, no copies of conflict appear
    let env = Env::new();
    let (a, c) = (TempVault::new("a"), TempVault::new("c"));
    a.put("x.md", b"x");
    a.put("Notes/y.md", b"y");
    let (first, _) = env.start(&a, &env.account);
    pass(&first);
    first.stop();
    // The whole folder, state included, is copied to a computer that is another device.
    copy_dir(&a.root, &c.root);
    let other = env.another_computer("C");
    let head = env.head();
    let (copied, _) = env.start(&c, &other);
    let status = pass(&copied);
    assert!(status.conflicts.is_empty(), "{:?}", status.conflicts);
    assert_eq!(env.head(), head, "nothing was uploaded or deleted");
    assert_eq!(c.files(), a.files());
    copied.stop();
}

fn copy_dir(from: &Path, to: &Path) {
    for entry in walkdir::WalkDir::new(from).into_iter().flatten() {
        let rel = entry.path().strip_prefix(from).unwrap();
        let target = to.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target).unwrap();
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}

// ----- hints, lists, status -----

#[test]
fn a_rename_together_with_an_edit_stays_one_item() {
    // Д70, Д13: the hint of Amby keeps "renamed and edited" from becoming "deleted and created"
    let env = Env::new();
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    a.put("keep.md", b"keep");
    a.put(
        "Notes/old.md",
        b"the first text of the note, long enough to be itself",
    );
    let (sa, _) = env.start(&a, &env.account);
    let (sb, _) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    std::fs::rename(a.root.join("Notes/old.md"), a.root.join("Notes/new.md")).unwrap();
    a.put(
        "Notes/new.md",
        b"a completely different text after the rename",
    );
    sa.add_rename_hints(vec![RenameHint {
        from: "Notes/old.md".into(),
        to: "Notes/new.md".into(),
    }]);
    settle(&sa, &sb);
    assert_eq!(
        b.text("Notes/new.md").as_deref(),
        Some("a completely different text after the rename")
    );
    assert!(!b.exists("Notes/old.md"));
    assert!(
        b.trashed().is_empty(),
        "nothing was deleted: it is one item that moved"
    );
    let page = env
        .account
        .get(&format!(
            "/v1/spaces/{}/changes?since=0",
            hex::encode(env.space_id)
        ))
        .expect(200)
        .json();
    let deleted = page["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|change| change["deleted"] == true)
        .count();
    assert_eq!(deleted, 0, "no deletion record");
    sa.stop();
    sb.stop();
}

#[cfg(unix)]
#[test]
fn files_that_are_not_synchronised_are_listed_with_their_reason() {
    // Р4: the person sees what stays behind and why
    let env = Env::new();
    let a = TempVault::new("a");
    a.put("real.md", b"real");
    std::os::unix::fs::symlink(a.root.join("real.md"), a.root.join("link.md")).unwrap();
    a.put(".git/config", b"[core]");
    let (sa, _) = env.start(&a, &env.account);
    let status = pass(&sa);
    let list: Vec<(&str, &str)> = status
        .unsynced
        .iter()
        .map(|u| (u.path.as_str(), u.reason.as_str()))
        .collect();
    assert_eq!(list, vec![("link.md", "symlink")]);
    sa.stop();
}

#[test]
fn the_status_names_the_space_and_the_test_mark() {
    let env = Env::new();
    let a = TempVault::new("a");
    a.put("x.md", b"x");
    let (sa, _) = env.start(&a, &env.account);
    let status = pass(&sa);
    assert!(status.enabled && status.linked && status.test_vault);
    assert_eq!(
        status.space_id.as_deref(),
        Some(hex::encode(env.space_id).as_str())
    );
    assert_eq!(status.space_name.as_deref(), Some("Test space"));
    assert_eq!(status.phase, SyncPhase::Idle);
    assert!(status.last_sync_ms.unwrap() > 1_700_000_000_000);
    assert_eq!(status.error_code, None);
    assert_eq!(status.stop, None);
    sa.stop();
}

fn note_with_id(id: &str, body: &str) -> String {
    format!("---\namby-id: {id}\n---\n{body}")
}

#[test]
fn keeping_both_gives_the_copy_a_note_identity_of_its_own() {
    // Р7 ("check on Э4"): the copy repeats the amby-id of its file, which blocks editing of the
    // duplicate. "Keep both" makes the copy a note of its own: a new amby-id, nothing else changed.
    use crate::index::{load_vault, open_connection};
    let env = Env::new();
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    let id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    a.put("Notes/n.md", note_with_id(id, "base").as_bytes());
    let (sa, _) = env.start(&a, &env.account);
    let (sb, _) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    a.put("Notes/n.md", note_with_id(id, "mine on a").as_bytes());
    b.put("Notes/n.md", note_with_id(id, "theirs on b").as_bytes());
    pass(&sa);
    let status = pass(&sb);
    let conflict = status.conflicts[0].clone();
    assert!(b
        .text(&conflict.copy_path)
        .unwrap()
        .contains(&format!("amby-id: {id}")));

    sb.resolve_conflict(&conflict.id, ConflictChoice::KeepBoth)
        .unwrap();
    let copy = b.text(&conflict.copy_path).unwrap();
    let original = b.text("Notes/n.md").unwrap();
    assert_eq!(
        original,
        note_with_id(id, "mine on a"),
        "the file is untouched"
    );
    assert!(!copy.contains(id), "the copy has its own identity: {copy}");
    assert!(copy.starts_with("---\namby-id: "));
    assert!(
        copy.ends_with("---\ntheirs on b"),
        "only the id changed: {copy}"
    );
    assert!(
        b.snapshots(&conflict.copy_path)
            .iter()
            .any(|(reason, text)| reason == "id-assignment" && text.contains(id)),
        "the old text of the copy is in the history"
    );

    // Amby reads both as ordinary notes now: nothing is a duplicate any more.
    let conn = open_connection(&b.root).unwrap();
    let loaded = load_vault(&conn, &b.root).unwrap();
    assert_eq!(loaded.notes.len(), 2);
    assert!(loaded
        .notes
        .iter()
        .all(|note| !note.id.starts_with("amby-conflict:")));
    settle(&sa, &sb);
    assert_eq!(
        a.files(),
        b.files(),
        "the new identity of the copy reached the other computer"
    );
    sa.stop();
    sb.stop();
}

// ----- Р7 on every computer: the list follows the files (report of 23.10) -----

/// A note with an `amby-id`, as Amby writes them. A copy of a conflict repeats the identity of its file.
fn with_id(body: &str) -> Vec<u8> {
    format!("---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\n{body}").into_bytes()
}

/// Both computers edit `Notes/n.md`; A reaches the server first and keeps the name, B holds the copy.
fn conflict_with_ids(env: &Env) -> (TempVault, TempVault, SyncSession, SyncSession) {
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    a.put("Notes/n.md", &with_id("base"));
    let (sa, _) = env.start(&a, &env.account);
    let (sb, _) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    a.put("Notes/n.md", &with_id("edit on a"));
    b.put("Notes/n.md", &with_id("edit on b"));
    pass(&sa);
    pass(&sb);
    (a, b, sa, sb)
}

#[test]
fn the_computer_whose_version_kept_the_name_lists_the_conflict_too() {
    // Р7, Д46–Д47: the copy reaches A as an ordinary file. A must list it as well (badge, notice,
    // strip), not only B, which lost the race
    let env = Env::new();
    let (a, _b, sa, sb) = conflict_with_ids(&env);
    settle(&sa, &sb);
    let status = pass(&sa);
    assert_eq!(status.conflicts.len(), 1, "{:?}", status.conflicts);
    let conflict = &status.conflicts[0];
    assert_eq!(conflict.original_path, "Notes/n.md");
    assert!(
        conflict.copy_path.starts_with("Notes/n.") && conflict.copy_path.ends_with("-conflict.md")
    );
    assert!(a
        .text(&conflict.copy_path)
        .is_some_and(|text| text.contains("edit on b")));
    assert_eq!(pass(&sb).conflicts.len(), 1, "B lists it as before");
    sa.stop();
    sb.stop();
}

#[test]
fn resolving_on_one_computer_clears_the_conflict_on_every_computer() {
    // "Оставить основной" on A: the copy goes to the trash, the deletion reaches B, and B's entry goes
    let env = Env::new();
    let (a, b, sa, sb) = conflict_with_ids(&env);
    settle(&sa, &sb);
    let status = pass(&sa);
    assert_eq!(status.conflicts.len(), 1, "{:?}", status.conflicts);
    let (id, copy) = (
        status.conflicts[0].id.clone(),
        status.conflicts[0].copy_path.clone(),
    );
    sa.resolve_conflict(&id, ConflictChoice::KeepOriginal)
        .unwrap();
    settle(&sa, &sb);
    assert!(!b.exists(&copy), "the copy is gone on B too");
    assert!(
        pass(&sb).conflicts.is_empty(),
        "B's entry left with the copy"
    );
    assert!(pass(&sa).conflicts.is_empty());
    assert_eq!(a.files(), b.files());
    sa.stop();
    sb.stop();
}

#[test]
fn keeping_both_on_one_computer_clears_the_conflict_on_every_computer() {
    // "Оставить обе": both files stay; the copy becomes a note of its own, so the other computer
    // must not keep showing a conflict for it either
    let env = Env::new();
    let (_a, b, sa, sb) = conflict_with_ids(&env);
    settle(&sa, &sb);
    let status = pass(&sa);
    assert_eq!(status.conflicts.len(), 1, "{:?}", status.conflicts);
    let (id, copy) = (
        status.conflicts[0].id.clone(),
        status.conflicts[0].copy_path.clone(),
    );
    sa.resolve_conflict(&id, ConflictChoice::KeepBoth).unwrap();
    settle(&sa, &sb);
    assert!(b.exists(&copy) && b.exists("Notes/n.md"), "both files stay");
    assert!(
        b.text(&copy)
            .is_some_and(|text| !text.contains("amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV")),
        "the copy got an identity of its own"
    );
    assert!(pass(&sb).conflicts.is_empty());
    assert!(pass(&sa).conflicts.is_empty());
    sa.stop();
    sb.stop();
}

#[test]
fn a_note_brought_back_after_a_deletion_here_is_reported_here() {
    // Р7 row 4 (Д37): this computer deleted the note, another computer edited it before the
    // deletion arrived. The edit wins and the note comes back. The computer that deleted it must
    // say so, whether or not the note is open, and say it once
    let env = Env::new();
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    a.put("Notes/n.md", b"base");
    // a second note keeps B's vault from looking empty (Д55) when its only note goes
    a.put("Notes/other.md", b"stays");
    let (sa, _) = env.start(&a, &env.account);
    let (sb, recorder_b) = env.start(&b, &env.another_computer("B"));
    settle(&sa, &sb);
    b.remove("Notes/n.md");
    pass(&sb); // the deletion goes up
    a.put("Notes/n.md", b"edited on a");
    pass(&sa); // the edit goes up and beats the deletion
    pass(&sb); // B receives the note again
    assert_eq!(b.text("Notes/n.md").as_deref(), Some("edited on a"));
    assert_eq!(
        recorder_b.restored_after_local_deletion(),
        vec!["Notes/n.md"]
    );
    pass(&sb);
    assert_eq!(
        recorder_b.restored_after_local_deletion(),
        vec!["Notes/n.md"]
    );
    sa.stop();
    sb.stop();
}
