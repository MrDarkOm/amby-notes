use super::*;
use crate::{
    vault_context::VaultContext,
    watcher::{self, WatcherState},
};
use std::fs::{self, File, FileTimes};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::time::{Duration, UNIX_EPOCH};
use ulid::Ulid;

struct TestVault(PathBuf);

impl TestVault {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("amby-incremental-{}", Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }
}

impl Drop for TestVault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn source(id: &str, body: &str) -> String {
    format!("---\namby-id: {id}\n---\n{body}")
}

fn write_at(path: &Path, content: &str, nanos: u32) {
    fs::write(path, content).unwrap();
    File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::new(1_700_000_000, nanos)))
        .unwrap();
}

fn search_count(conn: &rusqlite::Connection, query: &str) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM notes_fts WHERE notes_fts MATCH ?1",
        [query],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn incremental_same_second_same_size_change_updates_search() {
    let vault = TestVault::new();
    let path = vault.0.join("Note.md");
    let id = Ulid::generate().to_string();
    write_at(&path, &source(&id, "cat"), 100_000_000);
    let conn = open_connection(&vault.0).unwrap();
    sync_vault(&conn, &vault.0).unwrap();
    assert_eq!(search_count(&conn, "cat"), 1);

    write_at(&path, &source(&id, "dog"), 900_000_000);
    let result = sync_vault(&conn, &vault.0).unwrap();
    assert_eq!(result.updated, 1);
    assert_eq!(search_count(&conn, "cat"), 0);
    assert_eq!(search_count(&conn, "dog"), 1);
    assert_eq!(
        list_notes(&conn, &vault.0).unwrap()[0].modified,
        Some(1_700_000_000)
    );
    assert_eq!(sync_vault(&conn, &vault.0).unwrap().updated, 0);
}

#[test]
fn incremental_upsert_records_precise_stamp_for_subsequent_cold_scan() {
    let vault = TestVault::new();
    let path = vault.0.join("Note.md");
    let id = Ulid::generate().to_string();
    write_at(&path, &source(&id, "cat"), 100_000_000);
    let conn = open_connection(&vault.0).unwrap();
    sync_vault(&conn, &vault.0).unwrap();
    write_at(&path, &source(&id, "dog"), 900_000_000);
    upsert_note_index(&conn, &vault.0, &id, "dog", &path).unwrap();
    assert_eq!(sync_vault(&conn, &vault.0).unwrap().updated, 0);
    assert_eq!(search_count(&conn, "dog"), 1);
    assert_eq!(search_count(&conn, "cat"), 0);
}

#[test]
fn incremental_watcher_refreshes_search_tags_and_links_with_identical_metadata() {
    use notify::Watcher;
    let vault = TestVault::new();
    let path = vault.0.join("Note.md");
    let id = Ulid::generate().to_string();
    write_at(&path, &source(&id, "cat #old [[Cat]]"), 0);
    for name in ["Cat", "Dog"] {
        fs::write(
            vault.0.join(format!("{name}.md")),
            source(&Ulid::generate().to_string(), &format!("# {name}")),
        )
        .unwrap();
    }
    let context = VaultContext::new();
    context
        .activate(vault.0.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    let pending = context
        .with_active(|active| Ok(Arc::clone(&active.index_changes)))
        .unwrap();
    let state = WatcherState::new();
    let root = vault.0.clone();
    let (sender, receiver) = mpsc::channel();
    // The native notify backend cannot emit events from the macOS sandbox used
    // by the test runner. Polling with content comparison still exercises the
    // production event-to-invalidation path and, unlike metadata polling,
    // detects this deliberately same-size, same-mtime external edit.
    let mut watcher = notify::PollWatcher::new(
        move |event| {
            let changes =
                watcher::queue_external_changes(event, &root, &state.own_writes, 1, &pending);
            if changes
                .iter()
                .any(|change| change.path.ends_with("Note.md"))
            {
                let _ = sender.send(());
            }
        },
        notify::Config::default().with_compare_contents(true),
    )
    .unwrap();
    watcher
        .watch(&vault.0, notify::RecursiveMode::Recursive)
        .unwrap();
    let previous = fs::metadata(&path).unwrap();
    write_at(&path, &source(&id, "dog #new [[Dog]]"), 0);
    let next = fs::metadata(&path).unwrap();
    assert_eq!(previous.len(), next.len());
    assert_eq!(previous.modified().unwrap(), next.modified().unwrap());
    watcher.poll().unwrap();
    receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("watcher did not report external edit");
    drop(watcher);

    context.with_active(|active| {
        let loaded = active.refresh()?;
        assert_eq!(loaded.sync.updated, 1);
        assert_eq!(loaded.generation, 1);
        // Cat and Dog target notes remain searchable; only the source changes.
        assert_eq!(search_count(active, "cat"), 1);
        assert_eq!(search_count(active, "dog"), 2);
        let tag: String = active.query_row("SELECT tag FROM tags WHERE note_id = ?1", [&id], |row| row.get(0)).unwrap();
        assert_eq!(tag, "new");
        let target: String = active.query_row("SELECT n.path FROM links l JOIN notes n ON n.id = l.target_note_id WHERE l.note_id = ?1", [&id], |row| row.get(0)).unwrap();
        assert_eq!(target, "Dog.md");
        assert_eq!(fs::read_to_string(&path).unwrap(), source(&id, "dog #new [[Dog]]"));
        assert_eq!(active.refresh()?.sync.updated, 0);
        Ok(())
    }).unwrap();
}

#[test]
fn incremental_failed_refresh_keeps_watcher_invalidation_for_retry() {
    let vault = TestVault::new();
    let path = vault.0.join("Note.md");
    let id = Ulid::generate().to_string();
    write_at(&path, &source(&id, "cat"), 0);
    let context = VaultContext::new();
    context
        .activate(vault.0.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    write_at(&path, &source(&id, "dog"), 0);
    context.with_active(|active| {
        let state = WatcherState::new();
        watcher::queue_external_changes(Ok(notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Any)).add_path(path.clone())), &vault.0, &state.own_writes, 1, &active.index_changes);
        active.execute_batch("CREATE TEMP TRIGGER fail_refresh BEFORE UPDATE ON notes BEGIN SELECT RAISE(FAIL, 'injected index failure'); END;").unwrap();
        assert!(active.refresh().is_err());
        assert_eq!(search_count(active, "cat"), 1);
        assert_eq!(fs::read_to_string(&path).unwrap(), source(&id, "dog"));
        active.execute_batch("DROP TRIGGER fail_refresh").unwrap();
        assert_eq!(active.refresh()?.sync.updated, 1);
        assert_eq!(search_count(active, "dog"), 1);
        assert_eq!(active.refresh()?.sync.updated, 0);
        Ok(())
    }).unwrap();
}

#[test]
fn incremental_old_schema_upgrade_rechecks_content_without_changing_source() {
    let vault = TestVault::new();
    let path = vault.0.join("Note.md");
    let id = Ulid::generate().to_string();
    write_at(&path, &source(&id, "cat"), 0);
    let conn = open_connection(&vault.0).unwrap();
    sync_vault(&conn, &vault.0).unwrap();
    // Model the previous cache schema, with current-looking seconds and size.
    conn.execute_batch("ALTER TABLE notes DROP COLUMN mtime_ns; DELETE FROM index_metadata WHERE key = 'file_stamp_version';").unwrap();
    // A failed outcome write must roll back the column addition as well.
    conn.execute_batch("CREATE TEMP TRIGGER reject_stamp_version BEFORE INSERT ON index_metadata WHEN NEW.key = 'file_stamp_version' BEGIN SELECT RAISE(FAIL, 'injected schema failure'); END;").unwrap();
    assert!(init_schema(&conn).is_err());
    let added: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('notes') WHERE name = 'mtime_ns')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!added);
    assert_eq!(search_count(&conn, "cat"), 1);
    drop(conn);
    write_at(&path, &source(&id, "dog"), 0);
    let conn = open_connection(&vault.0).unwrap();
    init_schema(&conn).unwrap(); // Repeatable after a completed upgrade.
    assert_eq!(sync_vault(&conn, &vault.0).unwrap().updated, 1);
    assert_eq!(search_count(&conn, "dog"), 1);
    assert_eq!(fs::read_to_string(&path).unwrap(), source(&id, "dog"));
    assert_eq!(sync_vault(&conn, &vault.0).unwrap().updated, 0);
    let version: String = conn
        .query_row(
            "SELECT value FROM index_metadata WHERE key = 'file_stamp_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, "2");
}

#[test]
fn incremental_folder_and_rescan_events_override_identical_stamps() {
    let vault = TestVault::new();
    fs::create_dir(vault.0.join("Folder")).unwrap();
    fs::create_dir(vault.0.join("FolderOther")).unwrap();
    let context = VaultContext::new();
    let paths = [
        vault.0.join("Folder/A.md"),
        vault.0.join("FolderOther/B.md"),
    ];
    let ids = [Ulid::generate().to_string(), Ulid::generate().to_string()];
    for (path, id) in paths.iter().zip(&ids) {
        write_at(path, &source(id, "cat"), 0);
    }
    context
        .activate(vault.0.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    for (path, id) in paths.iter().zip(&ids) {
        write_at(path, &source(id, "dog"), 0);
    }
    context
        .with_active(|active| {
            let state = WatcherState::new();
            let folder_event = notify::Event::new(notify::EventKind::Modify(
                notify::event::ModifyKind::Metadata(notify::event::MetadataKind::WriteTime),
            ))
            .add_path(vault.0.join("Folder"));
            watcher::queue_external_changes(
                Ok(folder_event),
                &vault.0,
                &state.own_writes,
                1,
                &active.index_changes,
            );
            assert_eq!(active.refresh()?.sync.updated, 1);
            assert_eq!(search_count(active, "dog"), 1);
            assert_eq!(search_count(active, "cat"), 1); // Similar prefix is not a descendant.

            for event in [
                Ok(notify::Event::new(notify::EventKind::Other)
                    .set_flag(notify::event::Flag::Rescan)),
                Ok(notify::Event::new(notify::EventKind::Any)),
                Err(notify::Error::generic("lost events")),
            ] {
                let changes = watcher::queue_external_changes(
                    event,
                    &vault.0,
                    &state.own_writes,
                    1,
                    &active.index_changes,
                );
                assert_eq!(changes.len(), 1);
                assert_eq!(changes[0].path, vault.0.to_string_lossy());
                assert_eq!(active.refresh()?.sync.updated, 2);
                assert_eq!(search_count(active, "dog"), 2);
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn incremental_stale_self_write_record_does_not_hide_same_stamp_external_edit() {
    let vault = TestVault::new();
    let path = vault.0.join("Note.md");
    let id = Ulid::generate().to_string();
    write_at(&path, &source(&id, "cat"), 0);
    let context = VaultContext::new();
    context
        .activate(vault.0.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    let state = WatcherState::new();
    state
        .active_generation
        .store(1, std::sync::atomic::Ordering::Release);
    state.mark_write([&path]);
    let event = notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Any))
        .add_path(path.clone());
    context
        .with_active(|active| {
            assert!(watcher::queue_external_changes(
                Ok(event.clone()),
                &vault.0,
                &state.own_writes,
                1,
                &active.index_changes
            )
            .is_empty());
            assert_eq!(active.refresh()?.sync.updated, 0);
            write_at(&path, &source(&id, "dog"), 0);
            assert_eq!(
                watcher::queue_external_changes(
                    Ok(event),
                    &vault.0,
                    &state.own_writes,
                    1,
                    &active.index_changes
                )
                .len(),
                1
            );
            assert_eq!(active.refresh()?.sync.updated, 1);
            assert_eq!(search_count(active, "dog"), 1);
            Ok(())
        })
        .unwrap();
}

#[test]
fn incremental_pending_events_belong_to_one_vault_activation() {
    let first = TestVault::new();
    let second = TestVault::new();
    let context = VaultContext::new();
    context
        .activate(first.0.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    let old_pending = context
        .with_active(|active| Ok(Arc::clone(&active.index_changes)))
        .unwrap();
    context
        .activate(second.0.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    // A callback already in flight may still enqueue after the generation check.
    old_pending.lock().unwrap().insert(first.0.clone());
    context
        .with_active(|active| {
            assert!(active.index_changes.lock().unwrap().is_empty());
            assert_eq!(active.refresh()?.generation, 2);
            Ok(())
        })
        .unwrap();
}
