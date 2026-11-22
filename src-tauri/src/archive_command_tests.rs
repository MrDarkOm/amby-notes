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
        None,
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
        None,
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

#[test]
fn restore_refuses_a_stale_workspace_even_if_the_archive_paths_match() {
    let original = Vault::new();
    let other = Vault::new();
    let relative = "Project/Project.md";
    original.put(".amby/archive/Project/Project.md", NOTE_ARCHIVED);
    other.put(".amby/archive/Project/Project.md", NOTE_DELETED);
    let context = active(&other);
    let watcher = WatcherState::new();
    let restore = crate::commands::history::restore_archive_inner;
    assert!(restore(
        &context,
        &watcher,
        relative,
        original.root.to_str().unwrap()
    )
    .is_err());
    assert!(!other.exists(relative));
    assert_eq!(
        other.read(".amby/archive/Project/Project.md").as_deref(),
        Some(NOTE_DELETED)
    );
    context
        .activate(original.root.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    let restored = restore(
        &context,
        &watcher,
        relative,
        original.root.to_str().unwrap(),
    )
    .unwrap();
    assert_eq!(
        restored.outcome.mutation.primary_path.as_deref(),
        original.path(relative).to_str()
    );
    assert_eq!(original.read(relative).as_deref(), Some(NOTE_ARCHIVED));
    assert!(!other.exists(relative));
}
