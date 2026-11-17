# Vault and storage core map

`amby-core` is the shared Rust library for vault services and read-only AI tools.
The [desktop backend](../../../src-tauri/src/MAP.md) supplies IPC, windows, watcher
delivery, and sync orchestration. The [Cargo workspace](../../../Cargo.toml) keeps
the [sync workspace](../../../sync/MAP.md) separate.

Before changing persistence, indexing, frontmatter, rename, history, or trash,
read the [vault format](../../../docs/vault-format.md) and
[Markdown compatibility](../../../docs/markdown-compatibility.md).

- **Vault authorization / canonical paths** — [paths.rs](paths.rs), [vault_context.rs](vault_context.rs), [desktop path grants](../../../src-tauri/src/path_grants.rs)
- **Discovery/tree/preflight/identity migration** — [vault/scan.rs](vault/scan.rs), [vault/tree.rs](vault/tree.rs) (attached DB keeps note ID), [vault/migration.rs](vault/migration.rs)
- **YAML, note envelope (BOM, line endings)** — [frontmatter.rs](frontmatter.rs)
- **Atomic / no-replace writes and renames** — [atomic_fs.rs](atomic_fs.rs)
- **Durable-journal primitives (operation IDs, revisions, guarded paths, no-replace create); protocol in [docs](../../../docs/mutation-protocol.md)** — [durable.rs](durable.rs); used by [database/relation_recovery.rs](database/relation_recovery.rs) and [database/relation_schema_recovery.rs](database/relation_schema_recovery.rs)
- **Rebuildable note index** — [index/mod.rs](index/mod.rs), [index/connection.rs](index/connection.rs), [index/schema.rs](index/schema.rs), [index/note_index.rs](index/note_index.rs), [index/sync.rs](index/sync.rs)
- **Identity, search, links/tags/refactors** — [index/identity.rs](index/identity.rs), [index/query.rs](index/query.rs), [index/links.rs](index/links.rs), [index/tags.rs](index/tags.rs), [index/refactor.rs](index/refactor.rs)
- **Point updates (one file does not reread the vault)** — [index/sync_paths.rs](index/sync_paths.rs) (index for changed paths; `None` means run the full sync), [vault/tree_patch.rs](vault/tree_patch.rs) (tree patch from the disk with `tree_item_for_entry` of [vault/tree.rs](vault/tree.rs)), `ActiveVault::refresh_paths` in [vault_context.rs](vault_context.rs), IPC `refresh_vault_paths` in [commands/vault.rs](../../../src-tauri/src/commands/vault.rs); mutations put the patch in `FsMutationResult.tree_patch` ([commands/mutations.rs](../../../src-tauri/src/commands/mutations.rs))
- **Shadow check of point updates (debug builds)** — [shadow_check.rs](../../../src-tauri/src/shadow_check.rs): compares patches and index with a read-only full load; writes `shadow-mismatch.log`; `AMBY_SHADOW_CHECK=0` disables
- **Legacy index entry point** — [vault_index.rs](vault_index.rs) is a facade to `index/` and `vault/`
- **Bundle/layer/note operations** — [bundle/mod.rs](bundle/mod.rs), [bundle/notes.rs](bundle/notes.rs), [bundle/layers.rs](bundle/layers.rs), [bundle/assets.rs](bundle/assets.rs)
- **Mutation planning, execution, rollback** — [bundle/planning.rs](bundle/planning.rs), [bundle/execute.rs](bundle/execute.rs), [bundle/rollback.rs](bundle/rollback.rs), [bundle/path_ops.rs](bundle/path_ops.rs)
- **Properties of notes (appendix З), old `properties.json`** — [property_groups map](property_groups/MAP.md), [property_store.rs](property_store.rs), [property_template.rs](property_template.rs), [commands/properties.rs](../../../src-tauri/src/commands/properties.rs)
- **Creative workshops (discovery, create, recovery)** — [project map](project/MAP.md)
- **Database domain** — [database map](database/MAP.md)
- **Snapshots / crash recovery** — [history.rs](history.rs), [recovery.rs](recovery.rs)
- **Archive `.amby/archive/` (К), old trash, OS trash** — [archive.rs](archive.rs), [archive_migration.rs](archive_migration.rs) (trash → archive, journal), [recycle_bin.rs](recycle_bin.rs) (service trash), [system_recycle_bin.rs](system_recycle_bin.rs) (`SystemTrash`); routing in [commands/mutations.rs](../../../src-tauri/src/commands/mutations.rs)
- **Self-write fingerprints and reconciliation** — [self_write.rs](self_write.rs)
- **Read-only note tools and path confinement** — [ai_tools.rs](ai_tools.rs)
- **Shared IPC data types** — [model.rs](model.rs) and the owning modules

Markdown, attachments and durable sidecars are authoritative; index computations
must not rewrite them, except `assign_missing_identities` in the scan (a note without
`amby-id` gets one after an `id-assignment` snapshot). Preserve unknown YAML and Markdown,
BOMs and line endings. Use the existing vault guards, snapshots, atomic writes
and journal recovery.

`.amby/properties*` and relation journals in `.amby/recovery/database_relations/`
and `database_relation_schemas/` are durable. Activation preflights both journal
families before conditional rollback and index loading, and propagates errors.
Keep excluded metadata directories out of indexing.

Service tests live beside the code. Run `cargo test --locked -p amby-core` to run
them independently or `npm run rust:test` to also run the desktop tests and export
IPC bindings. [LockExt](lock_util.rs) recovers poisoned locks only where partially
completed work is harmless.
