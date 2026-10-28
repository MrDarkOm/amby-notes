# Backup recovery UI

[backup-panel.tsx](backup-panel.tsx) lists the **open vault's** pre-sync backups,
verifies on demand, confirms a separate-folder restore and offers opening the
verified result. It is used only in the sync backup disclosure.
[backup-navigation.ts](backup-navigation.ts) asks the main window to open a result;
[use-vault-actions.ts](../orchestration/use-vault-actions.ts) follows the normal
save/close/profile-selection path. There is no automatic vault switch after restore.

Filesystem access: `storage.ts` → [backup-repository.ts](../../../lib/storage/backup-repository.ts)
→ [commands/backups.rs](../../../../src-tauri/src/commands/backups.rs) →
[backup_restore.rs](../../../../src-tauri/src/sync/backup_restore.rs).
Catalog metadata is not a verification result. The backend generation returned by
the catalog scopes verification and restore; stale results are discarded. Restore
checks bytes before and after copying. Errors are machine codes translated under
`backups.*`; never show raw native or IPC errors. The browser has no backup adapter.

The versioned restore journal, completion marker and sync-state preservation are
specified in [vault format](../../../../docs/vault-format.md#backup-and-git-policy).
Tests: `backup-panel.test.tsx`, `backup-repository.test.ts`, Rust
`backup_restore_tests.rs`. Always use disposable vaults for native verification.
