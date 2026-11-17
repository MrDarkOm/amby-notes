# Amby Creative Module: Format Contract (revision 3)

Date: 13 October 2026; checked against the code on 14 October 2026 (stage 7 of the plan); stage 8 (one workshop per
vault) was added on 14 October 2026.
Format version: 3.
Status: **the current data contract of the flat workshop, implemented**. It replaces the nested
model of revision 2 of 6 October 2026: of that model, only §9 remains in this document
(how the code encounters it — with a diagnostic, without reading or writing).
The fields and keys below are checked against `src-tauri/src/project/` (`format.rs`, `create.rs`, `links.rs`,
`discovery.rs`).

---

## 1. Architectural Principles

1. **A note is data; the module is a projection and presentation.** Every entity (character, location,
   chapter, arc, anchor, note) is a plain Markdown file with metadata in its frontmatter.
   Every section is a standard Amby database ([database-format.md](database-format.md)).
   Without the creative module, the vault remains fully readable and structured.
2. **The workshop folder is the portable unit (W1).** All workshop data lives inside
   a single workshop root folder with the `amby-workshop.json` marker. A vault has one
   workshop: the one whose folder is named in the module setting (§2.1). Other markers found are
   diagnostics — their data is neither read nor changed; links between workshops are not supported.
3. **Flat organization of databases and membership through links (W2, W5).** The workshop has no
   nesting of project and universe folders. The databases of world entities, stories, arcs, anchors and notes
   sit at one top level of the workshop. An entity's membership in stories or a universe
   is defined exclusively by link properties (Relation by the note's ULID).
4. **A story as an attached text database (W3).** The only place of physical nesting is
   the story text folder: the story card is a row of the shared "Stories" database, and the folder itself is an
   attached database of text pages. Inside a story folder there are no other nested folders.
5. **A single source of facts, and atomicity.** Values and links are stored in the notes' frontmatter.
   The workshop marker file and the story text settings file record configuration and schemas,
   but do not duplicate property values. Writing goes through the Rust layer of atomic operations
   with journaling and rollback support.

---

## 2. Workshop Directory Structure

```text
Workshop/  (Мастерская/)
├── amby-workshop.json          ← workshop marker (format v3)
├── Вселенные/                  ← universes database (created at initialization, W11)
├── Истории/                    ← stories database (base)
│   └── Моя история/            ← attached story text database (W3)
│       ├── Моя история.md      ← story card (a row of the "Stories" database)
│       ├── Моя история.json    ← manifest of the story text database
│       ├── amby-story.json     ← text settings (levels, formats, properties)
│       ├── Глава 1.md          ← text pages (rows of the text database)
│       └── Глава 2.md …
├── Персонажи/                  ← characters database (base)
├── Локации/                    ← locations database (base)
├── Арки/                       ← plot lines database (at initialization, W11)
├── Якоря/                      ← anchor events database (at initialization, W11)
└── Заметки/                    ← shared notes database (at initialization, W11)
    └── Идеи/                   ← notebook (a subfolder of the "Notes" database, W7)
```

Each database folder contains its manifest `<Name>.json` (database format, [database-format.md](database-format.md));
the presets for characters, locations and author sections add a dossier template to the service folder `.ambd`.
Database folder names follow the interface language at the moment of initialization.
Operation logs live not in the workshop but in the vault: `.amby/recovery/creative/<operationId>.json`
(§10); this is recovery data, not a cache. A completed log is needed only to repeat its own operation
within a session, so when the vault is opened it is deleted once it is older than 30 days; unfinished and
unreadable logs are never deleted.

### 2.1. Where the workshop lives (W1, stage 8)

- **The setting.** `moduleSettings.creative.workshopPath` in the vault's `workspace.json`: the path of the workshop
  folder relative to the vault root, with a `/` separator, without `.`, `..` or hidden parts. If not
  set, the default is a folder in the vault root with a localized name («Мастерская» / «Workshop»). It is chosen
  through the app's folder-picker dialog; Rust (`resolve_workshop_folder`)
  canonicalizes the chosen path and accepts only an existing folder strictly inside the vault
  (a link pointing outside counts as the place it leads to, that is, a refusal). Changing the setting does not move files.
- **Which workshop is active.** The catalog still lists all markers found. The active one is the one whose
  folder matches the setting (case-insensitively). If the setting is not set and exactly one
  workshop is found, it is active and the setting itself is not written; if there are several, the one in the default folder.
  The other finds are `otherWorkshop` diagnostics (interface-side; it does not exist in Rust): their files are not
  read into the panel and are not changed.
- **No active workshop.** The panel shows the path and an «Инициализировать» (Initialize) button (`init_workshop`, §10). A folder
  that does not exist or is empty (only `.DS_Store`, `Thumbs.db`, `desktop.ini` are allowed) is accepted;
  anything else gives `Failed { code: "folderNotEmpty" }` before the first write, so as not to mix a workshop
  with foreign files. The path's parent must exist.

---

## 3. The Workshop Marker File `amby-workshop.json`

The file is located in the root of the workshop folder. A workshop is any folder outside hidden and service
folders (a name starting with a dot, `.ambd`, etc.) that has an `amby-workshop.json` file with a `formatVersion` (an integer from 1),
a `workshopId` (an identifier of letters, digits, `-` and `_` up to 128 characters; in practice a ULID) and a non-empty `name`
(up to 200 characters). A file larger than 1 MiB, not JSON, or lacking these fields yields the `invalidWorkshopFile` diagnostic and the
workshop is not shown. A folder with a repeated `workshopId` (a copy) yields `duplicateWorkshopId`, and the second one
is not counted as a workshop. A symbolic link instead of a file yields `symlinkIgnored`.

```json
{
  "formatVersion": 3,
  "workshopId": "01JAX000000000000000000001",
  "name": "Моя мастерская",
  "icon": "icon:feather",
  "tags": ["Фэнтези", "Комиксы"],
  "sections": [
    {
      "id": "stories",
      "role": "stories",
      "name": "Истории",
      "databaseId": "01JAX000000000000000000002",
      "path": "Истории"
    },
    {
      "id": "characters",
      "role": "characters",
      "name": "Персонажи",
      "databaseId": "01JAX000000000000000000003",
      "path": "Персонажи",
      "storiesPropertyId": "01JAX000000000000000000005"
    },
    {
      "id": "locations",
      "role": "locations",
      "name": "Локации",
      "databaseId": "01JAX000000000000000000004",
      "path": "Локации",
      "storiesPropertyId": "01JAX000000000000000000006"
    }
  ]
}
```

### `amby-workshop.json` field specification

| Field           | Type           | Purpose                                                                                                                                              |
| --------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formatVersion` | integer (`3`)  | Format version. Any other value (including above 3) yields `unsupportedFormatVersion`: the workshop is opened read-only and the file is not written. |
| `workshopId`    | ULID string    | A stable unique identifier of the workshop.                                                                                                          |
| `name`          | string         | The display name of the workshop.                                                                                                                    |
| `icon`          | string         | Optional: the encoded icon value (`IconValue`); when cleared, the key is removed.                                                                    |
| `tags`          | string[]       | User tags of the workshop.                                                                                                                           |
| `sections`      | SectionEntry[] | The list of registered workshop sections (base, lazy and author-made); the order is set by the author.                                               |

**The file revision is not stored in the file.** It is the SHA-256 of the file's raw bytes together with the BOM, computed by the code
(`raw_revision`); the interface receives it as `fileRevision` and returns it as
`expectedWorkshopRevision` (a "compare and write" check). Any edit of the file outside the app
changes the revision, and the next write gets `RevisionConflict`.

### The `sections` element

```typescript
type SectionEntry = {
  id: string // Unique section ID: equal to role for roles other than custom, a ULID for custom
  role: WorkshopRole // A predefined system role or "custom"
  name: string // The folder/database name (by default — id)
  databaseId: string // ULID of the Amby database
  path: string // A hint: the path to the database folder from the workshop root (by default — name)
  storiesPropertyId?: string // ID of the "Stories" property in this database (world sections), see §6
  universePropertyId?: string // ID of the "Universe" property (for the `stories` and `anchors` sections), see §6
  arcsPropertyId?: string // ID of the "Arcs" property (only for the `anchors` section), see §6
  charactersPropertyId?: string // ID of the "Characters" property (only for the `arcs` section), see §6
}

type WorkshopRole =
  "stories" | "characters" | "locations" | "universes" | "arcs" | "anchors" | "notes" | "custom"
```

An entry without `id`, `role` or `databaseId` is skipped (`invalidSection`), a repeated `id` yields `duplicateSectionId`,
and an empty path, one starting with `/`, containing a backslash, or with a path part `.` / `..` yields `unsafeSectionPath`; the other entries work.
`path` is only a hint: the catalog matches a section to a database by `databaseId`, so a moved database
keeps working (section `moved`), and one that has disappeared is shown as `missing` (§9). A role other than `custom` may occur
only once in a workshop (`sectionAlreadyExists`). The name of a section (and of a workshop, and of a story) becomes a folder name and goes through the
`normalize_entry_name` check: no spaces at the edges, up to 100 characters, none of `/ \ : * ? " < > |` and no control
characters, no leading or trailing dot, no Windows device names (`CON`, `COM1`…), service folders, or
the names `amby-workshop.json`, `amby-story.json`, `amby-project.json`. A match with a neighboring folder
is determined case-insensitively (`PathCollision`). Tags: up to 32, each up to 64 characters; an icon: up to 256 KiB.

The fields `storiesPropertyId`, `universePropertyId`, `arcsPropertyId` and `charactersPropertyId` are optional and **additive**: the format version
stays 3, and a workshop without them is read and works (linking to stories is then unavailable until
the `add_story_links` operation is performed, §6). Unknown fields of the file and of section entries
are preserved on every rewrite.

---

## 4. Workshop Databases and Their Roles

All workshop sections are standard Amby databases. The role determines the specialized
display in the module's interface (panel, galleries, dossiers, filters).

| Role         | Default database | Creation                | Purpose and starting properties                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stories`    | `Истории`        | At initialization       | The catalog of all works. Notes are story cards. Properties: «Статус» (Status), «Синопсис» (Text). The «Вселенная» (Universe) property (a Relation to `universes`, at most one target, with no reverse side) appears together with the «Вселенные» (Universes) database and is recorded as `universePropertyId`.                                                                                                                                                          |
| `characters` | `Персонажи`      | At initialization       | Dossiers of the dramatis personae. The `characters` preset: «Истории» (Stories) (a Relation to `stories`, with no limit on count, no reverse side; ID — `storiesPropertyId`), «Значимость» (Importance) (Select: Главные / Второстепенные / Эпизодические — Main / Secondary / Episodic), «Портрет» (Portrait) (Files), a dossier template with the sections «Основное» (Basics), «Характеристика» (Characterization), «Внешность» (Appearance), «Биография» (Biography). |
| `locations`  | `Локации`        | At initialization       | Settings of the action. The `locations` preset: «Истории» (Stories) (a Relation to `stories`, as for characters), «Тип» (Type) (Select: Город / Район / Место / Природа — City / District / Place / Nature), «Изображение» (Image) (Files), a description template.                                                                                                                                                                                                       |
| `universes`  | `Вселенные`      | At initialization (W11) | Cards of fictional worlds/settings. Properties: «Описание» (Description) (Text), «Изображение» (Image) (Files).                                                                                                                                                                                                                                                                                                                                                           |
| `arcs`       | `Арки`           | At initialization (W11) | Plot lines (W8). Properties: «Истории» (Stories) (a Relation to `stories`, multiple), «Персонажи» (Characters) (a Relation to `characters`, multiple, no reverse side; only if the characters database exists; ID — `charactersPropertyId`), «Тип» (Type) (Select: Линия персонажа / Сюжетная / Мини-арка — Character line / Plot / Mini-arc), «Статус» (Status) (Status). An arc's color is not stored: it is computed from its ID.                                      |
| `anchors`    | `Якоря`          | At initialization (W11) | Pinned key events of the world and of stories (W8). Properties: «Истории» (Stories) (a Relation to `stories`, multiple), «Участники» (Participants) (a Relation to `characters`, multiple), «Арки» (Arcs) (a Relation to `arcs`, multiple; only if the arcs database already exists, otherwise added later), «Вселенная» (Universe) (a Relation to `universes`, at most one target; likewise), «Описание» (Description) (Text).                                           |
| `notes`      | `Заметки`        | At initialization (W11) | The workshop author's notes (W7). Property: «Истории» (Stories) (a Relation to `stories`, multiple). Organized into notebooks via subfolders.                                                                                                                                                                                                                                                                                                                             |
| `custom`     | Any name         | On the author's action  | Author-made sections («Организации» (Organizations), «Бестиарий» (Bestiary), «Артефакты» (Artifacts)). As in any world section, the database has «Истории» (Stories).                                                                                                                                                                                                                                                                                                     |

### Creating the databases (W11, changed in stage 8)

All seven databases (Stories, Characters, Locations, Universes, Arcs, Anchors, Notes) are created by initialization
in one journaled `init_workshop` operation together with all the links between them (§6): «Истории» (Stories) in
every world database, «Вселенная» (Universe) in Stories and in Anchors, «Арки» (Arcs) in Anchors, «Персонажи» (Characters) in Arcs. The IDs of all
properties are recorded in the workshop file. The commit point is the workshop file; on a failure or crash at any
step everything created is rolled back, and a retry creates a single set.

Lazy creation remains as a recovery path: a workshop created in stages 2–7 may lack
some databases and links. The panel detects this without writing (`workshopGaps`) and shows a banner «Создать
недостающие разделы» (Create the missing sections); the button calls `complete_workshop`, which, using the existing journaled
operations (`create_workshop_section`, `add_story_links`, `ensure_plot_links`), adds only
what is missing: Universes, Arcs, Anchors, Notes — in that order, so that each database picks up links from those already
created; then «Истории» (Stories) for the world sections, «Вселенная» (Universe) for stories and anchors, «Арки» (Arcs) for anchors, «Якоря» (Anchors) and
«Арки» (Arcs) for story texts. A database whose folder is occupied by something foreign and a locked database are skipped (`skipped`);
the rest is done. A retry writes nothing. An author section (`custom`) is created on the author's action
(`create_workshop_section`).

---

## 5. The Story Model and the `amby-story.json` Settings File (W3, W4)

A story is a super note with an attached text database.

- **Story card:** `<Workshop>/Истории/<Story name>/<Story name>.md` — the row file of the shared "Stories" database. It is not part of its own text database.
- **Text database manifest:** `<Workshop>/Истории/<Story name>/<Story name>.json` — describes the attached database of text pages.
- **Text settings file:** `<Workshop>/Истории/<Story name>/amby-story.json` — describes the levels of the text structure, the available page formats and the system properties.

### Story card frontmatter

The card is a plain note with service fields; values are written as double-quoted YAML strings
with escaping (the same as `amby-title` in database rows), so a quote, backslash or
colon in the title does not break the frontmatter:

```yaml
---
amby-id: "01JAY000000000000000000002" # ULID of the card note
amby-title: "Дом О'Брайена" # display title (W10)
amby-story-id: "01JAY000000000000000000001" # storyId from amby-story.json
---
```

`amby-story-id` links the card to the settings file in the same folder; at present only story creation
writes it, and the module does not read it or check it against anything during discovery — the key is needed for future restoration
of the card (`storyMissingMainFile`) and must not be changed by hand. The card's bytes are entered in the
operation log, and on resumption the same bytes are written. A story's title is the name of its folder and files,
so it goes through the same name check as a section's title (§3). The catalog shows the title
from the card's `amby-title`, and if it is absent, the folder name; `cardNoteId` is taken from `amby-id`.

A story is found if the folder `Истории/<Name>/` contains three files: `<Name>.md`, `<Name>.json` and
`amby-story.json` (its `storyId` is unique across the vault). Without the card, the story is not shown
(`storyMissingMainFile`); without `amby-story.json`, likewise (`storyMissingConfigFile`); a text database manifest that is missing or
cannot be parsed leaves the story in the catalog without a text database (`brokenManifest`, §9). Hidden folders
and files in the «Истории» (Stories) folder (names starting with a dot) are skipped.

### Contents of `amby-story.json`

```json
{
  "formatVersion": 3,
  "storyId": "01JAY000000000000000000001",
  "text": {
    "levels": [
      { "id": "01JAY_LVL_1", "icon": "icon:book" },
      { "id": "01JAY_LVL_2" },
      { "id": "01JAY_LVL_3" }
    ],
    "formats": [
      { "id": "01JAY_FMT_1", "kind": "manuscript" },
      { "id": "01JAY_FMT_2", "kind": "screenplay" },
      { "id": "01JAY_FMT_3", "kind": "comic" },
      { "id": "01JAY_FMT_4", "kind": "note" }
    ],
    "properties": {
      "level": "01JAY_PROP_LEVEL",
      "parent": "01JAY_PROP_PARENT",
      "order": "01JAY_PROP_ORDER",
      "format": "01JAY_PROP_FORMAT",
      "status": "01JAY_PROP_STATUS",
      "anchors": "01JAY_PROP_ANCHORS",
      "arcs": "01JAY_PROP_ARCS"
    }
  }
}
```

The identifiers in the example are illustrative; real ones are ULIDs. Levels are created without `icon` (the icon is set
in the story settings, `update_text_levels`). The `status` property is written when the story is created; stories
created before it do not have it, and `add_text_status` adds it later. `anchors` and `arcs` are
written only if the properties exist (§6). Unknown fields of the file are preserved on any rewrite; so are the BOM and
line endings. A file larger than 1 MiB is considered corrupted.

### Text level schemes (W4)

The author picks the level scheme when creating a story:

1. **«Роман»** (Novel) (default): Book → Chapter → Scene (3 levels).
2. **«Рассказ»** (Short story): Page (1 level).
3. **«Комикс»** (Comic): Book → Volume → Chapter → Page (4 levels; the term "Arc" is excluded from the text scheme, since it is reserved for plot lines, W8).
4. **«Своя»** (Custom): A custom list of 1 to 6 levels.

The level names are sent by the UI in the active language (`textLevels`, from 1 to 6 non-empty names, with no
duplicates ignoring case; the request is validated before writing). Text levels are implemented through the
Select property in the text database manifest. The identifiers `levels[].id` correspond to the ULIDs of the Select options.
The names and colors of the options are stored in the text database manifest; `amby-story.json` holds their hierarchical
order and icons. The catalog reconciles the file entries with the options on every read: an option deleted in the database
stays in the file and is shown as `dangling` (diagnostics `danglingTextLevel` /
`danglingTextFormat`); pages with it are not edited. A level can be renamed, reordered or
added; it cannot be removed (even an unused one) — rejected with `UnknownTextLevel` before writing.

### System properties of a story text page

| Property  | Database type   | Purpose                                                                                                                                                             |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `level`   | Select          | The page's level in the work's hierarchy.                                                                                                                           |
| `parent`  | Relation (self) | The parent page in the same text database (one-way relation, maxItems: 1).                                                                                          |
| `order`   | Text            | Lexicographic sort key for the sequence order (e.g. `"a0"`, `"a1"`).                                                                                                |
| `format`  | Select          | The page format (`manuscript`, `screenplay`, `comic`, `note`).                                                                                                      |
| `status`  | Status          | Readiness status (groups `notStarted`, `inProgress`, `done`).                                                                                                       |
| `anchors` | Relation        | Optional. A relation to the shared «Якоря» (Anchors) database (W9, no limit on count, no reverse side); the property appears when the «Якоря» database exists (§6). |
| `arcs`    | Relation        | Optional. A relation to the shared «Арки» (Arcs) database (W9, likewise); appears when the «Арки» database exists (§6).                                             |

**Page rules.** A page is created (`create_text_page`) with its values and note in a single write; the order
key is a string of letters and digits up to 64 characters (a base-62 fractional index, compared bytewise; otherwise
`InvalidOrderKey`). A move (`move_text_page`) writes the parent and the key in a single write. The parent must sit
at a level shallower than the page (`ParentLevelNotShallower`; a level may be skipped, for example a scene directly under a
book), a cycle is rejected first (`ParentCycle`), a stale page gets `RevisionConflict` with the revision on
disk. A page with no parent, with a missing parent, or in a cycle caused by an external edit is shown at the
root. The UI checks the same rules in advance (`planMove`) and does not allow a move that the backend would reject.

---

## 6. Rules for links and relations (W5, W6, W8, W9)

### Links of entities with stories and universes (W5, W6)

**Properties.** The module finds the link properties not by name (the author may rename it) but by the
ID recorded in `amby-workshop.json`:

- the entry of every world section (characters, locations, arcs, anchors, notes, author sections) has
  `storiesPropertyId` — the ID of the «Истории» (Stories) property: a Relation to the `stories` database, with no limit on the number of
  targets and **no reverse side** (`inversePropertyId: null`). The link is written only into the entity's
  note; the story card is not edited;
- the entry of the `stories` section has `universePropertyId` — the ID of the «Вселенная» (Universe) property: a Relation to the
  `universes` database, at most one target (`maxItems: 1`), no reverse side. The property is created together
  with the «Вселенные» (Universes) database.

The property names are set by the UI language (`labels` `property:stories`, `property:universe`).
Creation: `init_workshop` — «Истории» on every world database and «Вселенная» on «Истории» (all databases are already
known to the operation, so no link is added later); `create_workshop_section` (an author section
and restoration) — «Истории» in the world database being created, and when «Вселенные» is created in a workshop without them —
also «Вселенная» in the «Истории» database. This is one journaled operation over several files (the new database, the manifest of
«Истории», the workshop file); the commit point is the workshop file; on a failure or crash at any step
both files are returned byte for byte.

**Membership.** An entity is in a story if at least one of these holds:

1. its «Истории» contains the ID of this story's card;
2. any link of a text page of **this story** points to it ("mention in the text"). Only
   the rows of the story's own text database are read; a mention writes nothing into the entity's note.

An entity is in a universe if it is in any story whose «Вселенная» = this universe.
The universe itself counts as lying in its own stories. "Standalone stories" is everything that is in no
universe: stories without a «Вселенная» value, and entities that lie in at least one such story or
in none at all; an entity lying both in a universe's story and in a standalone story is visible in both
scopes. Deleting a story or a universe deletes nothing (W12).

**Navigation (W6).** There is no "Story | Universe" switch; there are two axes. At the bottom of the panel, under "Create", is the
universes card: its list starts with a permanent item "Standalone stories" (it is not a universe, it is
always there and selected by default), then the universes from the «Вселенные» database (names are taken from the database rows) and
the action "New universe". The selected universe is the scope: its stories and everything related to them, plus its
events; "Standalone stories" is the scope of standalone stories. At the top is the stories card: "All stories" (all
stories of the scope) or one of the stories of the scope; the selected story narrows the scope down to itself. Priority: story >
universe > standalone stories; there is no "whole workshop" mode. If the selected story is not in the new scope
or has been deleted, it resets to "All stories"; a deleted universe resets to "Standalone stories". The choice is
remembered per vault (`story`: "all" or a story ID, `universe`: "standalone" or a universe ID;
«Вселенные» is not shown in the world list). An entity with no «Истории» link and no mention in any text is
shown only in "Standalone stories", as a separate group "No story" at the end. A row, when a universe
or all stories are selected, shows up to two story names and "+N". The same rules apply to the character and
location blocks on story and universe pages.

**Creating from the panel.** With a story selected, an entity is created by the `create_workshop_entity` command
with a link to the story card right away: the «Истории» value is written by the same action as the
note itself. With a universe or "Standalone stories" selected and no story selected, no link is written. If the section has no
`storiesPropertyId`, the command with a story is rejected (`storyLinksUnavailable`), and without a story it creates the
page as usual.

**A story created inside a universe gets its link immediately.** If a universe is selected when a story is created from the panel,
after `create_story` the «Вселенная» = the selected universe is written into the story card row in the «Истории» database
(`update_database_relation_value`, the full list of targets, the row revision is re-read).
If the stories section does not have a `universePropertyId` yet, `add_story_links` runs first. This is a separate write
after creation: its failure does not roll back the story, which stays (visible in "Standalone stories"), and the panel reports
the reason. With "Standalone stories" selected, no link is written.

**Workshops without the properties.** A workshop created before these fields appeared is not migrated.
For a section without `storiesPropertyId` (or the `stories` section without `universePropertyId` when «Вселенные»
already exists) the panel offers "Link". This is the journaled operation
`add_story_links` (modeled on `add_text_status`): `expectedWorkshopRevision`, a snapshot in history,
a log, a rollback. If the section's database already has a suitable relation (to the right database, with the right
limit, with no reverse side), the operation accepts it and changes only the workshop file;
otherwise it adds the property and records its ID.

### The rule for linking chapters to anchors and arcs (W9)

Since each story's text database is an isolated database with its own `databaseId`,
the standard core Relation property with a two-way `inversePropertyId` cannot link
one shared «Якоря» database with all the separate text databases.

- The links "chapter → anchors" and "chapter → arcs" are stored exclusively in the properties of the text pages of
  a specific story: «Якоря» (a Relation to the `anchors` database) and «Арки» (a Relation to the `arcs` database), with no
  reverse side and no limit on count. Their IDs are recorded in `amby-story.json` next to the status:
  `text.properties.anchors`, `text.properties.arcs`; the module finds them only by ID. If the property
  has been deleted from the database, the entry in the file is considered stale: the field in the catalog is empty, and the operation below
  creates the property again.
- The reverse view ("which chapters an anchor/arc takes part in") is built by a query over the projection.
- Linking and unlinking is writing the value of a page property (the existing relation-edit operation
  `update_database_relation_value` with the page's full list of targets; computing from the row on screen and the
  row revision protect other people's values). The anchor or arc value is not written into their note.

**Properties of the anchors and arcs themselves** (section entries in `amby-workshop.json`, optional and
additive): `anchors` has `arcsPropertyId` («Арки», a Relation to `arcs`, no reverse side) and
`universePropertyId` («Вселенная», a Relation to `universes`, `maxItems: 1`, no reverse side);
`arcs` has `charactersPropertyId` («Персонажи» (Characters), a Relation to `characters`). An anchor linked to a
universe is a universe event (W8).

**Lazy addition of links.** The «Арки», «Якоря» and «Вселенные» databases appear in any order (W11),
so the missing properties are added where it is a single operation, and on demand otherwise:

- `create_story`, if the «Якоря» and/or «Арки» databases already exist (and are on disk), immediately creates
  the text database with the needed properties and records their IDs in `amby-story.json`;
- creating «Якоря» after «Арки» and «Вселенные» puts «Арки» and «Вселенная» into the new database and records
  `arcsPropertyId` and `universePropertyId`; creating «Арки» after «Якоря» adds «Арки» to the «Якоря» database
  in the same journaled action (`manifest_write`) and records `arcsPropertyId`;
  creating «Арки» also records `charactersPropertyId` if the «Персонажи» database exists;
- in all other cases — the **`ensure_plot_links`** command (journaled: `operationId`,
  snapshot, a log with the manifest's original bytes, a byte-for-byte rollback; repeating with the same request
  returns the recorded result, with a different one — `OperationIdReused`). One target is one database and one structure file:
  - `target: "story"` (+ `storyId`, `expectedRevision` — the revision of `amby-story.json`): the story's text database
    and `amby-story.json`; adds «Якоря» and «Арки» for the databases that exist;
  - `target: "anchors"` (`expectedRevision` — the revision of `amby-workshop.json`): the «Якоря» database and the workshop
    file; adds «Арки» and «Вселенная» for the databases that exist.

  A suitable property that already exists (a Relation to the right database, with the right limit and no
  reverse side) is accepted: only the ID is written. If there is nothing to add, nothing is written and
  the revision is not checked (`changed: false`). The commit point is the structure file; a failure or crash before
  it returns both files byte for byte. The UI calls the operation on the first link (before writing
  the value) if the page's property does not exist yet.

**Membership and order of a story's anchors.** An anchor and an arc belong to a story the same way as a world entity
(§6): by the «Истории» link or by a link to a page of this story's text. The order of anchors in a
story (the pure model function `orderStoryAnchors`): an anchor linked to the story's pages sits
where the earliest of its pages sits in the text tree order (depth-first traversal); two anchors
on one page — in the order of the list on the page. Anchors with no pages of this story form the group "Ahead" in the
author's manual order (`manualOrder` of the database's first view), then by creation time and name.
An anchor of two stories sits in each by its pages there. Manual reordering works only
within "Ahead".

**Universe events and anchors without a story (part 6b).** An anchor with a «Вселенная» value
(`universePropertyId`) is an event of that universe (W8). `create_workshop_entity` accepts an
optional `universeId` (the ID of a note from the «Вселенные» database): only for the `anchors` section, only if
the section has a `universePropertyId` and the property is still in the manifest, and only for an existing note of
a universe; the value is written by the same write as the note, and any violation is rejected before writing
(`storyLinksUnavailable`, for a non-anchor — `invalidParent`). If the property is missing, the UI first calls
`ensure_plot_links` with target `anchors` and shows its error rather than skipping it. The same call is made
right after the lazy creation of «Вселенные» when «Якоря» exists and of «Якоря» when
«Вселенные» exists, if the anchors are still missing «Арки» or «Вселенная» (the pure `anchorLinksMissing`).
An anchor **without a story** has no «Истории» link, no link to a page of any text, and no
«Вселенная» link; in "Standalone stories" such anchors stand at the end as a separate group, preceded by the anchors
of standalone stories in the author's manual order; universe events are not shown there. With a universe selected,
the "Universe events" group is on top, then the anchors of its stories.

---

## 7. Name collision resolution rule (W10)

In a shared workshop database (for example "Anchors" or "Characters"), different stories may contain
entities with the same names (for example an event "Finale" or a character "Alex"):

1. **File name:** The file system requires paths within one folder to be unique. The
   `unique_row_path` mechanism automatically resolves collisions by adding a numeric suffix:
   `Финал.md`, `Финал 2.md`, `Финал 3.md`.
2. **Display name:** The note's frontmatter always keeps the author's original title:
   `amby-title: "Финал"`.
3. **Display in the interface:** All views of the creative module (manuscript tree, dossier,
   link lists, search, database tables) use `display_title` (`amby-title`), so the
   user always sees the clean authored title "Финал" (Finale) everywhere, without system numeric indexes.
   The creation path from the panel (`create_workshop_entity`) goes through the same row write as
   `create_database_row`, so the rule applies to all shared databases; it is checked by the test
   `two_pages_with_one_title_in_a_shared_database_get_two_files_and_show_one_title`.
4. Splitting entities into story subfolders inside shared databases is not used (W10).

---

## 8. Notes and notebooks (W7)

- The "Notes" database is shared across the workshop, with a multi-link "Stories" (§6).
- A **notebook** is a subfolder inside the "Notes" database folder (`Заметки/Идеи/`); nested notebooks are
  allowed (`Заметки/Идеи/Сюжеты/`). Notebooks are shared across the workshop, not per story. A notebook stores nothing
  but the folder: no file, no entry in `amby-workshop.json`, no note property.
- **Membership.** A note in a notebook remains a row of the "Notes" database; its place in the notebook is
  the row's `category_path` (`["Идеи", "Сюжеты"]`), and a note at the database root is "without a notebook". The link
  "Stories" does not depend on the notebook: one note can lie in a notebook and be linked to
  any stories, and moving it to another notebook does not change the links.
- **What counts as a notebook.** A visible folder of the database that is not a symbolic link, does not contain
  another database's manifest, and is not a note folder with attachments (it holds a same-named
  `<name>.md`). Hidden and service folders (`.ambd` and others) are not listed. An empty notebook is still
  a notebook: the list of notebooks is taken from folders, not from the rows' `category_path`.
- **Reading the list.** `list_notebooks(databaseId)` (read-only): the database folder is taken from the index and
  checked to be inside the vault, the walk does not follow links, goes no deeper than 12 levels and returns no
  more than 2000 notebooks (otherwise `truncated`). For each notebook it returns the names from the database
  root (`segments`), the path on disk and `itemCount` — the number of items directly in the folder other than notebooks
  (notes, their attachment folders, any other files). Hidden files (`.DS_Store`) are not counted.
- **Creating a note in a notebook.** `create_workshop_entity` accepts an optional `notebook` —
  folder names from the database root (`[]` or absent — the root). Before any write, each name goes through
  the folder-name check (`normalize_entry_name`; `..`, `/`, hidden and reserved names are
  rejected, and the name must not change when whitespace is trimmed), each folder must exist and be
  an ordinary visible notebook folder inside the database (after canonicalization), and the section must be the database
  "Notes". Otherwise `InvalidName` / `InvalidParent`, and nothing on disk changes. The link to the story
  is written in the same write as the note. A duplicate name gets `Имя 2.md` inside the notebook folder
  (identical names in different notebooks are not renamed).
- **Creating, renaming and deleting a notebook are ordinary vault file operations**
  (folder creation, rename with link updates, move, trash); the module has no write paths
  of its own:
  - the panel checks the notebook name before writing by the same rules as a folder name; a case-insensitive match with
    a neighboring notebook is refused;
  - renaming is in place only, inside the database;
  - moving a note between notebooks is a file move with link updates; a name clash
    in the target notebook is refused without overwriting; the open note stays open at its new path
    (the same path as in the file tree);
  - **deleting a notebook does not delete notes.** Before any write it checks that the notebook and the nested ones contain only
    notes (by the number of items on disk and database rows), that the list of notes is
    complete, and that on moving to the parent no name will clash (neither with a note, nor with a neighboring
    notebook, nor among the notes being moved). If not, it is refused with a list of titles. Otherwise, after
    confirmation, the notes are moved to the parent, the folder list is read again, and only if the
    notebook and the nested ones are empty does the folder go to the trash (recoverable; "permanent" deletion from
    settings is replaced by the vault trash for this). An interrupted move does not touch the folder:
    each note lies either at the old or at the new place, and the user gets a message.
- Cross-cutting note themes are expressed with standard tags (`tags` in frontmatter).

---

## 9. Legacy format and corrupted data

### Format v2 projects (`amby-project.json`, nested model)

Starting with the version after 0.1.9, format v2 is neither read nor diagnosed: the file
`amby-project.json` is ignored by the module and not changed. The folders, notes and databases of such a project stay
ordinary: they are visible in the file tree and open like any databases.

- The name `amby-project.json` is still reserved: a new workshop, section
  or story folder cannot be given this name.

### Catalog diagnostics

Discovery (`discovery.rs`) only reads: it fixes nothing and writes nothing. Each finding is a record
`ProjectDiagnostic { code, severity, path, workshopId?, storyId?, detail? }`; the interface shows a counter
and an expandable list (`creative.diagnostic.<code>`, an unknown code is shown as is).

| Code                                                        | Severity | When                                                                                                                       | What happens                                                                                                        |
| ----------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `symlinkIgnored`                                            | warning  | `amby-workshop.json` is a symbolic link                                                                                    | the workshop is not shown                                                                                           |
| `unreadableWorkshopFile`                                    | error    | the file cannot be read                                                                                                    | the workshop is not shown                                                                                           |
| `invalidWorkshopFile`                                       | error    | not JSON, larger than 1 MiB, missing `formatVersion` / `workshopId` / `name`                                               | the workshop is not shown                                                                                           |
| `duplicateWorkshopId`                                       | error    | a second file with the same `workshopId` (a folder copy)                                                                   | the first by depth and path stays, the copy is not shown                                                            |
| `otherWorkshop` (interface)                                 | warning  | a marker of a different workshop than the one named in the setting was found (§2.1)                                        | the workshop is not used, its files are not read into the panel and are not changed                                 |
| `unsupportedFormatVersion`                                  | warning  | `formatVersion` is not 3                                                                                                   | the workshop is read-only (`WorkshopReadOnly` on write)                                                             |
| `invalidSection`, `duplicateSectionId`, `unsafeSectionPath` | warning  | a `sections` entry is incomplete, repeated or has an unsafe path                                                           | the entry is skipped, the others work                                                                               |
| `storyMissingMainFile`                                      | warning  | the story folder has no `<Имя>.md`, but has `amby-story.json` or `<Имя>.json`                                              | the story is not shown; the pages remain ordinary notes (file tree)                                                 |
| `storyMissingConfigFile`                                    | warning  | there is a card, but no `amby-story.json`                                                                                  | the story is not shown                                                                                              |
| `brokenManifest`                                            | error    | `amby-story.json` cannot be read or parsed — **or** the text database manifest `<Имя>.json` is missing or cannot be parsed | in the first case the story is not shown; in the second it is shown without a text database (`databaseId` is empty) |
| `duplicateStoryId`                                          | error    | a second `amby-story.json` with the same `storyId`                                                                         | the copy is not shown                                                                                               |
| `missingTextProperty`                                       | warning  | a property from the `text` block (`detail` is the key) is not found in the database                                        | the catalog field is empty; the entry in the file is not touched                                                    |
| `danglingTextLevel`, `danglingTextFormat`                   | warning  | a Select option from `text.levels` / `text.formats` was deleted in the database                                            | the entry stays in the file, the option is `dangling`; pages that use it are not edited                             |

The damage is isolated: the other workshops, stories and databases keep working. There is no automatic recovery;
the card's `amby-story-id` is not yet used to recreate the settings file (§5).

### A missing or moved section database

The catalog matches a section to a database by `databaseId` (via `db_databases`), not by `path`:

- a database found at the recorded path — `ok`; found elsewhere — `moved` (it works, the tooltip shows the new path);
- no database with such an ID — `missing`. The entry stays in the file, and the section tab is marked with a warning and
  explains "put the folder back and the section will work". There is no separate diagnostic for this, and the database is not recreated
  by the module itself. The author can remove the entry in the workshop settings (`remove_workshop_section`;
  the folder and data stay); the role is freed only after that, and then the section can be created again.

### A version above the known one

A workshop or story with a `formatVersion` other than 3 opens read-only: a write answers
`WorkshopReadOnly` / `StoryReadOnly`, and the file is not rewritten. The workshop page shows a badge
"format newer than known".

### Deleting a story or universe (W12)

Deleting a story or universe card cleans up only the story/universe itself. World entities
(characters, locations, arcs, anchors) that referenced it are **not deleted**: the identifiers stay in
frontmatter, the module does not clean them; the author removes such a link by editing the property.

---

## 10. Rust layer and transactionality

Commands in `src-tauri/src/commands/project.rs` (types in `project/model.rs`, bindings are generated by Specta into
`src/lib/bindings.ts`, port in `src/lib/storage/project-port.ts`). All require the databases module to be enabled
(`ModuleDisabled`) and an open vault; write commands and `refresh_projects` also accept
`expectedGeneration` (`VaultGenerationConflict` if the vault changed). `resolve_workshop_folder` checks only for an open vault. The reads `list_projects`,
`list_note_references`, `list_text_stats` and `list_notebooks` do not check the generation.

| Command                                                                   | Purpose                                                                                                                           | Journal            |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `list_projects`, `refresh_projects`                                       | the catalog from the index; the second first rebuilds the index from files                                                        | no                 |
| `init_workshop`                                                           | the folder at `path`, `amby-workshop.json`, all seven databases with templates and all links (§2.1, §4); name = folder name       | yes                |
| `complete_workshop`                                                       | missing databases and links through the existing operations below; changes nothing in what exists                                 | yes (step by step) |
| `resolve_workshop_folder`                                                 | a folder chosen in the dialog → a path inside the vault (read-only)                                                               | no                 |
| `create_story`                                                            | the folder, the card, the text database manifest, `amby-story.json`                                                               | yes                |
| `create_workshop_section`                                                 | a new database and an entry in the workshop file; for "Universes" and "Arcs" also a link in another database                      | yes                |
| `update_workshop`, `reorder_workshop_sections`, `remove_workshop_section` | title, icon, tags; order of entries; remove an entry (not the folder); "Stories" cannot be removed (`CannotRemoveStoriesSection`) | yes                |
| `update_text_levels`, `add_text_status`                                   | text levels; the status property for an old story                                                                                 | yes                |
| `add_story_links`, `ensure_plot_links`                                    | the "Stories" / "Universe" properties; "Anchors" / "Arcs" (§6)                                                                    | yes                |
| `create_workshop_entity`                                                  | a world section page with links in one write (`storyId`, `notebook`, `universeId`)                                                | no                 |
| `create_text_page`, `move_text_page`                                      | a text page; parent and order in one write (§5)                                                                                   | no                 |
| `list_note_references`, `list_text_stats`, `list_notebooks`               | a note's links in both directions (dossier); page words and times; notebooks of the "Notes" database (§8)                         | no                 |

Operations without a journal write one file (or one database row) and are protected by the row revision.

**Journal.** Operations with a journal run as one transaction: a pre-check with no writes (generation,
names, parent, case-insensitive match, revision), the journal `.amby/recovery/creative/<operationId>.json`
(without overwriting; recovery also reads the former `.amby/recovery/projects/` folder), folders and databases with
identifiers from the journal and, at the end, the structure file. The commit point is the structure file reaching the
planned bytes: an error after it still answers success. Before it, the rollback (`recovery::rollback`)
removes only what the operation created: the manifest if it is byte-for-byte equal to the one recomputed from the journal, the folder
if it is empty; everything else stays, the answer is `RecoveryRequired`, and the journal is kept. Operations that change the
manifest of an existing database (`add_text_status`, `update_text_levels`, `add_story_links`, `ensure_plot_links`,
creating "Universes", creating "Arcs" when "Anchors" exist) record the manifest's original bytes
in the journal and restore them on rollback.

- Resuming an operation with the same `operationId` after a crash takes the planned IDs and the bytes of the
  workshop file from the journal (like `create_story`): the same set of databases, the same property IDs.
- Repeating a command with the same `operationId` and the same request returns the saved result
  (`replayed`); with a different request — `OperationIdReused`.
- When a vault is opened, `recover_pending_projects` walks the journals: it rolls back unfinished ones or
  recognizes them as complete, and moves those that could not be cleaned up to a `quarantine/` folder next to them. This does not block
  opening the vault.
- The workshop projection (the `project_*` tables in the SQLite index) is a rebuildable cache: it is rebuilt in one
  transaction when a vault is opened, on `refresh_projects` and after every creation; the watcher
  sends a `project:changed` event (a structure file changed, or a folder was created, deleted or renamed),
  and the interface debounces it and calls `refresh_projects`. Journals, unlike the index, cannot be rebuilt.

**Errors** (`ProjectError`, the `kind` field): `ModuleDisabled`, `VaultNotOpen`, `VaultGenerationConflict`;
`InvalidOperationId`, `OperationIdReused`; `InvalidName {field, reason}`, `InvalidParent`, `PathCollision`;
`WorkshopNotFound`, `StoryNotFound`, `SectionNotFound`, `PageNotFound`; `WorkshopReadOnly`, `StoryReadOnly`;
`RevisionConflict {actualRevision}`; `UnsupportedRole`; `CannotRemoveStoriesSection`; `StatusAlreadyConfigured`,
`StoryLinksAlreadyConfigured`, `StoryLinksUnavailable`; `TextNotConfigured`, `UnknownTextLevel`,
`UnknownTextFormat`, `InvalidOrderKey`, `ParentCycle`, `ParentLevelNotShallower`; `RolledBack`,
`RecoveryRequired`; `Failed {code, message}` for the rest (for example `sectionAlreadyExists`,
`missingStoriesSection`, `textSchemaBroken`, `interrupted`). The variants `UnsupportedPreset`,
`CannotRemoveTextSection` and `LevelInUse` are declared, but the current code does not return them.

---

## 11. Dossier and page plot

The dossier is editor presentation, not data: a frame around the note editor (the shell's `editorFrame`),
in which blocks are computed on demand and write nothing into the note. The frame is the same structure for
any note, so the editor is not recreated when the answer arrives; the blocks sit on the right, and on a narrow
panel (under 640 pixels) they move below the text. The backend is queried only if the vault has
workshops, and only a note of a workshop section gets the presentation.

**A world-section page** (everything except text, notes and "Stories" («Истории»)): a header with the value of the key
properties, blocks "Sections" («Разделы», the page headings), "Appears in" («Появляется в», text pages that link to it) and
"Links" («Связи», the other links in both directions). Additionally, depending on the section's role:

- **Character** — an "Arcs" («Арки») block: arcs whose "Characters" («Персонажи», `charactersPropertyId` of the `arcs` section)
  contains the character, with the arc colour (`arcColor`). These are incoming links through that property, so
  they are not in "Links" either; with no arcs there is no block.
- **Arc** — blocks "Arc anchors" («Якоря арки») and "Chapters" («Главы»). The arc's anchors are the anchors whose "Arcs" (`arcsPropertyId`
  of the `anchors` section) contains the arc; their order is set by each story's text (`orderStoryAnchors`), stories
  go in catalogue order (with several of them, with the story title), and anchors not attached to any page
  go at the end under the label "Not attached to the text" («Не привязаны к тексту»). "Chapters" are the text pages where the arc is attached, by
  story in text order; if there is more than one page, a span label "from … to …" («от … до …», the first and the last).
  "Appears in" for an arc is replaced by "Chapters", and incoming links from anchors are not repeated in "Links".

**A story text page**, if the workshop has an anchors or arcs database, gets a "Page plot" («Сюжет страницы») block
modelled on the dossier: "This page's anchors" («Якоря этой страницы», in the order of the list on the page), "Starting from" («Отталкиваемся от», the nearest
attached anchor before the page in text order, not counting the page's own anchors), "Must arrive at" («Должны прийти к», the nearest
one after; if there is none — the first "Ahead" («Впереди») anchor) and the page's "Arcs" with colour. An anchor stands
where the earliest of its pages stands (`pageNeighbours`). An empty block is shown as a quiet line; the whole
block is not shown if the workshop has no anchors and no arcs at all. Each item opens
its own page. The data comes from the same rows the panel reads (the text database, anchors, arcs) and from the
catalogue; there is no new IPC.

## 12. Module pages (tab targets)

A page is a tab with the identifier `creative:<target>`; the target determines what the tab shows. This is
presentation, not data: nothing is written to files except the author's actions ("New story" («Новая история»), "New
event" («Новое событие»), "Add: …" («Добавить: …»)), which make the same writes as the panel. The target is parsed by
`resolveProjectTarget` (`project-tree-model.ts`); a target that is not in the catalogue yields "Workshop not found" («Мастерская не найдена»).

| Target                     | Page                                                          | Page and tab title                                                                                       | Settings |
| -------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------- |
| `<workshop id>`            | overview: stories, all sections in full, "Section" («Раздел») | the workshop title                                                                                       | yes      |
| `<story id>`               | the story's desk                                              | the story title                                                                                          | yes      |
| `universe:<note id>`       | universe page                                                 | the row title in the "Universes" («Вселенные») database ("Universe" («Вселенная») until the row is read) | no       |
| `standalone:<workshop id>` | standalone stories page                                       | "Standalone stories" («Отдельные истории»)                                                               | no       |

- **Page scope** — the same as in the panel (`PanelFilter`, `buildMembership`, `scopeEntities`,
  `bucketAnchors`): a story, a universe (its stories) or standalone stories (without a "Universe" link). The page
  reads the rows once (`useScopeData`) and shares them between the overview and the section tabs, so the page and the panel do not
  disagree about what belongs to what. An entity outside all stories is visible only in the "Standalone stories" scope,
  in the group "<Section>: no story" («<Раздел>: без истории»).
- **Tabs of a story, a universe and standalone stories** — only the sections where their page can live (the world
  categories, "Anchors" («Якоря»), "Notes" («Заметки»); not "Stories", not "Text" («Текст»), not "Universes"). A tab shows the pages of the scope, not the whole
  shared database; the whole database is the "Whole database" («Вся база») button, which leads to the workshop page. Whole sections (`DatabaseWorkspace`)
  are shown only by the workshop page. The story's text is on the desk and in the panel.
- **Universe page**: the universe's stories, "New story" (created immediately with a "Universe" link via
  `add_story_links` when needed and `update_database_relation_value`; a link failure does not roll the story back, the page
  states the reason and stays), "Universe events" («События вселенной», anchors with this "Universe", "New event"), the world by the universe's
  scope. The icon is a globe: a database row has no note icon.
- **Standalone stories page**: stories without a universe, "New story" (no link is written), the world of this scope and
  the "No story" («Без истории») group. Universe events are not shown here. A world page can be created in any list
  (it is born without a story, that is, in the "No story" group); world pages are not created from a universe page —
  a universe has no story of its own, and a link needs a story.
- **Header** is the same for all pages (`page-header.tsx`): icon, title (a long one wraps), a quiet "kind · numbers" line
  (story: pages and words; universe: stories and events; standalone stories: stories; workshop: stories and sections).
  The "Settings" («Настройки») button is on the workshop and the story; "Section" only on the workshop.
- **Panel "open" buttons**: the universes card — the universe page or, for "Standalone stories",
  `standalone:<workshop>`; the stories card — the story page, with "All stories" («Все истории») the page of the scope's universe or
  of standalone stories. The workshop page is opened by the button next to the panel title (beside the module settings).
