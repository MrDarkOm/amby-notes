# Creative map

Owns the official `amby.creative` module: the sidebar section, the project page and the
dialogs that create projects and sections. Everything durable is Rust: discovery, creation,
recovery and the index live in the [project backend](../../../../src-tauri/src/project/MAP.md)
and arrive through [project-port.ts](../../../lib/storage/project-port.ts). The contract is the
[format v2 draft](../../../../docs/creative-format.md); the stages are in the
[redesign plan](../../../../docs/creative-module-claude-plan.md).

| Concern                                        | Owner                                                                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module registration (sidebar panel `creative`) | [creative-module.tsx](creative-module.tsx)                                                                                                                             |
| Catalog state and its lifecycle                | [project-store.ts](project-store.ts), [use-project-controller.ts](use-project-controller.ts)                                                                           |
| Sidebar tree, folding, diagnostics             | [creative-panel.tsx](creative-panel.tsx), [creative-nav-store.ts](creative-nav-store.ts)                                                                               |
| Tree shape (collections, stories, groups)      | [project-tree-model.ts](project-tree-model.ts); pure, tested                                                                                                           |
| Project tab: header, section tabs, overview    | [project-page.tsx](project-page.tsx)                                                                                                                                   |
| Create project / section                       | [create-project-dialog.tsx](create-project-dialog.tsx), [create-section-dialog.tsx](create-section-dialog.tsx)                                                         |
| Names in the active language                   | [project-labels.ts](project-labels.ts); keys in `creative.sections.*` / `creative.groups.*` of `locales/resources.ts`                                                  |
| Errors and operation IDs                       | [project-error.ts](project-error.ts), [use-operation-id.ts](use-operation-id.ts)                                                                                       |
| Dossier of a world page                        | [dossier/](dossier/): [dossier-frame.tsx](dossier/dossier-frame.tsx), [use-note-dossier.ts](dossier/use-note-dossier.ts), [dossier-model.ts](dossier/dossier-model.ts) |
| Section icons                                  | [section-icons.ts](section-icons.ts)                                                                                                                                   |

**Data flow.** `useProjectController` (mounted in `workspace-orchestration.tsx`) reads the
catalog once the database catalog is ready, re-reads it when the databases change, and calls
`refreshProjects` after the debounced `project:changed` event. After a write the dialogs
call `onCreativeChanged` (tree and database catalog) and then the store's `refresh`, and only
then open the page, so it never opens on a project the catalog does not know yet.

**The page does not own a database view.** A section is rendered by the shell's
`renderDatabase` as the ordinary `DatabaseWorkspace` (with `hideHeader`), so every layout,
filter and row action is the database's own. A project tab is `kind: "creative"` with
`fileId` `creative:<projectId>`; the section shown is `creative-nav-store`.

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

Kept for stage 2 (text ordering and compilation), currently used only by their tests:
[fractional-index.ts](../../../lib/storage/fractional-index.ts) and
[manuscript-compiler.ts](../../../lib/storage/manuscript-compiler.ts).

Do not reintroduce a single entities database, type overlays, `.amby-creative/` metadata or
project creation from the renderer; discovery and creation belong in Rust.
