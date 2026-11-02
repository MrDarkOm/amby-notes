# Rust services map

Before persistence/indexing/frontmatter/rename/history/trash changes, read
[vault format](../../docs/vault-format.md) and
[Markdown compatibility](../../docs/markdown-compatibility.md).

| Concern                                            | Owner                                                                                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap, state, IPC registration, Specta export  | [lib.rs](lib.rs), [state.rs](state.rs), [model.rs](model.rs)                                                                                                                             |
| Narrow IPC boundaries                              | [commands/](commands/): notes, vault, mutations, history, assets, database, project, modules, debug                                                                                               |
| Vault authorization / canonical paths              | [paths.rs](paths.rs), [vault_context.rs](vault_context.rs)                                                                                                                               |
| Discovery/tree/preflight/identity migration        | [vault/scan.rs](vault/scan.rs), [vault/tree.rs](vault/tree.rs), [vault/migration.rs](vault/migration.rs)                                                                                 |
| YAML, note envelope, atomic/no-replace publication | [frontmatter.rs](frontmatter.rs)                                                                                                                                                         |
| Durable-journal primitives (operation IDs, revisions, guarded paths, no-replace create); protocol in [docs](../../docs/mutation-protocol.md) | [durable.rs](durable.rs); used by [database/relation_recovery.rs](database/relation_recovery.rs) and [database/relation_schema_recovery.rs](database/relation_schema_recovery.rs) |
| Rebuildable note index                             | [index/mod.rs](index/mod.rs), [index/connection.rs](index/connection.rs), [index/schema.rs](index/schema.rs), [index/note_index.rs](index/note_index.rs), [index/sync.rs](index/sync.rs) |
| Identity, search, links/tags/refactors             | [index/identity.rs](index/identity.rs), [index/query.rs](index/query.rs), [index/links.rs](index/links.rs), [index/tags.rs](index/tags.rs), [index/refactor.rs](index/refactor.rs)       |
| Point updates (one file does not reread the vault) | [index/sync_paths.rs](index/sync_paths.rs) (index for changed paths; `None` means run the full sync), [vault/tree_patch.rs](vault/tree_patch.rs) (tree patch from the disk with `tree_item_for_entry` of [vault/tree.rs](vault/tree.rs)), `ActiveVault::refresh_paths` in [vault_context.rs](vault_context.rs), IPC `refresh_vault_paths` in [commands/vault.rs](commands/vault.rs); mutations put the patch in `FsMutationResult.tree_patch` ([commands/mutations.rs](commands/mutations.rs)); equivalence tests in [vault/tree_patch_tests.rs](vault/tree_patch_tests.rs) |
| Shadow check of point updates (debug builds) | [shadow_check.rs](shadow_check.rs): compares patches and index with a read-only full load; writes `shadow-mismatch.log`; `AMBY_SHADOW_CHECK=0` disables |
| Legacy index entry point                           | [vault_index.rs](vault_index.rs) is a facade to `index/` and `vault/`                                                                                                                    |
| Bundle/layer/note operations                       | [bundle/mod.rs](bundle/mod.rs), [bundle/notes.rs](bundle/notes.rs), [bundle/layers.rs](bundle/layers.rs), [bundle/assets.rs](bundle/assets.rs)                                           |
| Mutation planning, execution, rollback             | [bundle/planning.rs](bundle/planning.rs), [bundle/execute.rs](bundle/execute.rs), [bundle/rollback.rs](bundle/rollback.rs), [bundle/path_ops.rs](bundle/path_ops.rs)                     |
| Durable standalone properties + cache coordination | [property_store.rs](property_store.rs)                                                                                                                                                   |
| Creative workshops (discovery, create, recovery)   | [project map](project/MAP.md)                                                                                                                                                            |
| Database domain                                    | [database map](database/MAP.md)                                                                                                                                                          |
| Open an attachment / address with the system | [commands/external.rs](commands/external.rs) (allow-list of types, `assets` folders only, http/https only)                                                                                 |
| Title of a web page for a bookmark (the only outgoing request of a note) | [page_info.rs](page_info.rs), command in [commands/external.rs](commands/external.rs) |
| Snapshots / crash recovery                         | [history.rs](history.rs), [recovery.rs](recovery.rs)                                                                                                                                     |
| Vault-local archive/trash / OS trash               | [recycle_bin.rs](recycle_bin.rs), [preview](recycle_bin_preview.rs), [system_recycle_bin.rs](system_recycle_bin.rs); inspect [commands/mutations.rs](commands/mutations.rs) for delete versus archive routing               |
| Filesystem events                                  | [watcher.rs](watcher.rs)                                                                                                                                                                 |
| Signed app update channels / release identity | [updater.rs](updater.rs), [updater/tests.rs](updater/tests.rs); [update contract](../../docs/update-system.md) |
| Global app data / packages                         | [app_data.rs](app_data.rs), [package_manager.rs](package_manager.rs)                                                                                                                     |
| AI providers / read-only turns / conversations     | [ai.rs](ai.rs), [ai/catalog.rs](ai/catalog.rs), [ai/connections.rs](ai/connections.rs), [ai/turn.rs](ai/turn.rs), [ai/provider_stream.rs](ai/provider_stream.rs), [ai/tools.rs](ai/tools.rs), [ai/index_snapshot.rs](ai/index_snapshot.rs), [ai/consent.rs](ai/consent.rs), [ai/codex.rs](ai/codex.rs), [ai/codex/agent.rs](ai/codex/agent.rs), [ai/codex/launch.rs](ai/codex/launch.rs), [ai/codex/home.rs](ai/codex/home.rs), [ai/codex/mcp.rs](ai/codex/mcp.rs), [ai/local_apps.rs](ai/local_apps.rs) (is a local model program installed: fixed provider list, looks at files, runs nothing), [ai/claude_code.rs](ai/claude_code.rs) (Claude Code CLI: protocol, argv, boundary guard), [ai/claude_code/launch.rs](ai/claude_code/launch.rs) (process lifecycle, sign-in, catalog, IPC), [ai/claude_code/home.rs](ai/claude_code/home.rs) (isolated `CLAUDE_CONFIG_DIR`, environment), [ai/chats.rs](ai/chats.rs), [commands/ai_chats.rs](commands/ai_chats.rs), [credentials.rs](credentials.rs) |
| Encrypted sync: connect screen (key store, record, flows, IPC) | [sync/](sync/mod.rs): `service.rs` (flows), `secrets.rs` (key store `com.ambynotes.sync`: one `credentials` entry for AK + token, migration from the old two), `connection.rs` (address and name in app data), `password.rs` (12 characters + zxcvbn), `types.rs`; IPC in [commands/sync.rs](commands/sync.rs); client in [sync map](../../sync/MAP.md) |
| Encrypted sync: the engine in the app (stage Э4) | [sync/](sync/mod.rs): ports of the engine — `vault_fs.rs` (atomic write with a `sync-overwrite` snapshot, trash, no-overwrite rename), `state_db.rs` (`.amby/sync/state.db`, SQLite), `remote.rs` (HTTP), `clock.rs`; `space.rs` (space of a vault, Ф34), `session.rs` (when a pass runs, Д19, Р8 stops), `runtime.rs` (switching on, resuming, answers), `gate.rs` (gate before real notes), `hints.rs` (Д70), `conflict_store.rs` (port of the store of conflicts for the interface, Э4б), `app_hooks.rs` (events to windows, merging of watcher events via `EventBatch` in [watcher.rs](watcher.rs)), `vault_types.rs` (IPC types); rename and move commands in [commands/mutations.rs](commands/mutations.rs) record hints; the watcher in [commands/vault.rs](commands/vault.rs) starts and stops the session |
| Native logging / diagnostics                       | [logging.rs](logging.rs), [commands/debug.rs](commands/debug.rs)                                                                                                                         |

Markdown, attachments and durable sidecars are authoritative; index computations
must not rewrite them. Preserve unknown YAML/Markdown and line endings. Use
existing vault guards, snapshots, atomic writes and journal/recovery mechanisms.
`.amby/properties.json` is durable; its SQLite mirror is not. Relation journals
in `.amby/recovery/database_relations/` and `database_relation_schemas/` are
durable too; activation preflights both before conditional rollback through
`database/relation_recovery.rs` and `database/relation_schema_recovery.rs`, before
index loading, and propagates errors instead of silently skipping recovery. Keep excluded
metadata directories out of indexing. Do not silently assign or migrate IDs.

Before the first sync pass, [sync/backup.rs](sync/backup.rs) creates a full external
copy beside the vault (`<vault>.amby-backups/<operation>/vault`), verifies files and
SQLite online snapshots, then publishes a version-1 manifest and local receipt.
`runtime.rs` enforces this before enablement and legacy automatic resumption;
`VaultSyncStatus.backup_path` exposes the completed location. This is separate
from per-file history and the migration backups inside a vault.

Tests live beside services, in `*_test.rs`, `*_tests.rs`, bundle tests and
[desktop_e2e_tests.rs](desktop_e2e_tests.rs). Include collisions, failed writes,
rollback and original-byte preservation where relevant. Run `npm run rust:test`;
IPC changes regenerate [bindings.ts](../../src/lib/bindings.ts) through Specta.
Backend-heavy changes also need `npm run rust:clippy`; see
[the tests map](../../tests/MAP.md) for live native checks.

Poison-tolerant locking: [lock_util.rs](lock_util.rs) `LockExt::lock_or_recover` replaces `.lock().unwrap()` on vault, watcher and recovery mutexes (logs a warning, clears the poison flag). Use it only where a half-finished panic cannot leave harmful state; its header lists why that holds for each existing mutex.

System key store UI policy: [keychain_access.rs](keychain_access.rs) serializes macOS access, suppresses dialogs for background sync, and permits them only in synchronous explicit account actions. AI credential access shares the lock.

Backup catalog and verified separate-folder restore: [sync/backup_restore.rs](sync/backup_restore.rs), called by [commands/backups.rs](commands/backups.rs). Restore journals, generation scoping and preserved sync state: [vault format](../../docs/vault-format.md#backup-and-git-policy).

AI connections live only in the app-data file `ai-connections.json` (an `ai` section of version 1); a missing file means no connections. The `ai` section still in `settings.json` and the files `settings.ai-v1.*` and `settings.pre-ai-connections.backup.json` left by earlier versions are no longer read, never rewritten and never deleted. The native checks that read the file are in [ai/connections.rs](ai/connections.rs).
