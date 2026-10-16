# Workspace map

Owns workspace UI and state. [workspace.tsx](workspace.tsx) is the public facade;
[workspace-orchestration.tsx](workspace-orchestration.tsx) composes the focused
hooks and surfaces. Extend the owner below instead of adding parallel state.

| Concern                                | Owners / next route                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Documents, buffers, dirty state        | [use-doc-store.ts](use-doc-store.ts), [document-buffer-lifecycle.ts](document-buffer-lifecycle.ts)                                                                                                     |
| Tabs and navigation targets            | [use-tabs-store.ts](use-tabs-store.ts), [use-tab-actions.ts](use-tab-actions.ts), [tab-target.ts](tab-target.ts), [header-tabs.tsx](header-tabs.tsx)                                                   |
| Vault and tree data                    | [use-vault-store.ts](use-vault-store.ts), [use-vault-data.ts](use-vault-data.ts), [vault/use-vault-session.ts](vault/use-vault-session.ts)                                                             |
| View preferences and settings          | [use-view-state-store.ts](use-view-state-store.ts), [use-settings-store.ts](use-settings-store.ts), [app-config.ts](app-config.ts)                                                                     |
| Layout and panels                      | [workspace-layout.tsx](workspace-layout.tsx), [workspace-shell.tsx](workspace-shell.tsx), [panel-host.tsx](panel-host.tsx), [panel-registry.tsx](panel-registry.tsx), [panels/](panels/)               |
| Tree rendering, keyboard, drag/drop    | [tree/sidebar-tree.tsx](tree/sidebar-tree.tsx), [tree/use-tree-keyboard.ts](tree/use-tree-keyboard.ts), [tree/use-tree-dnd.ts](tree/use-tree-dnd.ts)                                                   |
| Folder cards/counts/icons              | [folder-view.tsx](folder-view.tsx), [folder-view-utils.ts](folder-view-utils.ts), [icon-values.ts](icon-values.ts), [icon-value.tsx](icon-value.tsx)                                                   |
| Open/create/rename/move/delete         | [file-actions/](file-actions/), [workspace-mutations.ts](workspace-mutations.ts); [use-file-actions.ts](use-file-actions.ts) composes hooks                                                            |
| Save/conflict/recovery lifecycle       | [autosave map](autosave/MAP.md)                                                                                                                                                                        |
| Document editor and layers             | [editor map](editor/MAP.md), [use-layers.ts](use-layers.ts)                                                                                                                                            |
| Canvas / Excalidraw                    | [canvas map](canvas/MAP.md), [sketch map](sketch/MAP.md), [orchestration/](orchestration/)                                                                                                             |
| Databases                              | [database map](database/MAP.md)                                                                                                                                                                        |
| Creative workshop (amby.creative)      | [creative map](creative/MAP.md), [panel map](creative/workshop/MAP.md)                                                                                                                                 |
| Search, tags, wiki navigation, graph   | [search-modal.tsx](search-modal.tsx), [sidebar-search.tsx](sidebar-search.tsx), [quick-open-modal.tsx](quick-open-modal.tsx), [wiki-links.ts](wiki-links.ts), [graph-tab-view.tsx](graph-tab-view.tsx) |
| Settings UI                            | [settings-dialog.tsx](settings-dialog.tsx), [settings/](settings/), [settings-navigation.ts](settings-navigation.ts)                                                                                   |
| Separate note windows                  | [windows/use-note-windows.ts](windows/use-note-windows.ts), [windows/vault-window-lifecycle.ts](windows/vault-window-lifecycle.ts)                                                                     |
| Optional feature registration/profiles | [module host map](../../lib/modules/MAP.md), [modules/](modules/), feature `*-module.tsx` files                                                                                                        |

Folder selection opens a `folder` tab; derive content from the existing `TreeItem`
hierarchy. Icons share `EmojiPickerPanel`, `IconValue` and view-state overrides.
The root `sidebar-tree.tsx`, `document-editor.tsx`, `canvas-editor.tsx` and
`sketch-editor.tsx` are compatibility entry points; follow their re-exports.

Filesystem behavior crosses the [storage boundary](../../lib/storage/MAP.md).
Test changed pure logic beside its owner, and interactions using the scenarios in
[the tests map](../../../tests/MAP.md). Browser tests cannot certify native I/O.
