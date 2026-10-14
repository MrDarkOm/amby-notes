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
| Story, universe and plot links, pages born linked            | [links.rs](links.rs)                                   |
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
under the workshop folder; stories are attached databases in `<Workshop>/Истории/<StoryName>/` with
`amby-story.json`. Legacy v2 `amby-project.json` is reported as `legacyProjectFormat` and left untouched.
Section `path` is a hint: the catalog matches a section to its database by `databaseId` through
`db_databases`, so a moved database works (`moved`) and a missing one is shown `missing`.

**Index.** `project_*` tables are a cache rebuilt in one transaction by
`rebuild_project_index`: at vault activation, from `refresh_projects` and after every
creation. The watcher emits `project:changed` (workshop or story structure file, or a folder
created/removed/renamed); the renderer debounces it and calls `refresh_projects`.

**Names.** A story title, a section name and the labels of the base sections become folder and file
names, so they go through `names::normalize_entry_name` (no `/ \ : * ? " < > |`, no leading or trailing dot,
no reserved names) before the journal exists; the other labels (property and option names) go through
`normalize_title`. The story card (`create::story_card_bytes`) writes `amby-id`, `amby-title` and
`amby-story-id` as JSON-escaped strings kept in the journal, so a resume writes the same bytes. A relation to
a database the same operation creates (`PropertyBuilder::with_pending_databases`) is not looked up on disk;
every other target must already exist. `create_workshop` accepts the keys of `presets::is_preset_label`
(including `property:stories` and `property:universe`), `text_schema::is_schema_label` and `section:<role>`;
the interface sends one shared set (`project-labels.ts`) written to `interface-label-keys.json`, which
`project-labels.test.ts` keeps equal to what is sent and `create_test::the_labels_the_interface_sends_...`
feeds to every creation.

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

**Links (`links.rs`).** A world section keeps a "Stories" relation (many, no other side) and the
stories section a "Universe" relation (one, no other side); the workshop file names them on the section
entry (`storiesPropertyId`, `universePropertyId`), so nothing finds them by name. `presets::plan` adds the
first for every world role (the author's own sections too) and returns its ID in `PresetPlan`;
`create_workshop_section` for `universes` also plans the second with `links::plan_link` into the stories
manifest. That is one operation over several files: the new database, the stories manifest (`manifest_write`
in the journal, original bytes kept, `recovery::rollback` restores them) and the workshop file last; a
failure or crash at any step puts both files back byte for byte. `add_story_links` links a section of a
workshop made before (the same journal, `expectedWorkshopRevision`, a snapshot of each file) and adopts a
relation to the right database with the right limit when the section already has one. `create_entity`
(`create_workshop_entity`) writes a world page with its "Stories" value in the same write as the note
(`create_database_row_with_values`); a repeated title gets `Title 2.md` and keeps `amby-title`.
`create_workshop` and `create_workshop_section` keep the structure file's text and the planned IDs in the
journal (`Plan.workshop_file_text`, `PlannedSection.stories_property_id`), so a resume writes what was planned.
The contract with the interface is checked on a real workshop: `contract_test.rs` builds it, reads the catalog and
rows back and compares them with `real-workshop.fixture.json`, which Vitest feeds to the interface's own model.

**Plot links (`links.rs`, [format §6](../../../docs/creative-format.md)).** A story's text may hold "Anchors" and
"Arcs" relations (`text.properties.anchors`/`arcs` in `amby-story.json`) and the anchors database "Arcs" and "Universe"
(`arcsPropertyId`, `universePropertyId`), the arcs "Characters" (`charactersPropertyId`). `create_story` and the
presets add them when the target database already exists; otherwise `ensure_plot_links` (journaled, `plan_links` adopts
a matching relation) makes what is missing in one database and one structure file (`story` or `anchors` target), and
writes nothing when nothing is missing. Tests: `plot_links_test.rs`.

**Notebooks (`notebooks.rs`).** A notebook is a plain subfolder of the notes base ([format §8](../../../docs/creative-format.md));
a note's place is its `category_path`, so this module only reads: `list_notebooks_of` walks the base's folder (no
links followed, bounded) and `resolve_notebook_dir` checks the `notebook` of `create_entity` before any write.

**Settings (`settings.rs`).** `update_workshop`, `remove_workshop_section` and
`reorder_workshop_sections` rewrite `amby-workshop.json` with `expectedWorkshopRevision`, a
history snapshot and an operation journal. Removing the stories section is disallowed (`CannotRemoveStoriesSection`).
`update_text_levels` and `add_text_status` change the text manifest and `amby-story.json` in one
journaled operation: the journal records `manifest_before`, and `recovery::rollback` restores the manifest if a
failure or crash comes before `amby-story.json` reaches its planned bytes. A level can only be renamed, reordered
or added: leaving one out (even an unused one) is refused before any write (`UnknownTextLevel`).

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
the projection's parent edges. Nothing here branches on a format `kind`. **Levels.** `textLevels` (1 to 6 names) is checked by `text_schema::normalize_text_levels` before any write and
joins the request revision, so a repeat, a replay and a rollback recompute the same bytes.

**Page numbers.** `list_text_stats(databaseId)` joins `db_members` to `notes` and returns, per page,
`word_count`, `mtime` and `created_at` as the note index keeps them. Read-only: the panel's word counts,
the story desk's "continue with" and the order anchors were made in come from it without reading a file.

**Presets.** `presets.rs` plans what a world section starts with (icon, two properties, a
gallery grouped by one of them, the page template) through `props.rs`, which builds properties
with `build_new_property` against the manifest being created. The result is journaled
(`PlannedSection.extras`, `.template`), so a repeat or a cleanup recomputes the manifest and
the template file byte for byte; `recovery::rollback` removes the template only when it is the
file we wrote, then the empty `.ambd` folders. **Page rules.** A parent must sit on a shallower
level than its page; a loop is refused first. `apply_value_batch_typed` reports a stale page as
`ValueBatchError::RevisionConflict` with the revision on disk, and `move_text_page` passes that
on as `ProjectError::RevisionConflict`.

