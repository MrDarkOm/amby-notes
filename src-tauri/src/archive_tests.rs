//! The archive (docs/sync-plan.md, appendix К: К1, К4, К6, К8) on a real folder. Written before the
//! code (section 6): every test is red on the `todo!()` stubs of `archive.rs`. Each test names the
//! requirement it holds and looks only at what is visible from outside: files on disk and the
//! answers of the functions.

use std::fs;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::test_support::{FakeTrash, Vault};
use super::*;
use crate::recycle_bin;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn entry_of(vault: &Vault, original_path: &str) -> ArchiveEntry {
    list(&vault.root)
        .into_iter()
        .find(|entry| entry.original_path == original_path)
        .unwrap_or_else(|| panic!("{original_path} is not in the archive list"))
}

fn originals(vault: &Vault) -> Vec<String> {
    let mut paths: Vec<String> = list(&vault.root)
        .into_iter()
        .map(|entry| entry.original_path)
        .collect();
    paths.sort();
    paths
}

// ----- К1: «В архив» -----

#[test]
fn k1_a_file_moves_to_the_archive_and_keeps_its_path() {
    // К1: `.amby/archive/<прежний путь>`; the old trash is not used for it.
    let vault = Vault::new();
    let path = vault.put("Notes/a.md", b"archive me");
    move_to_archive(&vault.root, &path).unwrap();
    assert!(!vault.exists("Notes/a.md"), "the file left its place");
    assert_eq!(
        vault.read(".amby/archive/Notes/a.md").as_deref(),
        Some(&b"archive me"[..])
    );
    assert!(
        recycle_bin::list(&vault.root).is_empty(),
        "К1, К5: not the trash"
    );
    assert!(!vault.exists(".amby/trash"));
}

#[test]
fn k1_a_folder_moves_with_all_its_files_and_keeps_its_paths() {
    // К1: "файл (или папку)": the paths inside repeat the paths in the vault.
    let vault = Vault::new();
    vault.put("Proj/a.md", b"a");
    vault.put("Proj/sub/b.md", b"b");
    vault.put("Proj/sub/deeper/c.bin", &[0, 1, 2, 3]);
    move_to_archive(&vault.root, &vault.path("Proj")).unwrap();
    assert!(!vault.exists("Proj"));
    let archived = vault.archived();
    assert_eq!(
        archived.get("Proj/a.md").map(Vec::as_slice),
        Some(&b"a"[..])
    );
    assert_eq!(
        archived.get("Proj/sub/b.md").map(Vec::as_slice),
        Some(&b"b"[..])
    );
    assert_eq!(
        archived.get("Proj/sub/deeper/c.bin").map(Vec::as_slice),
        Some(&[0u8, 1, 2, 3][..])
    );
}

#[test]
fn k1_a_path_outside_the_vault_or_inside_amby_is_refused_and_nothing_moves() {
    // К1: only things of the vault go to the archive; `.amby/` is not the person's.
    let vault = Vault::new();
    let other = Vault::new();
    let outside = other.put("x.md", b"not yours");
    assert!(move_to_archive(&vault.root, &outside).is_err());
    assert_eq!(other.read("x.md").as_deref(), Some(&b"not yours"[..]));
    let service = vault.put(".amby/properties.json", b"{}");
    assert!(move_to_archive(&vault.root, &service).is_err());
    assert_eq!(
        vault.read(".amby/properties.json").as_deref(),
        Some(&b"{}"[..])
    );
    assert!(vault.archived().is_empty());
}

#[test]
fn k1_a_taken_place_in_the_archive_is_never_overwritten() {
    // К1, data safety: the same path archived twice keeps both contents (the name of the second
    // is not fixed by the plan: see the question in the report).
    let vault = Vault::new();
    vault.put(".amby/archive/Notes/a.md", b"the first, archived earlier");
    let path = vault.put("Notes/a.md", b"the second");
    move_to_archive(&vault.root, &path).unwrap();
    assert!(!vault.exists("Notes/a.md"));
    let contents: Vec<Vec<u8>> = vault.archived().into_values().collect();
    assert_eq!(contents.len(), 2, "{contents:?}");
    assert!(contents.contains(&b"the first, archived earlier".to_vec()));
    assert!(contents.contains(&b"the second".to_vec()));
    assert_eq!(
        vault.read(".amby/archive/Notes/a.md").as_deref(),
        Some(&b"the first, archived earlier"[..]),
        "the old place keeps the old file"
    );
}

// ----- К8: the record of the time -----

#[test]
fn k8_a_move_writes_one_record_per_file_with_path_and_time() {
    // К8: `.amby/archive/.meta/<id>.json` `{path, archivedAtMs}` for each file.
    let vault = Vault::new();
    vault.put("Proj/a.md", b"a");
    vault.put("Proj/sub/b.md", b"b");
    let before = now_ms();
    move_to_archive(&vault.root, &vault.path("Proj")).unwrap();
    let after = now_ms();
    let metas = vault.metas();
    let paths: Vec<&str> = metas.iter().map(|(path, _)| path.as_str()).collect();
    assert_eq!(paths, vec!["Proj/a.md", "Proj/sub/b.md"]);
    for (_, archived_at) in &metas {
        assert!(
            (before..=after).contains(archived_at),
            "{archived_at} not in {before}..={after}"
        );
    }
    for (name, bytes) in vault.files() {
        if name.starts_with(".amby/archive/.meta/") {
            assert!(name.ends_with(".json"), "{name}");
            let meta = ArchiveMeta::parse(&bytes).unwrap();
            assert!(meta.extra.is_empty(), "no stray fields: {meta:?}");
        }
    }
}

#[test]
fn k8_the_keys_of_a_record_are_path_and_archived_at_ms() {
    let meta = ArchiveMeta {
        path: "Notes/a.md".to_string(),
        archived_at_ms: 1_700_000_000_123,
        extra: serde_json::Map::new(),
    };
    let value: serde_json::Value = serde_json::from_slice(&meta.to_bytes()).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"path": "Notes/a.md", "archivedAtMs": 1_700_000_000_123u64})
    );
    assert_eq!(ArchiveMeta::parse(&meta.to_bytes()).unwrap(), meta);
}

#[test]
fn k8_fields_of_a_record_that_the_code_does_not_know_are_kept() {
    // К8: "Неизвестные поля записи сохраняются" (a newer version may add fields).
    let bytes = br#"{"path":"a.md","archivedAtMs":5,"future":{"x":[1,2,"three"]},"tag":null}"#;
    let meta = ArchiveMeta::parse(bytes).unwrap();
    assert_eq!(meta.path, "a.md");
    assert_eq!(meta.archived_at_ms, 5);
    let written: serde_json::Value = serde_json::from_slice(&meta.to_bytes()).unwrap();
    assert_eq!(
        written,
        serde_json::json!({"path":"a.md","archivedAtMs":5,"future":{"x":[1,2,"three"]},"tag":null})
    );
}

#[test]
fn k8_a_record_without_the_required_keys_is_an_error_not_a_guess() {
    assert!(ArchiveMeta::parse(b"{}").is_err());
    assert!(ArchiveMeta::parse(b"not json").is_err());
    assert!(ArchiveMeta::parse(br#"{"path":"a.md"}"#).is_err());
}

#[test]
fn k8_the_list_shows_the_time_of_the_record() {
    let vault = Vault::new();
    vault.put(".amby/archive/Notes/a.md", b"x");
    vault.put(
        ".amby/archive/.meta/rec-1.json",
        br#"{"path":"Notes/a.md","archivedAtMs":1234567,"future":true}"#,
    );
    assert_eq!(entry_of(&vault, "Notes/a.md").archived_at_ms, 1_234_567);
}

#[test]
fn k8_without_a_record_the_time_of_the_file_is_shown() {
    // К8: "нет записи (файл пришёл извне) — время файла".
    let vault = Vault::new();
    let path = vault.put(".amby/archive/From/outside.md", b"x");
    let when = UNIX_EPOCH + Duration::from_millis(1_600_000_000_000);
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(when)
        .unwrap();
    assert_eq!(
        entry_of(&vault, "From/outside.md").archived_at_ms,
        1_600_000_000_000
    );
}

// ----- К6: the list -----

#[test]
fn k6_the_list_has_only_the_files_of_the_archive() {
    // К6: not the trash, not the records of К8; a file with its folders.
    let vault = Vault::new();
    vault.put(".amby/archive/Notes/a.md", b"a");
    vault.put(".amby/archive/Proj/sub/b.md", b"b");
    vault.put(
        ".amby/archive/.meta/rec.json",
        br#"{"path":"Notes/a.md","archivedAtMs":1}"#,
    );
    let trashed = vault.put("Gone/trashed.md", b"in the old trash");
    recycle_bin::move_to_trash(&vault.root, &trashed).unwrap();
    assert_eq!(originals(&vault), vec!["Notes/a.md", "Proj/sub/b.md"]);
    let entry = entry_of(&vault, "Proj/sub/b.md");
    assert_eq!(entry.name, "b.md");
}

#[test]
fn k6_the_list_of_a_vault_without_an_archive_is_empty() {
    let vault = Vault::new();
    assert!(list(&vault.root).is_empty());
}

// ----- К6: «Вернуть» -----

#[test]
fn k6_restore_puts_the_file_back_and_makes_the_missing_folders() {
    let vault = Vault::new();
    vault.put(".amby/archive/Deep/er/a.md", b"back");
    let id = entry_of(&vault, "Deep/er/a.md").id;
    let result = restore(&vault.root, &id).unwrap();
    assert_eq!(vault.read("Deep/er/a.md").as_deref(), Some(&b"back"[..]));
    assert!(vault.archived().is_empty());
    assert_eq!(
        result.primary_path.as_deref().map(std::path::Path::new),
        Some(vault.path("Deep/er/a.md").as_path())
    );
}

#[test]
fn k6_restore_never_replaces_a_taken_path_and_takes_a_free_name() {
    // К6: "путь занят — рядом под свободным именем (free_path, как И15)": `Name 2.md`, `Name 3.md`.
    let vault = Vault::new();
    vault.put("Notes/a.md", b"mine, written meanwhile");
    vault.put(".amby/archive/Notes/a.md", b"archived one");
    let id = entry_of(&vault, "Notes/a.md").id;
    let result = restore(&vault.root, &id).unwrap();
    assert_eq!(
        vault.read("Notes/a.md").as_deref(),
        Some(&b"mine, written meanwhile"[..]),
        "the existing file is untouched"
    );
    assert_eq!(
        vault.read("Notes/a 2.md").as_deref(),
        Some(&b"archived one"[..])
    );
    assert_eq!(
        result.primary_path.as_deref().map(std::path::Path::new),
        Some(vault.path("Notes/a 2.md").as_path()),
        "the final name is told to the person"
    );
    // The same again: the next free name.
    vault.put(".amby/archive/Notes/a.md", b"third");
    let id = entry_of(&vault, "Notes/a.md").id;
    restore(&vault.root, &id).unwrap();
    assert_eq!(vault.read("Notes/a 3.md").as_deref(), Some(&b"third"[..]));
    assert_eq!(
        vault.read("Notes/a 2.md").as_deref(),
        Some(&b"archived one"[..])
    );
}

#[test]
fn k6_a_restored_file_is_gone_from_the_list_with_its_record() {
    let vault = Vault::new();
    let path = vault.put("Notes/a.md", b"x");
    move_to_archive(&vault.root, &path).unwrap();
    let id = entry_of(&vault, "Notes/a.md").id;
    restore(&vault.root, &id).unwrap();
    assert!(list(&vault.root).is_empty());
    assert!(
        vault.metas().is_empty(),
        "no record of a file that is not archived any more"
    );
    assert_eq!(vault.read("Notes/a.md").as_deref(), Some(&b"x"[..]));
}

#[test]
fn k6_restoring_what_is_not_in_the_archive_is_an_error_and_changes_nothing() {
    let vault = Vault::new();
    vault.put("Notes/a.md", b"x");
    assert!(restore(&vault.root, "no-such-entry").is_err());
    assert!(restore(&vault.root, "../../Notes/a.md").is_err());
    assert_eq!(vault.read("Notes/a.md").as_deref(), Some(&b"x"[..]));
}

#[test]
fn k1_k6_an_archived_file_restores_to_where_it_was() {
    // К1: the path inside the archive repeats the path in the vault, so «Вернуть» puts the file on
    // its former place.
    let vault = Vault::new();
    let path = vault.put("Мир/Черновик.md", "тело".as_bytes());
    move_to_archive(&vault.root, &path).unwrap();
    let id = entry_of(&vault, "Мир/Черновик.md").id;
    restore(&vault.root, &id).unwrap();
    assert_eq!(
        vault.read("Мир/Черновик.md").as_deref(),
        Some("тело".as_bytes())
    );
}

// ----- К6, К4: «Удалить из архива» -----

#[test]
fn k6_delete_from_the_archive_by_the_setting_system_and_archive_mean_the_system_trash() {
    // К6: "по настройке К4 (вариант «Переносить в архив» здесь значит «в системную корзину»)".
    for mode in [DeleteMode::System, DeleteMode::Archive] {
        let vault = Vault::new();
        vault.put(".amby/archive/Notes/a.md", b"archived");
        vault.put(
            ".amby/archive/.meta/rec.json",
            br#"{"path":"Notes/a.md","archivedAtMs":1}"#,
        );
        let trash = FakeTrash::taking();
        let id = entry_of(&vault, "Notes/a.md").id;
        purge(&vault.root, &id, mode, &trash).unwrap();
        assert_eq!(
            trash.asked(),
            vec![vault.path(".amby/archive/Notes/a.md")],
            "{mode:?}: the file itself goes to the system trash"
        );
        assert!(list(&vault.root).is_empty(), "{mode:?}");
        assert!(
            vault.metas().is_empty(),
            "{mode:?}: the record goes with the file"
        );
        assert_eq!(
            trash.held().values().next().map(Vec::as_slice),
            Some(&b"archived"[..])
        );
    }
}

#[test]
fn k6_delete_from_the_archive_permanently_keeps_no_copy_and_asks_no_trash() {
    let vault = Vault::new();
    vault.put(".amby/archive/Notes/a.md", b"to be removed for good");
    let trash = FakeTrash::taking();
    let id = entry_of(&vault, "Notes/a.md").id;
    purge(&vault.root, &id, DeleteMode::Permanent, &trash).unwrap();
    assert!(trash.asked().is_empty());
    assert!(list(&vault.root).is_empty());
    assert!(
        !vault
            .files()
            .values()
            .any(|bytes| bytes == b"to be removed for good"),
        "no copy is left anywhere in the vault"
    );
}

#[test]
fn k6_a_refusing_system_trash_loses_nothing() {
    // Data safety: if the trash cannot take the file, it stays in the archive and the answer is an
    // error (the plan does not say it: see the question in the report).
    for mode in [DeleteMode::System, DeleteMode::Archive] {
        let vault = Vault::new();
        vault.put(".amby/archive/Notes/a.md", b"keep me");
        let trash = FakeTrash::refusing();
        let id = entry_of(&vault, "Notes/a.md").id;
        assert!(purge(&vault.root, &id, mode, &trash).is_err(), "{mode:?}");
        assert_eq!(
            vault.read(".amby/archive/Notes/a.md").as_deref(),
            Some(&b"keep me"[..])
        );
        assert_eq!(originals(&vault), vec!["Notes/a.md"]);
    }
}

#[test]
fn k6_the_preview_of_an_archived_note_is_its_text() {
    let vault = Vault::new();
    vault.put(".amby/archive/Notes/a.md", "Привет, архив".as_bytes());
    let id = entry_of(&vault, "Notes/a.md").id;
    let preview = read_preview(&vault.root, &id, "").unwrap();
    assert!(!preview.directory);
    assert_eq!(preview.text.as_deref(), Some("Привет, архив"));
}

// ----- К4: the setting -----

#[test]
fn k4_the_three_values_of_the_setting_and_the_old_one() {
    // К4: system (default), archive, permanent; the old `vault` is read as «Переносить в архив».
    assert_eq!(DeleteMode::default(), DeleteMode::System);
    for (text, mode) in [
        ("\"system\"", DeleteMode::System),
        ("\"archive\"", DeleteMode::Archive),
        ("\"permanent\"", DeleteMode::Permanent),
        ("\"vault\"", DeleteMode::Archive),
    ] {
        assert_eq!(
            serde_json::from_str::<DeleteMode>(text).unwrap(),
            mode,
            "{text}"
        );
    }
    assert_eq!(
        serde_json::to_string(&DeleteMode::Archive).unwrap(),
        "\"archive\""
    );
    assert!(serde_json::from_str::<DeleteMode>("\"wipe\"").is_err());
}

fn active(vault: &Vault) -> crate::vault_context::VaultContext {
    let context = crate::vault_context::VaultContext::new();
    context
        .activate(vault.root.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    context
}

#[test]
fn k4_delete_with_the_archive_setting_does_what_the_archive_action_does() {
    // К4: «Переносить в архив» — «Удалить» делает то же, что «В архив» (К1).
    let vault = Vault::new();
    vault.put("Notes/a.md", b"deleted into the archive");
    let context = active(&vault);
    crate::commands::mutations::delete_item_inner(
        &context,
        &crate::watcher::WatcherState::new(),
        vault.path("Notes/a.md").to_string_lossy().to_string(),
        DeleteMode::Archive,
    )
    .unwrap();
    assert!(!vault.exists("Notes/a.md"));
    assert_eq!(
        vault.read(".amby/archive/Notes/a.md").as_deref(),
        Some(&b"deleted into the archive"[..])
    );
    assert!(
        recycle_bin::list(&vault.root).is_empty(),
        "not the old trash"
    );
}

#[test]
fn k1_the_archive_action_of_the_command_writes_the_archive() {
    let vault = Vault::new();
    vault.put("Notes/a.md", b"archived by the command");
    let context = active(&vault);
    crate::commands::mutations::archive_item_inner(
        &context,
        &crate::watcher::WatcherState::new(),
        vault.path("Notes/a.md").to_string_lossy().to_string(),
    )
    .unwrap();
    assert!(!vault.exists("Notes/a.md"));
    assert_eq!(
        vault.read(".amby/archive/Notes/a.md").as_deref(),
        Some(&b"archived by the command"[..])
    );
    assert!(recycle_bin::list(&vault.root).is_empty());
    assert_eq!(
        vault.metas().len(),
        1,
        "К8: the record is written by the command too"
    );
}
