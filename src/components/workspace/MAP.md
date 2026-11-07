# Workspace map

Owns workspace UI and state. [workspace.tsx](workspace.tsx) is the public facade;
[workspace-orchestration.tsx](workspace-orchestration.tsx) composes the focused
hooks and surfaces (pane renderers, layouts, dock, splits: [orchestration/](orchestration/)). Extend the owner below instead of adding parallel state.

| Concern                                | Owners / next route                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documents, buffers, dirty state        | [use-doc-store.ts](use-doc-store.ts), [document-buffer-lifecycle.ts](document-buffer-lifecycle.ts)                                                                                                                                                                                                                                      |
| Tabs, split panes and navigation       | [use-tabs-store.ts](use-tabs-store.ts), [use-tab-actions.ts](use-tab-actions.ts), [tab-target.ts](tab-target.ts), [header-tabs.tsx](header-tabs.tsx), [split-tree.ts](split-tree.ts), [pane-tab-bar.tsx](pane-tab-bar.tsx), [pane-dnd.ts](pane-dnd.ts)                                                                                  |
| Vault and tree data                    | [use-vault-store.ts](use-vault-store.ts), [use-vault-data.ts](use-vault-data.ts), [vault/use-vault-session.ts](vault/use-vault-session.ts), [vault/start-screen.tsx](vault/start-screen.tsx), [vault/vault-manager.tsx](vault/vault-manager.tsx), [workspace-picker.tsx](workspace-picker.tsx)                                          |
| View preferences and settings          | [use-view-state-store.ts](use-view-state-store.ts), [use-settings-store.ts](use-settings-store.ts), [app-config.ts](app-config.ts)                                                                                                                                                                                                      |
| Layout and panels                      | [workspace-layout.tsx](workspace-layout.tsx), [workspace-shell.tsx](workspace-shell.tsx), [panel-host.tsx](panel-host.tsx), [panel-registry.tsx](panel-registry.tsx), [panels/](panels/), [history](history/history-preview.tsx)                                                                                                        |
| Tree rendering, keyboard, drag/drop    | [tree/sidebar-tree.tsx](tree/sidebar-tree.tsx), [tree/use-tree-keyboard.ts](tree/use-tree-keyboard.ts), [tree/use-tree-dnd.ts](tree/use-tree-dnd.ts), [tree/use-tree-file-drop.ts](tree/use-tree-file-drop.ts) (files dropped from the system; Rust `commands/import_files.rs`)                                                         |
| Tree patches, refresh by path, archive | [tree-patch.ts](tree-patch.ts), `patchTree`/`refreshTreePaths` in [use-vault-data.ts](use-vault-data.ts), [use-archive-tree-refresh.ts](use-archive-tree-refresh.ts) (`refreshTree` is the full reload)                                                                                                                                 |
| Folder cards/counts/icons              | [folder-view.tsx](folder-view.tsx), [folder-view-utils.ts](folder-view-utils.ts), [icon-values.ts](icon-values.ts), [icon-value.tsx](icon-value.tsx)                                                                                                                                                                                    |
| Open/create/rename/move/delete         | [file-actions/](file-actions/), [workspace-mutations.ts](workspace-mutations.ts); [use-file-actions.ts](use-file-actions.ts) composes hooks                                                                                                                                                                                             |
| Save/conflict/recovery lifecycle       | [autosave map](autosave/MAP.md)                                                                                                                                                                                                                                                                                                         |
| Page header and floating bar           | [page-chrome/](page-chrome/): `page-header-bar.tsx` (back/forward, breadcrumb, focus, "⋯"), `page-floating-bar.tsx` (change, words, undo/redo, lock, settings), `page-menu.tsx`, `page-chrome-types.ts`; worn by the note ([editor map](editor/MAP.md)), the graph and the [workshop pages](creative/MAP.md)                            |
| Notices of a note (strip and cards)    | [note-notices/](note-notices/MAP.md): `note-notices.tsx` (strip behind the bottom bar), `use-note-notices-store.ts`; worn by [document-editor.tsx](editor/document-editor.tsx); level look: [notices/](notices/notice-level.tsx)                                                                                                        |
| Document editor and layers             | [editor map](editor/MAP.md), [use-layers.ts](use-layers.ts)                                                                                                                                                                                                                                                                             |
| Canvas / Excalidraw                    | [canvas map](canvas/MAP.md), [sketch map](sketch/MAP.md), [orchestration/](orchestration/)                                                                                                                                                                                                                                              |
| Databases                              | [database map](database/MAP.md)                                                                                                                                                                                                                                                                                                         |
| Creative workshop (amby.creative)      | [creative map](creative/MAP.md), [panel map](creative/workshop/MAP.md)                                                                                                                                                                                                                                                                  |
| Search, tags, wiki navigation, graph   | [search](search-modal.tsx), [sidebar search](sidebar-search.tsx), [quick open](quick-open-modal.tsx), [scope](search-scope.ts), [motion](spotlight-motion.ts), [create](spotlight-create-actions.ts), [wiki links](wiki-links.ts), [tags](tags/tag-focus-store.ts), [graph view](graph-tab-view.tsx), [graph/](graph/graph-settings.ts) |
| Settings UI                            | [settings-dialog.tsx](settings-dialog.tsx), [settings/](settings/), [settings-navigation.ts](settings-navigation.ts)                                                                                                                                                                                                                    |
| Separate note windows                  | [windows/use-note-windows.ts](windows/use-note-windows.ts), [windows/vault-window-lifecycle.ts](windows/vault-window-lifecycle.ts)                                                                                                                                                                                                      |
| Sync settings and connect screen       | [sync map](sync/MAP.md)                                                                                                                                                                                                                                                                                                                 |
| Optional feature registration/profiles | [module host map](../../lib/modules/MAP.md), [modules/](modules/), feature `*-module.tsx` files                                                                                                                                                                                                                                         |

A crashed tab or panel is isolated by [surface-error-boundary.tsx](surface-error-boundary.tsx) (used in [panel-host.tsx](panel-host.tsx) and `SurfaceSuspense` in the orchestration).

AI provider definitions and versioned connection domain: [providers.ts](ai/providers.ts), [connections.ts](ai/connections.ts); [connections-manager.tsx](ai/connections-manager.tsx) owns connection editing, catalog choices and the shared card for the Codex and Claude Code CLI methods (status, install guidance, sign-in/out; `cliProviderId` maps a method to its wire provider).

AI conversations: [ai-panel.tsx](ai-panel.tsx) composes the panel;
[ai/](ai/) owns the conversation store, context budget, history list, safe
Markdown and the calm-document views ([message-view.tsx](ai/message-view.tsx),
[composer.tsx](ai/composer.tsx), [model-picker.tsx](ai/model-picker.tsx),
[provider-icon.tsx](ai/provider-icon.tsx), [empty-chat.tsx](ai/empty-chat.tsx)). The [storage boundary](../../lib/storage/MAP.md) persists chats and
consent; Rust owns the read-only tool loop and vault authorization.

Archive: [archive-panel.tsx](panels/archive-panel.tsx) owns actions and errors;
[archive-model.ts](panels/archive-model.ts) owns display labels and local-calendar grouping.
[archive-preview.tsx](panels/archive-preview.tsx) reads archived text and browses directories in a read-only dialog through storage, with stale-result cancellation.
It keeps original storage names/paths and the existing restore/purge commands unchanged.

Interface help: [help-modal.tsx](help-modal.tsx) composes the modal map;
[help-targets.ts](help-targets.ts) registers action anchors,
[use-help-targets.ts](use-help-targets.ts) measures only visible controls in the active pane,
[help-overlay-layout.ts](help-overlay-layout.ts) owns clipping and leaders, and
[help-shortcuts.tsx](help-shortcuts.tsx) reads configured bindings. Anchors are `data-help-target`;
visuals live in [app.css](../../themes/app.css).

A tab's history is a list of ids: notes, `__graph__` (`GRAPH_TAB_FILE_ID`) and workshop pages, `creative:<projectId>` or
`creative:<projectId>#<sectionId>` ([creative-history.ts](creative/creative-history.ts), which also reads the older
`creative:<projectId>`). A step within a page, such as a workshop section, goes through `openItem(target, false, { inPlace: true })`
so it never jumps to another tab; Back and Forward need no file for the graph or a workshop page.

Folder selection opens a `folder` tab; derive content from the existing `TreeItem`
hierarchy. Icons share `EmojiPickerPanel`, `IconValue` and view-state overrides.
The root `sidebar-tree.tsx`, `document-editor.tsx`, `canvas-editor.tsx` and
`sketch-editor.tsx` are compatibility entry points; follow their re-exports.

Filesystem behavior crosses the [storage boundary](../../lib/storage/MAP.md).
Test changed pure logic beside its owner, and interactions using the scenarios in
[the tests map](../../../tests/MAP.md). Browser tests cannot certify native I/O.

Backup recovery: [map](backup/MAP.md).
