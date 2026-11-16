//! CORE-02: one note that cannot be read (not UTF-8, for example saved as UTF-16 by Windows Notepad or
//! in cp1251 by an old export) must not stop the vault from opening, nor every other note from being
//! read. It is left out and reported; a version already in the index is kept, never dropped.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use crate::vault::{apply_id_migration, preflight_vault};
use std::{fs, path::PathBuf};
use ulid::Ulid;

struct Vault(PathBuf);
impl Vault {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("amby-unreadable-{}", Ulid::generate()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Vault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// "Привет" in cp1251: valid bytes for that code page, invalid UTF-8.
const CP1251: &[u8] = &[0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2];

#[test]
fn the_id_preflight_lists_an_unreadable_note_and_goes_on() {
    let vault = Vault::new();
    fs::write(vault.0.join("Good.md"), "# Good\n").unwrap();
    fs::write(vault.0.join("Old export.md"), CP1251).unwrap();

    let preflight = preflight_vault(&vault.0).unwrap();
    assert_eq!(
        preflight.unreadable_notes,
        vec!["Old export.md".to_string()]
    );
    assert_eq!(preflight.planned_id_writes, vec!["Good.md".to_string()]);

    apply_id_migration(&vault.0).unwrap();
    assert!(fs::read_to_string(vault.0.join("Good.md"))
        .unwrap()
        .contains("amby-id:"));
    // The unreadable file is never written.
    assert_eq!(fs::read(vault.0.join("Old export.md")).unwrap(), CP1251);
}

#[test]
fn a_vault_with_an_unreadable_note_opens_and_reports_it() {
    let vault = Vault::new();
    fs::write(
        vault.0.join("Good.md"),
        format!("---\namby-id: {}\n---\nGood\n", Ulid::generate()),
    )
    .unwrap();
    fs::write(vault.0.join("Old export.md"), CP1251).unwrap();
    let context = crate::vault_context::VaultContext::new();
    let loaded = context
        .activate(vault.0.to_str().unwrap(), |_| Ok(()), |loaded, _| loaded)
        .unwrap();
    assert_eq!(loaded.notes.len(), 1);
    assert!(loaded
        .sync
        .warnings
        .iter()
        .any(|warning| warning.contains("Old export.md")));
}

#[test]
fn a_note_that_becomes_unreadable_keeps_its_indexed_version_on_a_full_rescan() {
    let vault = Vault::new();
    let path = vault.0.join("Note.md");
    fs::write(
        &path,
        format!("---\namby-id: {}\n---\nKept\n", Ulid::generate()),
    )
    .unwrap();
    let context = crate::vault_context::VaultContext::new();
    context
        .activate(vault.0.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    context
        .with_active(|active| {
            fs::write(&path, CP1251).unwrap();
            // The vault root stands for "rescan everything".
            active
                .index_changes
                .lock()
                .unwrap()
                .insert(active.root.clone());
            let loaded = active.refresh()?;
            assert_eq!(loaded.notes.len(), 1);
            let cached: String = active
                .query_row("SELECT content FROM notes", [], |row| row.get(0))
                .unwrap();
            assert_eq!(cached.trim(), "Kept");
            Ok(())
        })
        .unwrap();
}
