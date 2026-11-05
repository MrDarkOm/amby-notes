# Properties of notes (appendix З of the sync plan)

Read [vault format](../../../docs/vault-format.md) (`.amby/properties/`, `property-ops/`) and
the appendix З of [the sync plan](../../../docs/sync-plan.md), above all З.11 (З45–З56).

The **value** of a property lives only in the YAML header of the note. Type, icon and options
come from the template of basic properties ([property_template.rs](../property_template.rs));
a note's record keeps only the differences from it, by property name.

| Concern                                                                                         | Owner                                                              |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Types, the public surface                                                                       | [mod.rs](mod.rs)                                                   |
| 16 files of lines, layout, marks; edit of one line byte for byte (З47–З51, З53)                 | [files.rs](files.rs)                                               |
| Which key of the header is a property (З1, З24–З27); the look = template + differences (З46)   | [header.rs](header.rs)                                             |
| Panel, sleeping records, hint about a rename, SQLite mirror (З3, З3а, З23, З44)                 | [panel.rs](panel.rs)                                               |
| Edits: value, look, order, rename, create, delete; journal `.amby/property-ops/` (З9, З28, З29) | [edits.rs](edits.rs)                                               |
| Backups, rebinding on a new `amby-id`, inspection, orphans (З10, З11, З34, З35)                 | [identity.rs](identity.rs)                                         |
| Which store the vault is in, the list shown for a note, the mirror, the report of old-version edits at the opening | [lifecycle.rs](lifecycle.rs) |
| Migration from `properties.json`: by itself at the first opening (`open_vault`), run, resume, rollback (З19–З21, З38–З42, З54)         | [migration.rs](migration.rs)                                       |
| Edits of an old version carried over by marks (З22, З36, З37, З53)                              | [legacy.rs](legacy.rs)                                             |
| Merge of the files between devices                                                              | [sync/core engine `props_groups.rs`](../../../sync/core/src/engine/props_groups.rs) |
| IPC                                                                                             | [commands/properties.rs](../commands/properties.rs)                |
| Tests (frozen: do not change them to make the code pass)                                        | `tests_*.rs`, `testkit.rs`; the measurement `tests_scale.rs` is `#[ignore]` |

Rules that tests hold: a write replaces only its own line; a line that cannot be read blocks the
writes of its file and hides nothing; a header that cannot be trusted (З25) shows no sleeping
records and accepts no edits; every deletion first leaves a copy in `.amby/property-backups/`;
`properties.json` is never written; `layout.json` is written last by the migration.
