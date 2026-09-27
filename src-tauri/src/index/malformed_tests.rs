use super::*;
use std::{fs, path::PathBuf};
use ulid::Ulid;

struct Vault(PathBuf);
impl Vault {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("amby-malformed-{}", Ulid::generate()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Vault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn malformed_frontmatter_stays_visible_and_searchable_without_source_changes() {
    let vault = Vault::new();
    let cases = [
        ("list", "tags: [broken"),
        ("indent", "parent:\n  child: value\n bad: value"),
        ("scalar", "external scalar"),
        ("array", "- first\n- second"),
    ];
    for (name, yaml) in cases {
        fs::write(
            vault.0.join(format!("{name}.md")),
            format!("---\n{yaml}\n---\n# Searchable\nbodytoken #bodytag [[Target]]"),
        )
        .unwrap();
    }
    fs::write(
        vault.0.join("unclosed.md"),
        "---\ntags: [broken\n# Searchable\nbodytoken #bodytag [[Target]]",
    )
    .unwrap();
    let originals = fs::read_dir(&vault.0)
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            let text = fs::read(&path).unwrap();
            (path, text)
        })
        .collect::<Vec<_>>();
    let conn = open_connection(&vault.0).unwrap();
    for _ in 0..2 {
        let loaded = load_vault(&conn, &vault.0).unwrap();
        assert_eq!(loaded.notes.len(), 5);
        assert_eq!(loaded.tree.len(), 5);
        let found: i64 = conn
            .query_row(
                "SELECT count(*) FROM notes_fts WHERE notes_fts MATCH 'bodytoken'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(found, 5);
        for note in loaded.notes {
            assert!(read_note(&conn, &vault.0, &note.id)
                .unwrap()
                .content
                .contains("bodytoken"));
            assert!(note_properties(&conn, &vault.0, &note.id)
                .unwrap()
                .parse_error
                .is_some());
            assert!(
                !note_properties(&conn, &vault.0, &note.id)
                    .unwrap()
                    .body_read_only
            );
            assert_eq!(note.title, "Searchable");
            let tags: i64 = conn
                .query_row(
                    "SELECT count(*) FROM tags WHERE note_id = ?1 AND tag = 'bodytag'",
                    [&note.id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(tags, 1);
            let links: i64 = conn
                .query_row(
                    "SELECT count(*) FROM links WHERE note_id = ?1",
                    [&note.id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(links, 1);
        }
        for (path, bytes) in &originals {
            assert_eq!(fs::read(path).unwrap(), *bytes);
        }
    }
}

#[test]
fn malformed_body_save_preserves_yaml_bom_and_mixed_envelope_endings() {
    let vault = Vault::new();
    let path = vault.0.join("Broken.md");
    let envelope =
        "\u{feff}---\r\n# keep exactly\namby-id: untrusted\r\ntags: [bad #yamlonly\n---\r\n";
    let original = format!("{envelope}Old body\r\n");
    fs::write(&path, &original).unwrap();
    let conn = open_connection(&vault.0).unwrap();
    let note = load_vault(&conn, &vault.0).unwrap().notes.remove(0);
    let props = note_properties(&conn, &vault.0, &note.id).unwrap();
    assert_eq!(
        props.frontmatter_status,
        crate::model::FrontmatterStatus::Invalid
    );
    assert!(props.properties.is_empty());
    assert_eq!(note.title, "Broken");
    assert_eq!(note.word_count, 2);
    let read = read_note(&conn, &vault.0, &note.id).unwrap();
    let (saved_path, body, revision) = write_note_filesystem(
        &conn,
        &vault.0,
        &note.id,
        "New body #saved\n",
        &read.revision,
    )
    .unwrap();
    upsert_note_index(&conn, &vault.0, &note.id, &body, &saved_path).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        format!("{envelope}New body #saved\r\n")
    );
    assert_eq!(
        read_note(&conn, &vault.0, &note.id).unwrap().revision,
        revision
    );
    let snapshots = crate::history::list_snapshots(&vault.0, &path).unwrap();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(
        crate::history::read_snapshot_text(&vault.0, &snapshots[0].id)
            .unwrap()
            .content,
        original
    );
    assert!(crate::property_store::delete(&conn, &vault.0, &note.id, "any").is_err());
    assert!(!vault.0.join(".amby/properties.json").exists());
    let tags: Vec<String> = conn
        .prepare("SELECT tag FROM tags WHERE note_id = ?1")
        .unwrap()
        .query_map([&note.id], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(tags, ["saved"]);
    assert_eq!(load_vault(&conn, &vault.0).unwrap().notes[0].id, note.id);
}

#[test]
fn malformed_yaml_only_external_edit_rejects_stale_body_save() {
    let vault = Vault::new();
    let path = vault.0.join("Note.md");
    fs::write(&path, "---\ntags: [old\n---\nBody").unwrap();
    let conn = open_connection(&vault.0).unwrap();
    let id = load_vault(&conn, &vault.0).unwrap().notes[0].id.clone();
    let read = read_note(&conn, &vault.0, &id).unwrap();
    let external = "---\ntags: [new\n---\nBody";
    fs::write(&path, external).unwrap();
    let result = write_note_filesystem(&conn, &vault.0, &id, "Local change", &read.revision);
    assert!(matches!(
        result,
        Err(crate::model::WriteNoteError::RevisionConflict { .. })
    ));
    assert_eq!(fs::read_to_string(&path).unwrap(), external);
    assert!(crate::history::list_snapshots(&vault.0, &path)
        .unwrap()
        .is_empty());
}

#[test]
fn malformed_unterminated_source_can_be_edited_and_explicitly_repaired() {
    let vault = Vault::new();
    let path = vault.0.join("Note.md");
    let original = "\u{feff}---\r\ntitle: Example\r\n\r\nReadable body\r\n";
    fs::write(&path, original).unwrap();
    let conn = open_connection(&vault.0).unwrap();
    let id = load_vault(&conn, &vault.0).unwrap().notes[0].id.clone();
    let read = read_note(&conn, &vault.0, &id).unwrap();
    assert_eq!(read.content, original.replace("\r\n", "\n"));
    assert_eq!(
        note_properties(&conn, &vault.0, &id)
            .unwrap()
            .frontmatter_status,
        crate::model::FrontmatterStatus::Unterminated
    );
    let edited = read.content.replace("Readable", "Edited");
    let (_, _, revision) =
        write_note_filesystem(&conn, &vault.0, &id, &edited, &read.revision).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        original.replace("Readable", "Edited")
    );
    let fixed_id = Ulid::generate().to_string();
    let repaired = format!("---\namby-id: {fixed_id}\ntitle: Example\n---\nEdited body\n");
    write_note_filesystem(&conn, &vault.0, &id, &repaired, &revision).unwrap();
    let repaired_bytes = fs::read(&path).unwrap();
    let read = read_note(&conn, &vault.0, &id).unwrap();
    assert!(prepare_note_write(&conn, &vault.0, &id, "stale source tab", &read.revision).is_err());
    let loaded = load_vault(&conn, &vault.0).unwrap();
    assert_eq!(loaded.notes[0].id, fixed_id);
    assert_eq!(fs::read(&path).unwrap(), repaired_bytes);
    assert_eq!(
        read_note(&conn, &vault.0, &fixed_id).unwrap().content,
        "Edited body\n"
    );
}

#[test]
fn malformed_external_repair_invalidates_opaque_write_permission() {
    let vault = Vault::new();
    let path = vault.0.join("Note.md");
    fs::write(&path, "---\ntags: [bad\n---\nBody").unwrap();
    let conn = open_connection(&vault.0).unwrap();
    let old_id = load_vault(&conn, &vault.0).unwrap().notes[0].id.clone();
    let repaired_id = Ulid::generate().to_string();
    let repaired = format!("---\namby-id: {repaired_id}\n---\nBody");
    fs::write(&path, &repaired).unwrap();
    let current = read_note(&conn, &vault.0, &old_id).unwrap();
    assert!(prepare_note_write(&conn, &vault.0, &old_id, "Edit", &current.revision).is_err());
    assert!(
        note_properties(&conn, &vault.0, &old_id)
            .unwrap()
            .body_read_only
    );
    assert_eq!(
        load_vault(&conn, &vault.0).unwrap().notes[0].id,
        repaired_id
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), repaired);
}

#[test]
fn malformed_refactor_updates_body_links_without_touching_yaml() {
    let vault = Vault::new();
    let path = vault.0.join("Broken.md");
    let envelope = "\u{feff}---\r\nref: [[Old]]\nlist: [bad\r\n---\n";
    fs::write(&path, format!("{envelope}See [[Old]] and [link](Old.md)\n")).unwrap();
    let unclosed = vault.0.join("Unclosed.md");
    let unclosed_source = "---\nref: [[Old]]\nMaybe body [[Old]]";
    fs::write(&unclosed, unclosed_source).unwrap();
    let plan = [&path, &unclosed].map(|path| PlannedWikiRewrite {
        source_path: path.clone(),
        replacements: vec![("Old".into(), "New".into())],
        literal_replacements: vec![("](Old.md)".into(), "](New.md)".into())],
    });
    assert_eq!(
        apply_planned_wiki_rewrites(&vault.0, &plan).unwrap(),
        [path.clone()]
    );
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        format!("{envelope}See [[New]] and [link](New.md)\n")
    );
    assert_eq!(fs::read_to_string(unclosed).unwrap(), unclosed_source);
}

#[test]
fn malformed_restore_and_move_use_path_keys_without_writing_ids() {
    let vault = Vault::new();
    let old = vault.0.join("Old.md");
    let next = vault.0.join("New.md");
    let source = "---\n- root array\n---\nBody";
    fs::write(&old, source).unwrap();
    let conn = open_connection(&vault.0).unwrap();
    let old_id = load_vault(&conn, &vault.0).unwrap().notes[0].id.clone();
    fs::rename(&old, &next).unwrap();
    let prepared = prepare_path_changes(
        &conn,
        &vault.0,
        &[crate::model::PathChange {
            old_path: old.to_string_lossy().into(),
            new_path: next.to_string_lossy().into(),
        }],
    )
    .unwrap();
    assert_ne!(prepared[0].note_id, old_id);
    assert_eq!(fs::read_to_string(&next).unwrap(), source);
    assert!(prepare_opaque_note_text(&vault.0, &next, &old_id, source, "Bad key").is_err());
    let restored =
        prepare_opaque_note_text(&vault.0, &next, &prepared[0].note_id, source, "Restored")
            .unwrap();
    fs::remove_file(&next).unwrap();
    crate::frontmatter::atomic_write_bytes_new(&next, restored.as_bytes()).unwrap();
    assert_eq!(
        fs::read_to_string(&next).unwrap(),
        "---\n- root array\n---\nRestored"
    );
    assert!(matches!(
        crate::frontmatter::atomic_write_bytes_new(&next, b"overwrite"),
        Err(crate::frontmatter::AtomicCreateError::AlreadyExists)
    ));
    assert_eq!(
        load_vault(&conn, &vault.0).unwrap().notes[0].id,
        prepared[0].note_id
    );
}

#[test]
fn malformed_properties_are_blocked_even_before_watcher_refresh() {
    let vault = Vault::new();
    let path = vault.0.join("Note.md");
    let id = Ulid::generate().to_string();
    fs::write(&path, format!("---\namby-id: {id}\n---\nBody")).unwrap();
    let conn = open_connection(&vault.0).unwrap();
    load_vault(&conn, &vault.0).unwrap();
    fs::write(&path, format!("---\namby-id: {id}\nlist: [bad\n---\nBody")).unwrap();
    assert!(crate::property_store::delete(&conn, &vault.0, &id, "prop").is_err());
    assert!(!vault.0.join(".amby/properties.json").exists());
}

#[test]
fn malformed_warnings_acknowledge_events_but_read_failures_preserve_the_index() {
    let vault = Vault::new();
    let path = vault.0.join("Note.md");
    fs::write(&path, "---\nlist: [bad\n---\nOriginal").unwrap();
    let context = crate::vault_context::VaultContext::new();
    context
        .activate(vault.0.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    context
        .with_active(|active| {
            let path = active.root.join("Note.md");
            let edited = "---\nlist: [bad\n---\nEdited";
            fs::write(&path, edited).unwrap();
            active.index_changes.lock().unwrap().insert(path.clone());
            let loaded = active.refresh()?;
            assert!(!loaded.sync.warnings.is_empty());
            assert_eq!(loaded.notes.len(), 1);
            assert!(active.index_changes.lock().unwrap().is_empty());

            fs::write(&path, [0xff, 0xfe]).unwrap();
            active.index_changes.lock().unwrap().insert(path.clone());
            assert!(active.refresh().is_err());
            assert!(active.index_changes.lock().unwrap().contains(&path));
            let cached: String = active
                .query_row("SELECT content FROM notes", [], |row| row.get(0))
                .unwrap();
            assert_eq!(cached, "Edited");
            assert_eq!(fs::read(&path).unwrap(), [0xff, 0xfe]);

            fs::write(&path, edited).unwrap();
            assert_eq!(active.refresh()?.notes.len(), 1);
            assert!(active.index_changes.lock().unwrap().is_empty());
            Ok(())
        })
        .unwrap();
}
