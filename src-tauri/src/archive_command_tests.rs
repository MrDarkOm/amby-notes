use crate::archive::test_support::Vault;
use crate::recycle_bin::{self, DeleteMode};
use crate::watcher::WatcherState;

const NOTE_DELETED: &[u8] =
    b"---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\ndeleted into the archive";
const NOTE_ARCHIVED: &[u8] =
    b"---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAW\n---\narchived by the command";

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
    // The note already has its amby-id, so opening the vault does not add one (frozen-test fix).
    vault.put("Notes/a.md", NOTE_DELETED);
    let context = active(&vault);
    crate::commands::mutations::delete_item_inner(
        &context,
        &WatcherState::new(),
        vault.path("Notes/a.md").to_string_lossy().to_string(),
        DeleteMode::Archive,
    )
    .unwrap();
    assert!(!vault.exists("Notes/a.md"));
    assert_eq!(
        vault.read(".amby/archive/Notes/a.md").as_deref(),
        Some(NOTE_DELETED)
    );
    assert!(
        recycle_bin::list(&vault.root).is_empty(),
        "not the old trash"
    );
}

#[test]
fn k1_the_archive_action_of_the_command_writes_the_archive() {
    let vault = Vault::new();
    // The note already has its amby-id, so opening the vault does not add one (frozen-test fix).
    vault.put("Notes/a.md", NOTE_ARCHIVED);
    let context = active(&vault);
    crate::commands::mutations::archive_item_inner(
        &context,
        &WatcherState::new(),
        vault.path("Notes/a.md").to_string_lossy().to_string(),
    )
    .unwrap();
    assert!(!vault.exists("Notes/a.md"));
    assert_eq!(
        vault.read(".amby/archive/Notes/a.md").as_deref(),
        Some(NOTE_ARCHIVED)
    );
    assert!(recycle_bin::list(&vault.root).is_empty());
    assert_eq!(
        vault.metas().len(),
        1,
        "К8: the record is written by the command too"
    );
}
