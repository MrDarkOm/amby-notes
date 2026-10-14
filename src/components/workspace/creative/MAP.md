# Creative map

Owns the official `amby.creative` module: the sidebar section, the project page and the
dialogs that create projects and sections. Everything durable is Rust: discovery, creation,
recovery and the index live in the [project backend](../../../../src-tauri/src/project/MAP.md)
and arrive through [project-port.ts](../../../lib/storage/project-port.ts). The contract is the
[format v3](../../../../docs/creative-format.md); the stages are in the [plan](../../../../docs/creative-workshop-plan.md).

| Concern                                 | Owner                                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Module registration (panel `creative`)  | [creative-module.tsx](creative-module.tsx)                                                                       |
| Catalog state and lifecycle             | [project-store.ts](project-store.ts), [use-project-controller.ts](use-project-controller.ts)                     |
| Panel: header, "Create", workshops      | [creative-panel.tsx](creative-panel.tsx), [creative-scope-picker.tsx](creative-scope-picker.tsx)                 |
| "Create" chooser                        | [create-chooser-dialog.tsx](create-chooser-dialog.tsx)                                                           |
| Panel state (scope, tab, filter), prefs | [creative-nav-store.ts](creative-nav-store.ts), [creative-scope-storage.ts](creative-scope-storage.ts)           |
| Workshop scopes, section groups (pure)  | [project-tree-model.ts](project-tree-model.ts)                                                                   |
| Workshop: tabs, lists, text tree, notes | [workshop/](workshop/MAP.md): `workshop-pane.tsx` composes; models: `workshop-model.ts`, `text-tree-model.ts`    |
| Belonging to stories and universes      | `workshop-model.ts` (`resolvePanelFilter`, `buildMembership`, `scopeEntities`, `storyLabels`); `world-cards.tsx` |
| Universe page (stories, events, world)  | [universe-desk.tsx](universe-desk.tsx)                                                                           |
| Project tab: header, sections, overview | [project-page.tsx](project-page.tsx); a story's desk: [project-desk.tsx](project-desk.tsx)                       |
| Project settings dialog                 | [project-settings-dialog.tsx](project-settings-dialog.tsx)                                                       |
| Words and last-change time of pages     | [use-text-stats.ts](use-text-stats.ts) (one read-only call)                                                      |
| Create project / section                | [create-project-dialog.tsx](create-project-dialog.tsx), [create-section-dialog.tsx](create-section-dialog.tsx)   |
| Text schema of a new story (levels)     | [text-schema-presets.ts](text-schema-presets.ts); chosen in `create-project-dialog.tsx`                          |
| Names in the active language            | [project-labels.ts](project-labels.ts); `creative.*` keys of `locales/resources.ts`                              |
| Errors, operation IDs                   | [project-error.ts](project-error.ts), [use-operation-id.ts](use-operation-id.ts)                                 |
| Dossier of a world page                 | [dossier/](dossier/)                                                                                             |
| File tree: icons, hiding                | [creative-tree-model.ts](creative-tree-model.ts), [use-creative-tree-items.ts](use-creative-tree-items.ts)       |
| A workshop folder opens that workshop   | [use-collection-folder-select.ts](use-collection-folder-select.ts)                                               |
| Settings (`moduleSettings.creative`)    | [creative-settings-store.ts](creative-settings-store.ts), [creative-settings.tsx](creative-settings.tsx)         |
| Section icons                           | [section-icons.ts](section-icons.ts)                                                                             |

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
to the main window by an event. A workshop's folder carries `statusIcon`; selecting it opens that workshop. Every other folder, and every folder while the module is off, selects as before.

**Workshop panel.** One column under the one search (`search-results.tsx` replaces it while it has
text; session state). Top: the chosen story's header (`story-header.tsx`: icon, name, one quiet line
of label, pages, words, each shown once read; a list of the scope's stories when there are several,
ending with "New story"; the choice is `storyFilter`, per vault). Then "Story" with three folding
parts: _text_ is the whole text as one tree from `buildTextTree`, every page once (a page without a
parent or a level is a root), with the level icon and word count (`use-text-stats.ts`) on each row, the
open page marked, its parents unfolded and the row scrolled into view once per change, and drag-and-drop
(`move_text_page`, after `planMove` refused what the backend would). Its "+" makes a top-level page
(`defaultLevelId`), a row's "+" one inside; a last-level page has none (`canHaveChildPage`). _anchors_
stand where the text puts them, with the rest "Ahead" in the author's order (`manualOrder`); _notes_ show
notebooks. Anchors, arcs and their marks in the tree: [workshop map](workshop/MAP.md). An empty list offers "Add the first …" (`empty-action.tsx`). Under them the **world** (`world-section.tsx`, caption "World"):
one folding list per category (by role, or by name for an author's section). The list at the top
(`story-header.tsx`) is the one filter: a story, a universe or the whole workshop (`resolvePanelFilter`:
`storyFilter` is a story ID, `"all"` or unset = the first story; a universe wins). A page is in a story when
its "Stories" relation (`storiesPropertyId` of the section) holds the story's card or a relation of that
story's own text points at it; in a universe through a story whose "Universe" relation
(`universePropertyId`) is it (`buildMembership`, `scopeEntities`, on rows already held; one story's text is
read for a story, every text for a universe or "all"). "All" ends with the group "No story"; "all" and
universe rows end with up to two story names and "+N". A page made under a shown story goes through
`createWorkshopEntity` with its `storyId`, so the relation is written with the note. A section of an older
workshop offers "Link to stories" (`addStoryLinks`). The story and universe pages (`project-desk.tsx`,
`universe-desk.tsx`) use the same functions. A category where some page has a
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
with section role icons in `create-chooser-dialog.tsx`, a story, universe, section and workshop after as
compact menu rows).

**Creating where it will stand.** A page, note, anchor or world page is named on a row of its own
(`inline-create-row.tsx`, one `WorkshopDraft` in `workshop-pane.tsx`): Enter creates, Escape cancels, a failure stays on
the row. A page starts one level below its parent (`startLevelId`).

**Names.** A base section's folder is named once, at creation: the dialog sends the names of the active language as
`labels` (the backend only has Russian fallbacks). Add a language with `creative.*` keys, not in Rust.

**Levels of a new story.** The dialog asks for the text schema: Novel (Book → Chapter → Scene, the default), Short story
(Page), Comic (Book → Volume → Chapter → Page; "Arc" belongs to story arcs) or Custom (1 to 6 names). The names go as `textLevels` in the active
language; `levelsProblem` mirrors what the backend refuses; the list is part of the operation-ID payload.

**Project settings.** `project-settings-dialog.tsx` (the "Settings" button of `project-page.tsx`, off on
read-only projects): basics (`updateProject`), sections (reorder, remove without deleting the folder) and,
on a story, text levels (`updateTextLevels`) and the `status` property (`addTextStatus`).

**Operation IDs.** One per intent: a retry reuses it (Rust answers from the record), a changed request gets a
new one (Rust refuses an ID for a different payload).

**Dossier.** `DossierFrame` is the editor's `editorFrame` (see [document-body.tsx](../editor/document-body.tsx)):
one structure for every note, so the editor is never remounted when the answer arrives. It asks the
backend only when projects exist (`useNotePlace`) and shows nothing outside the world sections, except the plot
aside of a page of a story's text (`text-page-aside.tsx`; only where anchors or arcs exist). An arc's page also shows
its anchors and chapters and a character's its arcs (`plot-blocks.tsx`); [format §11](../../../../docs/creative-format.md).

[fractional-index.ts](../../../lib/storage/fractional-index.ts) orders the pages of the text;
[manuscript-compiler.ts](../../../lib/storage/manuscript-compiler.ts) turns the tree into one Markdown
document by tree depth (it reads, it never writes; a page it cannot read stops it, naming the page).

**Story desk.** `ProjectDesk`: the pages changed last, pages, words and done pages (from `list_text_stats`, not
from reading files), the ribbon of anchors, and "Compile manuscript" (`readNote` in tree order, then `exportTextFile`;
only a new file is written).

Do not reintroduce a single entities database, type overlays, `.amby-creative/` metadata or renderer-side creation.
