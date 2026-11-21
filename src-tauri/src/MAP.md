# Desktop Rust backend map

Domain services live in [amby-core](../../crates/amby-core/src/MAP.md).

- **Bootstrap, state, IPC registration, Specta export** — [lib.rs](lib.rs), [state.rs](state.rs), [shared models](../../crates/amby-core/src/model.rs)
- **Bundled CLI entry point** — [main.rs](main.rs) forwards AppImage's `--amby-cli` argument to the sibling executable. [Packaging](../../scripts/prepare-cli-sidecar.mjs) prepares the target-matched binary.
- **CLI structural requests** — [cli_structural.rs](cli_structural.rs) validates the active vault, serializes requests with desktop mutations and publishes index and watcher changes. MCP mutations also validate the write grant and refresh the index without assigning IDs. See the [local CLI protocol](../../docs/cli-ipc.md).
- **Desktop vault lease** — [commands/vault.rs](commands/vault.rs) reserves the vault before activation or ID migration. [The core vault context](../../crates/amby-core/src/vault_context.rs) keeps the lease for the process and shares recovery with the CLI.
- **CLI note opening** — [cli_open.rs](cli_open.rs) validates local arguments and delivers them to the main window.
- **Narrow IPC boundaries** — [commands/](commands/): notes, vault, mutations, history, assets, database, project, modules, debug
- **Open with the system (attachment, address, vault folder by id)** — [commands/external.rs](commands/external.rs) (rules), [system_open.rs](system_open.rs) (one place that starts the system program)
- **Title of a web page for a bookmark (the only outgoing request of a note)** — [page_info.rs](page_info.rs), command in [commands/external.rs](commands/external.rs)
- **Filesystem events** — [watcher.rs](watcher.rs)
- **Signed app update channels / release identity** — [updater.rs](updater.rs), [updater/tests.rs](updater/tests.rs); [update contract](../../docs/update-system.md)
- **Global app data / packages** — [app_data.rs](app_data.rs), [package_manager.rs](package_manager.rs)
- **AI providers / read-only turns / conversations** — [ai.rs](ai.rs), [ai/catalog.rs](ai/catalog.rs), [ai/connections.rs](ai/connections.rs), [ai/turn.rs](ai/turn.rs), [ai/provider_stream.rs](ai/provider_stream.rs), [read-only AI tools](../../crates/amby-core/src/ai_tools.rs) (panel list: outline, sections, properties, tags, databases, note info, versions; [shared definitions](../../crates/amby-core/src/tool_set/mod.rs); Claude Code names are derived from it in [ai/claude_code.rs](ai/claude_code.rs)), [index snapshot](../../crates/amby-core/src/index/snapshot.rs), [ai/consent.rs](ai/consent.rs), [ai/codex.rs](ai/codex.rs), [ai/codex/agent.rs](ai/codex/agent.rs), [ai/codex/launch.rs](ai/codex/launch.rs), [ai/codex/home.rs](ai/codex/home.rs), [ai/codex/mcp.rs](ai/codex/mcp.rs), [ai/local_apps.rs](ai/local_apps.rs) (is a local model program installed: fixed provider list, looks at files, runs nothing), [ai/proposals.rs](ai/proposals.rs) (proposal cards of the panel: store, apply / reject / undo under the mutation gate), [ai/claude_code.rs](ai/claude_code.rs) (Claude Code CLI: protocol, argv, boundary guard), [ai/claude_code/launch.rs](ai/claude_code/launch.rs) (process lifecycle, sign-in, catalog, IPC), [ai/claude_code/home.rs](ai/claude_code/home.rs) (isolated `CLAUDE_CONFIG_DIR`, environment), [ai/chats.rs](ai/chats.rs), [commands/ai_chats.rs](commands/ai_chats.rs), [credentials.rs](credentials.rs)
- **Encrypted sync: connect screen (key store, record, flows, IPC)** — [sync/](sync/mod.rs): `service.rs` (flows, names), `secrets.rs` (key store `com.ambynotes.sync`, one entry for AK + token), `connection.rs`, `password.rs`, `types.rs`; IPC in [commands/sync.rs](commands/sync.rs); client in [sync map](../../sync/MAP.md)
- **Encrypted sync: the engine in the app (stage Э4)** — [sync/](sync/mod.rs): ports — `vault_fs.rs` (atomic write, `sync-overwrite` snapshot, trash), `state_db.rs` (`.amby/sync/state.db`), `remote.rs` (HTTP), `clock.rs`; `space.rs`, `session.rs` (when a pass runs, Р8 stops), `runtime.rs`, `hints.rs` (Д70), `conflict_store.rs`, `app_hooks.rs` (events to windows, `EventBatch` in [watcher.rs](watcher.rs)), `vault_types.rs`; rename and move commands in [commands/mutations.rs](commands/mutations.rs) record hints; the watcher in [commands/vault.rs](commands/vault.rs) starts and stops the session
- **Encrypted sync: server versions and deleted files (Э5)** — [sync/server_history.rs](sync/server_history.rs) (flows; restores via `history::commit_snapshot_restore` and no-replace create); IPC in [commands/sync.rs](commands/sync.rs); pure part: [sync map](../../sync/MAP.md); UI: [history](../../src/components/workspace/history/history-preview.tsx), [archive](../../src/components/workspace/panels/archive-server-section.tsx)
- **Native logging / diagnostics** — [logging.rs](logging.rs), [commands/debug.rs](commands/debug.rs)

Before the first sync pass, [sync/backup.rs](sync/backup.rs) makes a verified copy in app data
(`backups/<vault key>/<ULID>/`, `receipt.json` beside it, set by `set_home`), never beside the vault.
`runtime.rs` enforces it before enablement and automatic resumption; `VaultSyncStatus.backup_path`
and `backup_missing` expose it. The first completed pass records `first_sync_ms`; `activate_vault`
deletes the copy 14 days later. Old in-vault receipts stay readable.

Desktop tests live beside commands and in [desktop_e2e_tests.rs](desktop_e2e_tests.rs),
[tree_patch_tests.rs](tree_patch_tests.rs), and
[property_migration_flow_test.rs](property_migration_flow_test.rs).
Run `npm run rust:test` to run both crates and regenerate
[bindings.ts](../../src/lib/bindings.ts) through Specta. See the [tests map](../../tests/MAP.md)
for live checks.

System key store UI policy: [keychain_access.rs](keychain_access.rs) serializes macOS access, suppresses dialogs for background sync, allows them only in explicit account actions. AI credentials share the lock.

Backup catalog and verified restore into a separate folder: [sync/backup_restore.rs](sync/backup_restore.rs), called by [commands/backups.rs](commands/backups.rs); journals and scoping: [vault format](../../docs/vault-format.md#backup-and-git-policy).

`SyncRuntime::delete_space` (Л6–Л9) keeps local files.

AI connections live only in `ai-connections.json` (an `ai` section of version 1); a missing file means no connections. The old `ai` section of `settings.json` and the files `settings.ai-v1.*`, `settings.pre-ai-connections.backup.json` are no longer read, rewritten or deleted. The native checks that read the file are in [ai/connections.rs](ai/connections.rs).
