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
| Filter operator registry | [filter_operators.rs](filter_operators.rs) |
| Formula evaluation                            | [formula.rs](formula.rs)                                                                                 |
| Rollup aggregation registry / config | [rollup.rs](rollup.rs), [rollup_config.rs](rollup_config.rs) |
| YAML synchronization                          | [yaml_sync.rs](yaml_sync.rs)                                                                             |
| Migration / mutation history                  | [migration.rs](migration.rs), [history.rs](history.rs)                                                   |
| Legacy record-shard → frontmatter transfer    | [legacy_records.rs](legacy_records.rs)                                                                   |
| Value-batch journal / startup rollback        | [value_batch_recovery.rs](value_batch_recovery.rs)                                                       |
| Relation journals / activation recovery       | [relation_recovery.rs](relation_recovery.rs), [relation_schema_recovery.rs](relation_schema_recovery.rs) |
| Relation picker search / reference lookup | [relation_lookup.rs](relation_lookup.rs) |
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

`apply_value_batch` publishes its recovery point through
`value_batch_recovery.rs` before the first note write. A failure to create the
recovery directory, write a backup or publish the `inProgress` journal aborts the
operation with the notes untouched. Failing to finalize the completed journal is
a warning in the result and keeps the backups and journal; an unfinished journal
for the same operation ID is never overwritten. Use
`frontmatter::inject_nth_atomic_write_failure` for fault-injection tests.

`rollup.rs` holds the only list of rollup aggregations per target kind and does the
arithmetic (exact decimals; earliest/latest by date key). Zero, no data and a failure are
different results: a sum over nothing is 0, average/min/max over nothing store a null,
and a failure stores no value plus a diagnostic. `percentChecked` counts checked boxes or
done-group Status options over all related pages, in whole hundredths rounded down.
`rollup_config.rs` validates and creates/changes a rollup (relation of this database, field of
the related database, compatible aggregation, not itself). Legacy `avg`/`countUnique` are
read as `average`/`unique`. `contextPageId` on a query or aggregate replaces `@currentPage`
filter operands and is part of the cursor identity.

`filter_operators.rs` is the only list of filter operators per field kind. Query
compilation and `validate_view` both go through it (legacy spellings `is`, `gt`, ... map to
the canonical names), and `filter-operators.json` in the UI must equal it. "Does not
equal" includes rows without a value. A Status option needs a `group`; creation assigns
one by position and older manifests without it are read as `notStarted`.

`relation_lookup.rs` answers the picker from the SQLite projection only: title search
with keyset paging over one database's members, and batch ID → title/path resolution
(`ok` or `missing`; a trashed note cannot be told from a deleted one by ID).

`assets.rs::resolve_database_asset_paths` turns stored `assets/<note-id>/<file>` paths
into absolute image paths for card covers. It refuses links anywhere in the chain,
non-images, oversized files and anything outside `.ambd/assets/<note-id>/`. If the
completed journal cannot be written, the journal and backups move to
`quarantine/` so activation never rolls back a confirmed write.

Legacy `.ambd/records` shards are transferred by `legacy_records.rs`: frontmatter
wins, the note is snapshotted first, and a handled shard is moved to
`.ambd/legacy-records/`, never deleted. Unmatched or unreadable shards stay put.

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
`relation_recovery_test.rs`, `relation_schema_recovery_test.rs`,
`value_batch_recovery_test.rs`, `legacy_records_test.rs`, `relation_lookup_test.rs`, `filter_operators_test.rs`, `rollup_test.rs`, `rollup_config_test.rs`.
Use `npm run rust:test -- database::` for focused iteration, then the full gates.
When modifying IPC types, regenerate bindings; never edit the generated TS file.
