# Creative map

Owns the official `amby.creative` module: the sidebar section, the project page and the
dialogs that create projects and sections. Everything durable is Rust: discovery, creation,
recovery and the index live in the [project backend](../../../../src-tauri/src/project/MAP.md)
and arrive through [project-port.ts](../../../lib/storage/project-port.ts). The contract is the
[format v3](../../../../docs/creative-format.md); the stages are in the [plan](../../../../docs/creative-workshop-plan.md).

| Concern                                 | Owner                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Module registration (panel `creative`)  | [creative-module.tsx](creative-module.tsx)                                                                     |
| Catalog state and lifecycle             | [project-store.ts](project-store.ts), [use-project-controller.ts](use-project-controller.ts)                   |
| Panel: header, search "+", body states  | [creative-panel.tsx](creative-panel.tsx)                                                                       |
| Which marker is the workshop (setting)  | [workshop-location.ts](workshop-location.ts) (pure), `project-store.ts` (`rawCatalog`, `setPlace`)             |
| No workshop: initialize                 | [workshop-init-screen.tsx](workshop-init-screen.tsx)                                                           |
| Missing parts: model, hook, notice      | `workshop-gaps.ts`, `use-complete-workshop.ts`, `complete-workshop-notice.tsx`                                 |
| "Create" chooser                        | [create-chooser-dialog.tsx](create-chooser-dialog.tsx)                                                         |
| Panel state (filter, parts), prefs      | [creative-nav-store.ts](creative-nav-store.ts), [creative-scope-storage.ts](creative-scope-storage.ts)         |
| Section groups, find a workshop (pure)  | [project-tree-model.ts](project-tree-model.ts)                                                                 |
| Workshop: tabs, lists, text tree, notes | [workshop/](workshop/MAP.md): `workshop-pane.tsx` composes; models: `workshop-model.ts`, `text-tree-model.ts`  |
| Belonging to stories and universes      | `workshop-model.ts` (`resolvePanelFilter`, `buildMembership`, `scopeEntities`); `world-cards.tsx`              |
| Universe / standalone page              | [scope-desk.tsx](scope-desk.tsx); `page-header.tsx`, `scoped-section.tsx`, `workshop/use-scope-data.ts`        |
| Project tab: header, sections, overview | [project-page.tsx](project-page.tsx); a story's desk: [project-desk.tsx](project-desk.tsx)                     |
| Workshop page, section gallery (pages/) | [pages/](pages/): `workshop-overview.tsx`, `story-list.tsx`, `section-gallery.tsx`, `*-model.ts`               |
| Project settings dialog                 | [project-settings-dialog.tsx](project-settings-dialog.tsx)                                                     |
| Words and last-change time of pages     | [use-text-stats.ts](use-text-stats.ts) (one read-only call)                                                    |
| Create story, universe / section        | [create-project-dialog.tsx](create-project-dialog.tsx), [create-section-dialog.tsx](create-section-dialog.tsx) |
| Text schema of a new story (levels)     | [text-schema-presets.ts](text-schema-presets.ts); chosen in `create-project-dialog.tsx`                        |
| Names in the active language            | [project-labels.ts](project-labels.ts); `creative.*` keys of `locales/resources.ts`                            |
| Errors, operation IDs                   | [project-error.ts](project-error.ts), [use-operation-id.ts](use-operation-id.ts)                               |
| Dossier of a world page                 | [dossier/](dossier/)                                                                                           |
| File tree: icons, hiding                | [creative-tree-model.ts](creative-tree-model.ts), [use-creative-tree-items.ts](use-creative-tree-items.ts)     |
| The workshop folder opens its page      | [use-collection-folder-select.ts](use-collection-folder-select.ts)                                             |
| Settings (`showInTree`, `workshopPath`) | [creative-settings-store.ts](creative-settings-store.ts), [creative-settings.tsx](creative-settings.tsx)       |
| Section icons                           | [section-icons.ts](section-icons.ts)                                                                           |

**One workshop** ([format §2.1](../../../../docs/creative-format.md)). The folder `moduleSettings.creative.workshopPath` names
(default: the localized "Workshop") is the workshop. `useProjectStore` keeps every marker (`rawCatalog`) and, as `catalog`,
only the active one plus an `otherWorkshop` diagnostic per marker left out; the rest of the module reads `catalog`. With
none active the panel is `WorkshopInitScreen` ("Initialize"; Rust refuses a folder with other content before writing). A
workshop of an earlier stage that lacks bases or links gets the notice "Create the missing sections" (`workshopGaps`,
`completeWorkshop`); opening writes nothing. No workshop switch, no "New workshop", no per-part "Create the section".
Folders of the former format: one folded line at the foot (`LegacyFoldersRow`).

**Data flow.** `useProjectController` (mounted in `workspace-orchestration.tsx`) reads the
catalog once the database catalog is ready, re-reads it when the databases change, and calls
`refreshProjects` after the debounced `project:changed` event. After a write the dialogs
call `onCreativeChanged` (tree and database catalog) and then the store's `refresh`, and only
then open the page; the page never opens on an unknown project.

**Sections are galleries.** A section tab shows a `SectionGallery` (the whole base on the workshop's page, the pages of the
scope elsewhere); "Open as base" asks the shell (`onOpenDatabase`) for the ordinary database tab. Body of the workshop's page
and the gallery: [pages/](pages/MAP.md). A project tab is `kind: "creative"` (`fileId`: its page; [history, header](pages/MAP.md)).

**File tree.** Creative folders are ordinary folders on disk, so the module marks them in a view-only pass
(`applyCreativeTree`): workshop and story folders by vault-relative path, section databases by `databaseId`; an icon the
author chose is kept. The orchestration hands the result to the file panel as `fileTreeItems`; while the module is off the
vault's own tree passes through. With `showInTree` off the folders are left out of that tree only; nothing is written. The
workshop's folder carries `statusIcon`; selecting it opens that workshop's page.

**Workshop panel.** One column under the one search (`search-results.tsx` replaces it while it has
text; session state). Top: one card, universe over story (`story-header.tsx`, `workshop/scope-bar.tsx`; the story is "All stories" or one, ending with "New story";
`storyFilter`). Then "Story" with three folding
parts: _text_ is the whole text as one tree from `buildTextTree`, every page once (a page without a
parent or a level is a root), with the level icon and word count (`use-text-stats.ts`) on each row, the
open page marked, its parents unfolded and the row scrolled into view once per change, and drag-and-drop
(`move_text_page`, after `planMove` refused what the backend would). Its "+" makes a top-level page
(`defaultLevelId`), a row's "+" one inside; a last-level page has none (`canHaveChildPage`). _anchors_
stand where the text puts them, with the rest "Ahead" in the author's order (`manualOrder`); _notes_ show
notebooks. Anchors, arcs and their marks in the tree: [workshop map](workshop/MAP.md). An empty list offers "Add the first …" (`empty-action.tsx`). Under them the **world**
(`world-section.tsx`): one folding list per category (by role, or by name for an author's section). Two axes
filter it: the universe in the bar (`UniverseSwitch`; `universeFilter`) sets the scope, a
universe or "Standalone stories" (the default; no "whole workshop"), and the story in the bar narrows to one story
(`resolvePanelFilter`: story > universe > standalone; [workshop map](workshop/MAP.md)).
Belonging (a page is in a story by its "Stories" relation or a relation of that story's text; in a universe through its
stories) is `buildMembership` / `scopeEntities` on rows already held ([format §6](../../../../docs/creative-format.md),
[workshop map](workshop/MAP.md)); "No story" and story names with "+N" mark rows outside one story. A page made under a
shown story goes through `createWorkshopEntity` with its `storyId`. A section of an older workshop offers "Link to
stories" (`addStoryLinks`). A category where some page has a picture shows a 20 px round face on every row
(`portrait-dot.tsx`). Unfolded parts, the story and the universe are remembered per vault. Every page row has a context menu
(`item-menu.tsx`: open, open in a new tab, rename, delete, status of a text page; a page with pages below it is deleted with
them after one confirmation); the empty space has a menu with the "Create" options (`useChooserOptions`: a page or a world
page first, then story, universe and section).

**Creating where it will stand.** A page, note, anchor or world page is named on a row of its own
(`inline-create-row.tsx`, one `WorkshopDraft` in `workshop-pane.tsx`): Enter creates, Escape cancels, a failure stays on
the row. A page starts one level below its parent (`startLevelId`).

**Names.** A base's folder is named once, at creation: the interface sends the names of the active language as `labels`
(the backend only has Russian fallbacks). Add a language with `creative.*` keys, not in Rust.

**Levels of a new story.** The dialog asks for the text schema: Novel (Book → Chapter → Scene, the default), Short story
(Page), Comic (Book → Volume → Chapter → Page; "Arc" belongs to story arcs) or Custom (1 to 6 names). The names go as `textLevels` in the active
language; `levelsProblem` mirrors what the backend refuses; the list is part of the operation-ID payload.

**Project settings.** `project-settings-dialog.tsx` (the "Settings" row of the page's "⋯" menu in `project-page.tsx`, off on
read-only projects): basics (`updateProject`), sections (reorder, remove without deleting the folder) and,
on a story, text levels (`updateTextLevels`) and the `status` property (`addTextStatus`).

**Operation IDs.** One per intent: a retry reuses it, a changed request gets a new one.

**Dossier.** `DossierFrame` is the editor's `editorFrame` (see [document-body.tsx](../editor/document-body.tsx)):
one structure for every note, so the editor is never remounted when the answer arrives. It asks the
backend only when projects exist (`useNotePlace`) and shows nothing outside the world sections, except the plot
aside of a page of a story's text (`text-page-aside.tsx`; only where anchors or arcs exist). An arc's page also shows
its anchors and chapters and a character's its arcs (`plot-blocks.tsx`); [format §11](../../../../docs/creative-format.md).

[fractional-index.ts](../../../lib/storage/fractional-index.ts) orders the pages of the text;
[manuscript-compiler.ts](../../../lib/storage/manuscript-compiler.ts) turns the tree into one Markdown
document by tree depth (it reads, it never writes; a page it cannot read stops it, naming the page).

**Story desk.** `ProjectDesk`: a grid of widgets (Continue, Progress with "Compile manuscript", Chapters with the anchors
"Ahead", Notes, the world), one layout for every story, arranged from the page ("Customize desk"): [desk/](desk/MAP.md).

Do not reintroduce a single entities database, type overlays, `.amby-creative/` metadata or renderer-side creation.
