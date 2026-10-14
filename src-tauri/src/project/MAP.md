# Creative workshop backend map

Owns discovery of creative workshops (`amby-workshop.json`), their rebuildable SQLite
index, and the journaled creation of workshops, sections, and stories. The contract is
[creative format](../../../docs/creative-format.md); IPC is
[commands/project.rs](../commands/project.rs); the renderer port is
[project-port.ts](../../../src/lib/storage/project-port.ts). The interface is
[the creative map](../../../src/components/workspace/creative/MAP.md).

| Concern                                                      | Owner                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| IPC types, typed `ProjectError`, catalog shapes              | [model.rs](model.rs)                                   |
| Workshop and story file parse/rewrite (unknown fields kept)  | [format.rs](format.rs)                                 |
| Read-only discovery, diagnostics                             | [discovery.rs](discovery.rs)                           |
| SQLite projection and catalog read                           | [index.rs](index.rs); tables in `index/schema.rs`      |
| Create workshop / story / section, preflight, apply          | [create.rs](create.rs)                                 |
| Workshop settings, section order/remove, levels, text status | [settings.rs](settings.rs)                             |
| Operation journal (`.amby/recovery/projects/`)               | [journal.rs](journal.rs)                               |
| Conditional cleanup and activation recovery                  | [recovery.rs](recovery.rs)                             |
| Section presets (properties, gallery view, dossier template) | [presets.rs](presets.rs), [props.rs](props.rs)         |
| Relations of one note, both ways (dossier)                   | [references.rs](references.rs)                         |
| Text schema (5 properties, `text` block)                     | [text_schema.rs](text_schema.rs)                       |
| Text pages: create, move, loop check                         | [text.rs](text.rs)                                     |
| Words, modified and created times of a database's pages      | [text_stats.rs](text_stats.rs)                         |
| Folder-name, tag and icon validation                         | [names.rs](names.rs)                                   |
| Watcher path classification (`project:changed`)              | [events.rs](events.rs)                                 |

**Discovery.** Any `amby-workshop.json` outside hidden/service folders is a workshop. Peer
databases (`stories`, `characters`, `locations`, `universes`, `arcs`, `anchors`, `notes`) live
under the workshop folder. Stories are attached databases inside `<Workshop>/Истории/<StoryName>/`
with `amby-story.json`. Legacy v2 `amby-project.json` files are reported as `legacyProjectFormat`
diagnostics and kept read-only without touching files. Section `path` is a hint: a section is matched
to its database by `databaseId` through `db_databases` when the catalog is read, so a moved database
works (`moved`) and a missing one stays in the file and is shown `missing`.

**Index.** `project_*` tables are a cache rebuilt in one transaction by
`rebuild_project_index`: at vault activation, from `refresh_projects` and after every
creation. The watcher emits `project:changed` (workshop or story structure file, or a folder
created/removed/renamed); the renderer debounces it and calls `refresh_projects`.

**Names.** A story title, a section name and the labels of the base sections become folder and file
names, so they go through `names::normalize_entry_name` (no `/ \ : * ? " < > |`, no leading or trailing dot,
no reserved names) before the journal exists; the other labels (property and option names) go through
`normalize_title`. The story card (`create::story_card_bytes`) writes `amby-id`, `amby-title` and
`amby-story-id` as JSON-escaped strings and its bytes live in the journal, so a resume writes the same
bytes. A relation to a database the same operation creates (`PropertyBuilder::with_pending_databases`)
is not looked up on disk; every other target must already exist. `create_workshop` accepts the keys of
`presets::is_preset_label`, `text_schema::is_schema_label` and `section:<role>`; the interface sends
one shared set (`project-labels.ts`), and `create_test::the_labels_the_interface_sends_...` keeps the two in step.

**Creation.** `create_workshop`, `create_story`, and `create_workshop_section` run one journaled operation:
preflight without writes (generation, names, parent, case-insensitive collision, revision), then the journal
(no-replace), the folder, each database through `database::mutations::create_database_with_ids` with IDs fixed
in the journal, and the structure file last. Its reaching the planned bytes is the commit point; an error after it
still reports success. Before it, `recovery::rollback` removes only what the operation made: a manifest only when
byte-identical to the one recomputed from the journal, a folder only when empty. Anything else stays and the call
returns `RecoveryRequired` with the journal kept. Activation (`recover_pending_projects`) does the same for a crash
and quarantines a journal it cannot clean; it never blocks opening the vault. The same `operationId` and request
returns the recorded answer without writing; a different request under the same ID is `OperationIdReused`.
A new section rewrites the file through a history snapshot and a raw-byte `expectedWorkshopRevision`; unknown
fields and a BOM survive.

**Settings (`settings.rs`).** `update_workshop`, `remove_workshop_section` and
`reorder_workshop_sections` rewrite `amby-workshop.json` with `expectedWorkshopRevision`, a
history snapshot and an operation journal. Removing the stories section is disallowed (`CannotRemoveStoriesSection`).
`update_text_levels` and `add_text_status` modify both the text database manifest and `amby-story.json` in one
journaled operation: the journal records `manifest_before`, and `recovery::rollback` restores the manifest if a
failure or crash happens before `amby-story.json` reaches its planned bytes. A level can only be renamed, reordered or added:
leaving one out of the list (even one no page uses) is refused before any write (`UnknownTextLevel`).

**Tests.** `create_test.rs` writes real folders and files in a temporary vault and
fails or "crashes" the operation at every durable step (`Step` hooks, test only) and at
`inject_nth_atomic_write_failure`; `discovery_test.rs` covers nesting, diagnostics, the
SQLite join and rebuilds. Run `npm run rust:test -- project::`. When changing the
commit order or the journal, keep a mutation check: break the cleanup and confirm the
crash tests fail.

**Text.** A story's text database is created with its five system properties in the same
manifest (`text_schema.rs` plans them with `database::mutations::build_new_property` and IDs
fixed up front; the properties and the `text` block are journaled, so cleanup recomputes the
manifest byte for byte; `status` is optional in `amby-project.json` for older stories and can
be added later by `add_text_status`). `text.levels[].id` and `text.formats[].id` are option IDs, never
names. The catalog resolves them against `db_options` at read time (and resolves `statusOptions`
with their status groups when `text.properties.status` is present): a deleted option is
`dangling` with a diagnostic and the file is not touched. `create_text_page` goes through
`rows::create_database_row_with_values` (values and note in one write); `move_text_page` goes
through `apply_value_batch` (parent and order of one page in one write) after a loop check on
the projection's parent edges. Nothing here branches on a format `kind`. **Levels.** The four of
the template are only the default: `textLevels` on `create_project` (a story with base sections)
or `create_project_section` (role `text`) is an ordered list of 1 to 6 names, normalized and
checked for case-insensitive repeats by `text_schema::normalize_text_levels` before any write
(`InvalidName` with field `textLevels`; naming them where no text is created is refused too). They
become the options of the level Select in that order, IDs issued as always. The list joins the
request revision (`with_text_levels`, only when present, so a request without it hashes as it
did before) and the journal already holds the planned manifest and `text` block, so a repeat,
a replay and a rollback recompute the same bytes. A one-level schema is valid: the parent rule
(a parent on a shallower level) then allows no nesting and pages go in a row at the top.

**Page numbers.** `list_text_stats(databaseId)` joins `db_members` to `notes` and returns, per page,
`word_count`, `mtime` and `created_at` as the note index keeps them. Read-only, nothing is stored:
the panel's word counts, the story desk's "continue with" and the order of anchors made
(by creation time) come from it without reading a file. It is as fresh as the index.

**Presets.** `presets.rs` plans what a world section starts with (icon, two properties, a
gallery grouped by one of them, the page template) through `props.rs`, which builds properties
with `build_new_property` against the manifest being created. The result is journaled
(`PlannedSection.extras`, `.template`), so a repeat or a cleanup recomputes the manifest and
the template file byte for byte; `recovery::rollback` removes the template only when it is the
file we wrote, then the empty `.ambd` folders. **Page rules.** A parent must sit on a shallower
level than its page; a loop is refused first. `apply_value_batch_typed` reports a stale page as
`ValueBatchError::RevisionConflict` with the revision on disk, and `move_text_page` passes that
on as `ProjectError::RevisionConflict`.

