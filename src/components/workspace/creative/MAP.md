# Creative map

Owns the official `amby.creative` module: the sidebar section, the project page and the
dialogs that create projects and sections. Everything durable is Rust: discovery, creation,
recovery and the index live in the [project backend](../../../../src-tauri/src/project/MAP.md)
and arrive through [project-port.ts](../../../lib/storage/project-port.ts). The contract is the
[format v2 draft](../../../../docs/creative-format.md); the stages are in the
[redesign plan](../../../../docs/creative-module-claude-plan.md).

| Concern                                 | Owner                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Module registration (panel `creative`)  | [creative-module.tsx](creative-module.tsx)                                                                     |
| Catalog state and lifecycle             | [project-store.ts](project-store.ts), [use-project-controller.ts](use-project-controller.ts)                   |
| Panel: header, "Create", switcher       | [creative-panel.tsx](creative-panel.tsx), [creative-scope-picker.tsx](creative-scope-picker.tsx)               |
| "Create" chooser                        | [create-chooser-dialog.tsx](create-chooser-dialog.tsx)                                                         |
| Panel state (scope, tab, filter), prefs | [creative-nav-store.ts](creative-nav-store.ts), [creative-scope-storage.ts](creative-scope-storage.ts)         |
| Scopes, section grouping (pure)         | [project-tree-model.ts](project-tree-model.ts)                                                                 |
| Workshop: tabs, lists, text tree        | [workshop/](workshop/): `workshop-pane.tsx` composes; models are `workshop-model.ts`, `text-tree-model.ts`     |
| Project tab: header, sections, overview | [project-page.tsx](project-page.tsx); a story's desk: [project-desk.tsx](project-desk.tsx)                     |
| Project settings dialog                 | [project-settings-dialog.tsx](project-settings-dialog.tsx)                                                     |
| Words and last-change time of pages     | [use-text-stats.ts](use-text-stats.ts) (one read-only call over the note index)                                |
| Create project / section                | [create-project-dialog.tsx](create-project-dialog.tsx), [create-section-dialog.tsx](create-section-dialog.tsx) |
| Text schema of a new story (levels)     | [text-schema-presets.ts](text-schema-presets.ts); chosen in `create-project-dialog.tsx`                        |
| Names in the active language            | [project-labels.ts](project-labels.ts); `creative.*` keys of `locales/resources.ts`                            |
| Errors, operation IDs                   | [project-error.ts](project-error.ts), [use-operation-id.ts](use-operation-id.ts)                               |
| Dossier of a world page                 | [dossier/](dossier/)                                                                                           |
| File tree: icons, hiding                | [creative-tree-model.ts](creative-tree-model.ts), [use-creative-tree-items.ts](use-creative-tree-items.ts)     |
| Collection folder opens the workshop    | [use-collection-folder-select.ts](use-collection-folder-select.ts)                                             |
| Settings (`moduleSettings.creative`)    | [creative-settings-store.ts](creative-settings-store.ts), [creative-settings.tsx](creative-settings.tsx)       |
| Section icons                           | [section-icons.ts](section-icons.ts)                                                                           |

**Data flow.** `useProjectController` (mounted in `workspace-orchestration.tsx`) reads the
catalog once the database catalog is ready, re-reads it when the databases change, and calls
`refreshProjects` after the debounced `project:changed` event. After a write the dialogs
call `onCreativeChanged` (tree and database catalog) and then the store's `refresh`, and only
then open the page, so it never opens on a project the catalog does not know yet.

**The page does not own a database view.** A section is rendered by the shell's
`renderDatabase` as the ordinary `DatabaseWorkspace` (with `hideHeader` and `toolbarHost`), so every layout,
filter and row action is the database's own while its view settings icon sits at the right end of the
section tabs bar (using the compact toolbar actions inside `ViewSettingsPanel`). A project tab is `kind: "creative"` with
`fileId` `creative:<projectId>`; the section shown is `creative-nav-store`.

**File tree.** Creative folders are ordinary folders on disk, so the module marks them in a view-only
pass (`applyCreativeTree`): project folders by vault-relative path, section databases by
`databaseId`. The orchestration hands the result to the file panel as `fileTreeItems`; while the
module is off the vault's own tree passes through untouched. An icon the author chose is kept. With
`showInTree` off the folders are left out of that tree only; search, quick open and file actions
still see everything, nothing is written. The setting is saved in the settings window and announced
to the main window by an event. A collection's folder carries `statusIcon` (the glyph at the end of
its row); selecting it brings the workshop forward with that collection chosen and opens its page.
Every other folder, and every folder while the module is off, selects as before.

**Workshop panel.** One column under the one search (`search-results.tsx` replaces it while it has
text; session state). Top: the chosen story's header (`story-header.tsx`: icon, name, one quiet line
of label, pages, words, each shown once read; a list of the scope's stories when there are several,
ending with "New story"; the choice is `storyFilter`, per vault). Then "Story" with three folding
parts: _text_ is the whole text as one tree from `buildTextTree`, every page once (a page without a
parent or a level is a root), with the level icon and word count (`use-text-stats.ts`) on each row, the
open page marked, its parents unfolded and the row scrolled into view once per change, and drag-and-drop
(`move_text_page`, after `planMove` refused what the backend would). Its "+" makes a top-level page
(`defaultLevelId`), a row's "+" one inside; a last-level page has none (`canHaveChildPage`). _anchors_
and _notes_ list their sections; anchors keep the author's order: the first view's `manualOrder`
(`use-view-order.ts`, dragging writes it through `updateDatabaseViewConfig`), else creation order
(`orderByAuthor`). An empty list offers "Add the first …" (`empty-action.tsx`) in place of a plain
sentence, unless the story is read-only. Under them the **world** (`world-section.tsx`, caption "World"
with the compact story/universe switch): one folding list per category, merged by role or, for an
author's section, by name; the switch narrows lists to the story's own pages and those its text
relates to, or widens them to the universe, with story labels; a shared page no text names yet stays
in its importance group marked "not in the text" (`isUnplaced`). A category where some page has a
picture shows a 20 px round face on every row (`portrait-dot.tsx`: `resolveGalleryPreview`, else
initials; one batched resolver per database, only rows of unfolded categories). Lists read the
databases through the ordinary query; nothing keeps a copy of a page. Unfolded parts and the switch are
remembered per vault (`works`: "text", "anchors", "notes"; the older "books"/"arcs" read as "text").
Every page row has a context menu (`item-menu.tsx`: open, open in a new tab, rename, delete, and for text
pages with a `status` property, status options written via `applyDatabaseValueBatch`; a page with
pages below it is deleted with them, after one confirmation naming them); a leaf text page's dot is colored
by its status group (`pageStatusDotClass` from `text-tree-model.ts`, falling back to word-count presence
when the story has no status property); the empty space has a menu that
creates with the "Create" options (`useChooserOptions`: a page or a world page first as a 2-column tile grid
with section role icons in `create-chooser-dialog.tsx`, a story, section, universe, collection after as
compact menu rows).

**Creating where it will stand.** A page, note, anchor or world page is named on a row of its own
(`inline-create-row.tsx`, one `WorkshopDraft` in `workshop-pane.tsx`): Enter creates, Escape cancels, a
failure stays on the row under the typed name. A page starts one level below its parent
(`startLevelId`) in the manuscript format, not asked for. The field ignores a blur in its first 300 ms:
the menu or dialog it came from is still closing and takes focus back.

**Names.** The folder of a base section is named once, at creation, so the dialog resolves
the names from the active language and sends them as `labels`; the backend only has Russian
fallbacks. Add a language by adding the `creative.*` keys, not by touching Rust.

**Levels of a new story.** For a story the dialog also asks for the text schema: Novel (Book →
Chapter → Scene, the default), Short story (one level, Page), Comic (Book → Arc → Chapter → Page) or
Custom (an editable list, 1 to 6 names; it starts from the schema chosen before). The chain is shown
under the choice, and the names are sent as `textLevels` already resolved in the active language (not
as `level:*` labels, which the backend limits to the template's four). `levelsProblem` mirrors what
the backend refuses (empty, repeated, more than six) so Create stays disabled; the list is part of
the operation-ID payload. Nothing in the panel assumes four levels.

**Project settings.** `project-settings-dialog.tsx` opens from the "Settings" button in `project-page.tsx`
(disabled on read-only projects) with tabs for basics (`updateProject`: name, icon, tags), sections
(`reorderProjectSections`, `removeProjectSection` without deleting the database folder), and, on a story
with a text section, text levels (`updateTextLevels`: rename, change icon, reorder, add, remove unused
levels) and adding the `status` property (`addTextStatus`) to older stories.

**Operation IDs.** One per intent: a retry of the same request reuses it (Rust then returns
the recorded answer), a changed request gets a new one because Rust refuses to reuse an ID
for a different payload.

**Dossier.** `DossierFrame` is passed to the editor as `editorFrame` (see
[document-body.tsx](../editor/document-body.tsx)) and wraps it in a structure that is the same
for every note, so the editor is never remounted when the answer arrives. It asks the backend
only when projects exist, shows nothing for notes outside the world sections, and lays the side
blocks out by the width of its own pane.

[fractional-index.ts](../../../lib/storage/fractional-index.ts) orders the pages of the text;
[manuscript-compiler.ts](../../../lib/storage/manuscript-compiler.ts) turns the tree into one Markdown
document by tree depth (it reads, it never writes; a page it cannot read stops it, naming the page).

**Story desk.** The overview of a story with a text is `ProjectDesk`: the pages changed last
("continue with"), pages, words, done pages (`done` status group count when the text has a `status`
property) of the text and of each top-level page, and "Compile manuscript":
`readNote` for every page in tree order, then `exportTextFile` (the save dialog), so a new file is the
only thing written. The numbers come from `list_text_stats` (note index), not from reading files.

Do not reintroduce a single entities database, type overlays, `.amby-creative/` metadata or
project creation from the renderer; discovery and creation belong in Rust.
