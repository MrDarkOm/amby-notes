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
| Project tab: header, sections, overview | [project-page.tsx](project-page.tsx)                                                                           |
| Create project / section                | [create-project-dialog.tsx](create-project-dialog.tsx), [create-section-dialog.tsx](create-section-dialog.tsx) |
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
`renderDatabase` as the ordinary `DatabaseWorkspace` (with `hideHeader`), so every layout,
filter and row action is the database's own. A project tab is `kind: "creative"` with
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
text, looking through every list; session state). A drop-down of the scope's stories (a collection
with its stories, or the stand-alone ones; the choice is `storyFilter`, per vault), and for the chosen
story four folding parts with icons: _books_ and _arcs_ list the pages of the first two text levels
(the story's own level names; the template's names read as plurals; arcs are absent for a one-level
schema), each with the pages below it and drag-and-drop (`move_text_page`: parent and order key in
one write, after `planMove` refused what the backend would refuse); _anchors_ lists the story's
`anchors` section, _notes_ its `notes` section. Under them the **world** (`world-section.tsx`): one
folding list per category, merged by role or, for a section the author made, by name, so a universe's
"Organizations" and a story's are one list. A switch beside it narrows every list to the chosen story
(its own pages and those its text relates to) or widens it to the whole universe, with story labels;
without a collection there is no switch. Lists read the databases through the ordinary database query;
nothing keeps a copy of a page. Which parts are unfolded and the switch are remembered per vault.
Every page row has its own context menu (`item-menu.tsx`: open, open in a new tab, rename, delete through
the workspace's file-tree delete; a page of the text with pages below it is deleted together with them,
the menu says how many and the one confirmation names them all) and the empty space has one that creates on the spot, with the same
options as the "Create" button (`useChooserOptions`). The world has no "+" of its own: pages are added
from their category, sections from "Create" or that menu.

**Names.** The folder of a base section is named once, at creation, so the dialog resolves
the names from the active language and sends them as `labels`; the backend only has Russian
fallbacks. Add a language by adding the `creative.*` keys, not by touching Rust.

**Operation IDs.** One per intent: a retry of the same request reuses it (Rust then returns
the recorded answer), a changed request gets a new one because Rust refuses to reuse an ID
for a different payload.

**Dossier.** `DossierFrame` is passed to the editor as `editorFrame` (see
[document-body.tsx](../editor/document-body.tsx)) and wraps it in a structure that is the same
for every note, so the editor is never remounted when the answer arrives. It asks the backend
only when projects exist, shows nothing for notes outside the world sections, and lays the side
blocks out by the width of its own pane.

[fractional-index.ts](../../../lib/storage/fractional-index.ts) orders the pages of the text;
[manuscript-compiler.ts](../../../lib/storage/manuscript-compiler.ts) is kept for the manuscript
export and is used only by its tests so far.

Do not reintroduce a single entities database, type overlays, `.amby-creative/` metadata or
project creation from the renderer; discovery and creation belong in Rust.
