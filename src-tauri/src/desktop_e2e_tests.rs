//! Small reliability suite for the desktop storage path.
//!
//! These tests deliberately use a real, disposable vault, the persistent SQLite
//! index, `VaultContext`, atomic note writes, and the watcher invalidation queue.
//! They are not browser-storage tests: the same backend lifecycle is used by the
//! Tauri IPC commands. UI-only interaction remains covered by the focused
//! frontend lifecycle tests; keeping this harness backend-driven makes it
//! deterministic on CI without requiring a native file-picker or a user vault.

use crate::{
    frontmatter,
    index::{self, note_index::body_revision},
    vault_context::VaultContext,
    watcher::{self, WatcherState},
};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Instant,
};
use ulid::Ulid;

struct DesktopVault(PathBuf);

impl DesktopVault {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("amby-desktop-e2e-{name}-{}", Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }

    fn note(&self, name: &str, body: &str) -> (PathBuf, String) {
        let id = Ulid::generate().to_string();
        let path = self.0.join(name);
        fs::write(&path, source(&id, body)).unwrap();
        (path, id)
    }
}

impl Drop for DesktopVault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn source(id: &str, body: &str) -> String {
    format!("---\namby-id: {id}\n---\n{body}")
}

fn activate(context: &VaultContext, root: &Path) {
    context
        .activate(root.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
}

/// Mirrors the durable part of the `write_note` IPC command after it has
/// checked the active vault generation. Keeping this here lets the test run
/// against a real vault without creating a GUI window in `cargo test`.
fn save(context: &VaultContext, note_id: &str, body: &str) -> String {
    context
        .with_active(|active| {
            let current = index::read_note(active, &active.root, note_id)?;
            let metadata = index::note_metadata(active, &active.root, note_id)?;
            let (_, saved_body, revision) = index::write_note_filesystem(
                active,
                &active.root,
                note_id,
                body,
                &current.revision,
            )
            .map_err(|error| format!("note save failed: {error:?}"))?;
            index::upsert_note_index(
                active,
                &active.root,
                note_id,
                &saved_body,
                Path::new(&metadata.path),
            )?;
            Ok(revision)
        })
        .unwrap()
}

fn queue_change(context: &VaultContext, root: &Path, path: PathBuf) {
    context
        .with_active(|active| {
            let state = WatcherState::new();
            watcher::queue_external_changes(
                Ok(notify::Event::new(notify::EventKind::Any).add_path(path)),
                root,
                &state.own_writes,
                active.generation,
                &active.index_changes,
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn desktop_e2e_save_close_reopen_preserves_content() {
    let vault = DesktopVault::new("save-reopen");
    let (_, id) = vault.note("Note.md", "before");
    let first = VaultContext::new();
    activate(&first, &vault.0);

    save(&first, &id, "saved through autosave");
    drop(first); // Equivalent backend state to closing the last desktop window.

    let reopened = VaultContext::new();
    activate(&reopened, &vault.0);
    reopened
        .with_active(|active| {
            let note = index::read_note(active, &active.root, &id)?;
            assert_eq!(note.content, "saved through autosave");
            Ok(())
        })
        .unwrap();
}

#[test]
fn desktop_e2e_flush_before_rename_leaves_one_current_file() {
    let vault = DesktopVault::new("rename-autosave");
    let (old, id) = vault.note("Draft.md", "before");
    let context = VaultContext::new();
    activate(&context, &vault.0);

    // The renderer's rename lifecycle flushes its queued autosave before the
    // mutation publishes the rename. Assert that ordering against real files.
    save(&context, &id, "final autosave content");
    let renamed = vault.0.join("Renamed.md");
    fs::rename(&old, &renamed).unwrap();
    queue_change(&context, &vault.0, old.clone());
    queue_change(&context, &vault.0, renamed.clone());
    context
        .with_active(|active| {
            active.refresh()?;
            assert!(!old.exists(), "a stale autosave recreated the old path");
            assert_eq!(
                fs::read_to_string(&renamed).unwrap(),
                source(&id, "final autosave content")
            );
            assert_eq!(index::note_path_for_id(active, &active.root, &id)?, renamed);
            Ok(())
        })
        .unwrap();
}

#[test]
fn desktop_e2e_switching_vault_rejects_old_generation_and_keeps_flush() {
    let first_vault = DesktopVault::new("switch-first");
    let (_, first_id) = first_vault.note("First.md", "first");
    let second_vault = DesktopVault::new("switch-second");
    let (_, second_id) = second_vault.note("Second.md", "second");
    let context = VaultContext::new();
    activate(&context, &first_vault.0);
    let old_generation = context.generation().unwrap();

    save(&context, &first_id, "flushed before switching");
    activate(&context, &second_vault.0);
    assert!(context.generation().unwrap() > old_generation);
    context
        .with_active(|active| {
            assert!(index::note_metadata(active, &active.root, &first_id).is_err());
            assert_eq!(
                index::read_note(active, &active.root, &second_id)?.content,
                "second"
            );
            Ok(())
        })
        .unwrap();

    let reopened = VaultContext::new();
    activate(&reopened, &first_vault.0);
    reopened
        .with_active(|active| {
            assert_eq!(
                index::read_note(active, &active.root, &first_id)?.content,
                "flushed before switching"
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn desktop_e2e_external_edit_delete_and_rename_refresh_the_index() {
    let vault = DesktopVault::new("external-events");
    let (path, id) = vault.note("Watched.md", "old searchable text");
    let context = VaultContext::new();
    activate(&context, &vault.0);

    fs::write(&path, source(&id, "new searchable text #changed")).unwrap();
    queue_change(&context, &vault.0, path.clone());
    context
        .with_active(|active| {
            active.refresh()?;
            assert_eq!(
                index::search_notes(active, &active.root, "new searchable")?.len(),
                1
            );
            assert!(index::search_notes(active, &active.root, "old searchable")
                .unwrap()
                .is_empty());
            Ok(())
        })
        .unwrap();

    let renamed = vault.0.join("ExternallyRenamed.md");
    fs::rename(&path, &renamed).unwrap();
    queue_change(&context, &vault.0, path.clone());
    queue_change(&context, &vault.0, renamed.clone());
    context
        .with_active(|active| {
            active.refresh()?;
            assert_eq!(index::note_path_for_id(active, &active.root, &id)?, renamed);
            Ok(())
        })
        .unwrap();

    fs::remove_file(&renamed).unwrap();
    queue_change(&context, &vault.0, renamed);
    context
        .with_active(|active| {
            active.refresh()?;
            assert!(index::note_metadata(active, &active.root, &id).is_err());
            Ok(())
        })
        .unwrap();
}

#[test]
fn desktop_e2e_lossless_envelopes_and_identity_conflicts_survive_save() {
    let vault = DesktopVault::new("lossless");
    let id = Ulid::generate().to_string();
    let path = vault.0.join("Lossless.md");
    let original = format!(
        "\u{feff}---\r\namby-id: {id}\r\nid: jira-123\r\n---\r\n<!-- unsupported -->\r\n::: custom\r\nkeep me\r\n:::\r\nold body\r\n"
    );
    fs::write(&path, &original).unwrap();
    let duplicate_id = Ulid::generate().to_string();
    let duplicate = vault.0.join("Duplicate.md");
    fs::write(&duplicate, source(&duplicate_id, "first duplicate")).unwrap();
    let duplicate_copy = vault.0.join("Duplicate-copy.md");
    fs::write(
        &duplicate_copy,
        source(&duplicate_id, "duplicate stays visible"),
    )
    .unwrap();
    let context = VaultContext::new();
    activate(&context, &vault.0);

    // The rich editor retains opaque Markdown while changing the supported
    // region. Its LF buffer is deliberately written through the desktop path.
    save(
        &context,
        &id,
        "<!-- unsupported -->\n::: custom\nkeep me\n:::\nedited body\n",
    );
    let persisted = fs::read(&path).unwrap();
    assert!(persisted.starts_with(&[0xEF, 0xBB, 0xBF]));
    let text = String::from_utf8(persisted).unwrap();
    assert!(text.contains("id: jira-123\r\n"));
    assert!(text.contains("<!-- unsupported -->\r\n::: custom\r\nkeep me\r\n:::\r\n"));
    assert!(!text.replace("\r\n", "").contains('\n'));
    assert_eq!(
        frontmatter::parse_markdown(&text).body,
        "<!-- unsupported -->\r\n::: custom\r\nkeep me\r\n:::\r\nedited body\r\n"
    );
    assert_eq!(
        body_revision("<!-- unsupported -->\r\n::: custom\r\nkeep me\r\n:::\r\nedited body\r\n"),
        context
            .with_active(|active| Ok(index::read_note(active, &active.root, &id)?.revision))
            .unwrap()
    );
    // The duplicate source is still present; the index gives it a cache-only
    // conflict key instead of deleting or overwriting either user file.
    assert_eq!(
        fs::read_to_string(&duplicate_copy).unwrap(),
        source(&duplicate_id, "duplicate stays visible")
    );
}

#[test]
#[ignore = "regression signal; run with npm run test:e2e:large"]
fn desktop_e2e_large_vault_smoke_reports_scan_reopen_update_and_search() {
    let count = std::env::var("AMBY_E2E_LARGE_VAULT_SIZE")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1_000usize);
    assert!(
        [1_000, 5_000, 10_000].contains(&count),
        "use 1000, 5000, or 10000 notes"
    );
    let vault = DesktopVault::new("large");
    for number in 0..count {
        vault.note(
            &format!("Note-{number:05}.md"),
            &format!("synthetic token-{number}"),
        );
    }
    let context = VaultContext::new();
    let scan_started = Instant::now();
    activate(&context, &vault.0);
    let initial_scan = scan_started.elapsed();
    let reopen_started = Instant::now();
    let reopened = VaultContext::new();
    activate(&reopened, &vault.0);
    let reopen = reopen_started.elapsed();
    let update_started = Instant::now();
    let path = vault.0.join("Note-00000.md");
    fs::write(
        &path,
        fs::read_to_string(&path)
            .unwrap()
            .replace("token-0", "updated-token"),
    )
    .unwrap();
    queue_change(&reopened, &vault.0, path);
    reopened
        .with_active(|active| active.refresh().map(|_| ()))
        .unwrap();
    let one_file_update = update_started.elapsed();
    let search_started = Instant::now();
    reopened
        .with_active(|active| Ok(index::search_notes(active, &active.root, "updated-token")?))
        .unwrap();
    eprintln!("desktop-e2e large-vault notes={count} initial_scan={initial_scan:?} reopen={reopen:?} one_file_update={one_file_update:?} search={:?}", search_started.elapsed());
}
