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
| Legacy index entry point                           | [vault_index.rs](vault_index.rs) is a facade to `index/` and `vault/`                                                                                                                    |
| Bundle/layer/note operations                       | [bundle/mod.rs](bundle/mod.rs), [bundle/notes.rs](bundle/notes.rs), [bundle/layers.rs](bundle/layers.rs), [bundle/assets.rs](bundle/assets.rs)                                           |
| Mutation planning, execution, rollback             | [bundle/planning.rs](bundle/planning.rs), [bundle/execute.rs](bundle/execute.rs), [bundle/rollback.rs](bundle/rollback.rs), [bundle/path_ops.rs](bundle/path_ops.rs)                     |
| Durable standalone properties + cache coordination | [property_store.rs](property_store.rs)                                                                                                                                                   |
| Creative workshops (discovery, create, recovery)   | [project map](project/MAP.md)                                                                                                                                                            |
| Database domain                                    | [database map](database/MAP.md)                                                                                                                                                          |
| Open an attachment / address with the system | [commands/external.rs](commands/external.rs) (allow-list of types, `assets` folders only, http/https only)                                                                                 |
| Title of a web page for a bookmark (the only outgoing request of a note) | [page_info.rs](page_info.rs), command in [commands/external.rs](commands/external.rs) |
| Snapshots / crash recovery                         | [history.rs](history.rs), [recovery.rs](recovery.rs)                                                                                                                                     |
| Vault-local archive/trash / OS trash               | [recycle_bin.rs](recycle_bin.rs), [system_recycle_bin.rs](system_recycle_bin.rs); inspect [commands/mutations.rs](commands/mutations.rs) for delete versus archive routing               |
| Filesystem events                                  | [watcher.rs](watcher.rs)                                                                                                                                                                 |
| Global app data / packages                         | [app_data.rs](app_data.rs), [package_manager.rs](package_manager.rs)                                                                                                                     |
| AI providers / secret storage                      | [ai.rs](ai.rs), [credentials.rs](credentials.rs)                                                                                                                                         |
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

Tests live beside services, in `*_test.rs`, `*_tests.rs`, bundle tests and
[desktop_e2e_tests.rs](desktop_e2e_tests.rs). Include collisions, failed writes,
rollback and original-byte preservation where relevant. Run `npm run rust:test`;
IPC changes regenerate [bindings.ts](../../src/lib/bindings.ts) through Specta.
Backend-heavy changes also need `npm run rust:clippy`; see
[the tests map](../../tests/MAP.md) for live native checks.
