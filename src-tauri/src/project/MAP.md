# Creative workshop backend map

Owns discovery of creative workshops (`amby-workshop.json`), their rebuildable SQLite
index, and the journaled creation of workshops, sections, and stories. The contract is
[creative format](../../../docs/creative-format.md); IPC is
[commands/project.rs](../commands/project.rs) (commands: format §10); the renderer port is
[project-port.ts](../../../src/lib/storage/project-port.ts). The interface is
[the creative map](../../../src/components/workspace/creative/MAP.md).

| Concern                                                      | Owner                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| IPC types, typed `ProjectError`, catalog shapes              | [model.rs](model.rs)                                   |
| Workshop and story file parse/rewrite (unknown fields kept)  | [format.rs](format.rs)                                 |
| Read-only discovery, diagnostics                             | [discovery.rs](discovery.rs)                           |
| SQLite projection and catalog read                           | [index.rs](index.rs); tables in `index/schema.rs`      |
| Initialize workshop / create story / section, preflight, apply | [create.rs](create.rs)                               |
| Make a workshop of earlier stages whole (`complete_workshop`) | [complete.rs](complete.rs)                            |
| Story, universe and plot links, pages born linked            | [links.rs](links.rs)                                   |
| Workshop settings, section order/remove, levels, text status | [settings.rs](settings.rs)                             |
| Operation journal (`.amby/recovery/creative/`)               | [journal.rs](journal.rs)                               |
| Conditional cleanup and activation recovery                  | [recovery.rs](recovery.rs)                             |
| Section presets (properties, gallery view, dossier template) | [presets.rs](presets.rs), [props.rs](props.rs)         |
| Relations of one note, both ways (dossier)                   | [references.rs](references.rs)                         |
| Text schema (5 properties + plot links, `text` block)        | [text_schema.rs](text_schema.rs)                       |
| Text pages: create, move, loop check                         | [text.rs](text.rs)                                     |
| Words, modified and created times of a database's pages      | [text_stats.rs](text_stats.rs)                         |
| Folder-name, tag and icon validation                         | [names.rs](names.rs)                                   |
| Watcher path classification (`project:changed`)              | [events.rs](events.rs)                                 |

**Discovery.** Any `amby-workshop.json` outside hidden/service folders is a workshop. Peer
databases (`stories`, `characters`, `locations`, `universes`, `arcs`, `anchors`, `notes`) live
under the workshop folder; a story is a folder `<Workshop>/Истории/<Name>/` holding `<Name>.md` (card),
`<Name>.json` (text manifest) and `amby-story.json`. Legacy v2 `amby-project.json` is only reported
(`legacyProjectFormat`), never read or changed. Every diagnostic code and its effect: [format §9](../../../docs/creative-format.md).
Section `path` is a hint: the catalog matches a section to its database by `databaseId` through
`db_databases`, so a moved database works (`moved`) and a missing one is shown `missing`.

**Index.** `project_*` tables are a cache rebuilt in one transaction by `rebuild_project_index` (activation,
`refresh_projects`, every creation). The watcher emits `project:changed`; the renderer debounces it and refreshes.

**Names.** A story title, a section name and the labels of the base sections become folder and file
names, so they go through `names::normalize_entry_name` (no `/ \ : * ? " < > |`, no leading or trailing dot,
no reserved names) before the journal exists; the other labels (property and option names) go through
`normalize_title`. The story card (`create::story_card_bytes`) writes `amby-id`, `amby-title` and
`amby-story-id` as JSON-escaped strings kept in the journal, so a resume writes the same bytes. A relation to
a database the same operation creates (`PropertyBuilder::with_pending_databases`) is not looked up on disk;
every other target must already exist. `init_workshop` accepts the keys of `presets::is_preset_label`
(including `property:stories` and `property:universe`), `text_schema::is_schema_label` and `section:<role>`;
the interface sends one shared set (`project-labels.ts`) written to `interface-label-keys.json`, which
`project-labels.test.ts` keeps equal to what is sent and `create_test::the_labels_the_interface_sends_...`
feeds to every creation.

**One workshop per vault ([format §2.1](../../../docs/creative-format.md)).** `init_workshop` makes the folder named by
`path`, its marker and all seven bases with every link in one journaled operation: every database ID is chosen before any
base is planned, so a base can point at one made after it (`presets::plan` gets the whole `target_databases` and `pending`).
A folder already there is taken only when empty and is never removed by a rollback; anything else is `folderNotEmpty`
before the first write. `resolve_workshop_folder` turns a dialog's folder into that path. `create::create_workshop` (the
three bases of stages 2 to 7) is `cfg(test)` only, so tests can build an earlier workshop and check what `complete.rs` adds:
`create_workshop_section` for the absent Universes, Arcs, Anchors, Notes (in that order), then `add_story_links` and
`ensure_plot_links`, each journaled; what cannot be done is `skipped`, a repeat writes nothing. Which marker is the
workshop is the interface's decision (`workshop-location.ts`); discovery lists them all.

**Creation.** `init_workshop`, `create_story`, and `create_workshop_section` run one journaled operation:
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

**Links (`links.rs`).** A world section keeps a "Stories" relation (many, no other side) and the stories section a
"Universe" relation (one, no other side); the workshop file names them on the section entry (`storiesPropertyId`,
`universePropertyId`), so nothing finds them by name. `presets::plan` adds the first for every world role and returns its
ID in `PresetPlan`; `init_workshop` plans "Universe" in the stories preset itself, `create_workshop_section` for
`universes` of a workshop made without them plans it with `links::plan_link` into the stories manifest (`manifest_write`
in the journal; rollback restores its bytes, the workshop file is the commit point). `add_story_links` links a section of
a workshop made before and adopts a matching relation. `create_entity` (`create_workshop_entity`) writes a world page
with its "Stories" value in the same write as the note; a repeated title gets `Title 2.md` and keeps `amby-title`.
`init_workshop` and `create_workshop_section` keep the structure file's text and the planned IDs in the journal
(`Plan.workshop_file_text`, `PlannedSection.stories_property_id`), so a resume writes what was planned. The contract with
the interface is checked on a real workshop: `contract_test.rs` compares its output with `real-workshop.fixture.json`,
which Vitest feeds to the interface's model.

**Plot links (`links.rs`, [format §6](../../../docs/creative-format.md)).** A story's text may hold "Anchors" and
"Arcs" relations (`text.properties.anchors`/`arcs` in `amby-story.json`) and the anchors database "Arcs" and "Universe"
(`arcsPropertyId`, `universePropertyId`), the arcs "Characters" (`charactersPropertyId`). `create_story` and the
presets add them when the target database already exists; otherwise `ensure_plot_links` (journaled, `plan_links` adopts
a matching relation) makes what is missing in one database and one structure file (`story` or `anchors` target), and
writes nothing when nothing is missing. `create_entity` also takes a `universe_id` (an anchor born as an event of a universe, in the same
write as the note; refused before any write unless the property and the universe note exist). Tests: `plot_links_test.rs`.

**Notebooks (`notebooks.rs`).** A notebook is a plain subfolder of the notes base ([format §8](../../../docs/creative-format.md));
this module only reads: `list_notebooks_of` (bounded, no links followed) and `resolve_notebook_dir`, which checks the
`notebook` of `create_entity` before any write.

**Settings (`settings.rs`).** `update_workshop`, `remove_workshop_section` and `reorder_workshop_sections` rewrite
`amby-workshop.json` with `expectedWorkshopRevision`, a history snapshot and an operation journal; the stories section
cannot be removed. `update_text_levels` and `add_text_status` change the text manifest and `amby-story.json` in one
journaled operation (the journal records `manifest_before`, rollback restores it). A level can only be renamed,
reordered or added (`UnknownTextLevel` otherwise).

**Tests.** `create_test.rs` writes real files in a temporary vault and fails or "crashes" the operation at every durable
step (`Step` hooks) and at `inject_nth_atomic_write_failure`; `discovery_test.rs` covers diagnostics and rebuilds.
Run `npm run rust:test -- project::`. After changing the commit order or the journal, break the cleanup and confirm the
crash tests fail.

**Text.** A story's text database is created with its five system properties in the same manifest (`text_schema.rs`,
IDs fixed up front and journaled, so cleanup recomputes the manifest byte for byte; `status` is optional for older stories
and added later by `add_text_status`). `text.levels[].id` and `text.formats[].id` are option IDs, never names; the catalog
resolves them against `db_options` at read time and a deleted option is `dangling` with a diagnostic, the file untouched.
`create_text_page` goes through `rows::create_database_row_with_values` (values and note in one write); `move_text_page`
through `apply_value_batch` after a loop check on the projection's parent edges. **Levels.** `textLevels` (1 to 6 names) is
checked by `text_schema::normalize_text_levels` before any write and joins the request revision. **Page rules.** A parent
must sit on a shallower level than its page; a loop is refused first; a stale page is `RevisionConflict`.

**Page numbers.** `list_text_stats(databaseId)` joins `db_members` to `notes` and returns, per page, `word_count`,
`mtime` and `created_at` as the note index keeps them (read-only; no file is read).

**Presets.** `presets.rs` plans what a world section starts with (icon, properties, a gallery grouped by one of them, the
page template) through `props.rs`. The result is journaled (`PlannedSection.extras`, `.template`), so a repeat or a cleanup
recomputes the manifest and the template byte for byte; rollback removes the template only when it is the file we wrote.
