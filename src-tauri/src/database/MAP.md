# Database backend map

Owns database durable files, queries and rebuildable projections. Entry commands
are in [commands/database.rs](../commands/database.rs); frontend contracts are in
[storage/database-port.ts](../../../src/lib/storage/database-port.ts).

| Concern                                       | Owner                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Domain/IPC types                              | [model.rs](model.rs)                                                                                     |
| Durable parse/validation/discovery            | [format.rs](format.rs), [validation.rs](validation.rs), [discovery.rs](discovery.rs)                     |
| Schema/value mutations and write coordination | [mutations.rs](mutations.rs), [mutation_state.rs](mutation_state.rs)                                     |
| Rows and attachments                          | [rows.rs](rows.rs), [assets.rs](assets.rs)                                                               |
| Saved view operations                         | [views.rs](views.rs)                                                                                     |
| SQLite projection / incremental publication   | [projection.rs](projection.rs)                                                                           |
| Query compilation / aggregation               | [query.rs](query.rs)                                                                                     |
| Formula evaluation                            | [formula.rs](formula.rs)                                                                                 |
| YAML synchronization                          | [yaml_sync.rs](yaml_sync.rs)                                                                             |
| Migration / mutation history                  | [migration.rs](migration.rs), [history.rs](history.rs)                                                   |
| Relation journals / activation recovery       | [relation_recovery.rs](relation_recovery.rs), [relation_schema_recovery.rs](relation_schema_recovery.rs) |
| Runtime/module state and events               | [runtime_state.rs](runtime_state.rs), [events.rs](events.rs)                                             |

Read [database format](../../../docs/database-format.md),
[vault format](../../../docs/vault-format.md), and relevant sections of
[database runtime](../../../docs/database-runtime.md). Design documents contain
proposals too; confirm actual durable layout in `format.rs` and its fixtures/tests.

Keep durable writes separate from cache health; disabling a module or rebuilding
SQLite must not discard source data. Preserve unknown fields. Failed formula or
rollup evaluation must produce diagnostics, not partial numeric results or source
mutations; see the formula failure contract in
[engineering.md](../../../docs/engineering.md). Keep vault generation, operation
IDs, mutation locking and transaction boundaries coordinated across the command.

Property rename in `mutations.rs` changes only the manifest. Existing YAML
bindings stay intact; a legacy stored property's previous name is pinned as its
storage key before renaming. Do not recursively rename YAML keys in notes or
nested databases. Formula/rollup names remain computed metadata without bindings.
Before publishing, use discovery ownership and the shared YAML resolver to reject
value changes, ambiguous storage keys, and existing formula references by name.
An attached database's main note belongs to its outer database.

Relation value mutations require the source raw-byte `expectedRevision`, recheck
planned note/manifest bytes before publication, and return post-write `revisions`
for the UI queue. Rollback must preserve later external edits and report incomplete
restoration. `relation_recovery.rs` persists versioned journals, no-replace raw
backups and completed outcomes before history/watcher confirmation. Operation-ID
replay must compare the payload, ignoring only vault generation. Activation in
`vault_context.rs` validates all pending operations before any restore or index
load; external edits or corrupt recovery data must block activation without being
overwritten. Do not apply editor draft retention to Relation recovery data.
Mutations also return `affectedNotes` from successfully written files,
including removed inverse targets. `commands/database.rs` refreshes these groups
through `projection.rs::update_relation_values_incremental`, reports per-database
failures, and publishes the last successful projection version. Never refresh
only the requested new targets or rely on watcher events to repair unlink.

Reciprocal property creation prepares source and target schemas before writing.
It requires an operation ID and both raw manifest revisions (one for a self-pair).
`relation_schema_recovery.rs` owns separate version-1 creation and version-2
configuration/type-change manifest journals, raw backups, conditional rollback
and replay of the original forward/inverse IDs.
Activation must preflight both Relation recovery namespaces before restoring
either. Existing Relation changes prepare up to three coalesced manifests and
require related raw revisions. Topology changes reject durable values on both
sides; disconnect preserves the inverse property as a one-way relation. Keep
owned-note discovery and fail-closed YAML/record/template checks in preflight.

Tests: `format_test.rs`, `discovery_test.rs`, `mutations_test.rs`,
`projection_test.rs`, `query_test.rs`, `formula_test.rs`, `migration_test.rs`,
`relation_recovery_test.rs`, `relation_schema_recovery_test.rs`.
Use `npm run rust:test -- database::` for focused iteration, then the full gates.
When modifying IPC types, regenerate bindings; never edit the generated TS file.
