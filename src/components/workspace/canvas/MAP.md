# Canvas map

Owns the React Flow canvas. Excalidraw has [a separate owner](../sketch/MAP.md).

| Concern                                  | Owner                                                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature registration / surface           | [canvas-module.tsx](canvas-module.tsx), [canvas-editor.tsx](canvas-editor.tsx)                                                                                   |
| Document state / serialization lifecycle | [use-canvas-document.ts](use-canvas-document.ts), [canvas-context.ts](canvas-context.ts)                                                                         |
| Format preservation                      | [canvas-format.ts](../../../lib/canvas-format.ts)                                                                                                                |
| Nodes, edges, cards                      | [canvas-nodes.tsx](canvas-nodes.tsx), [canvas-edges.tsx](canvas-edges.tsx), [canvas-markdown.ts](canvas-markdown.ts)                                             |
| Interaction / layout / undo              | [use-canvas-dnd.ts](use-canvas-dnd.ts), [canvas-layout.ts](canvas-layout.ts), [canvas-alignment.ts](canvas-alignment.ts), [canvas-history.ts](canvas-history.ts) |
| Toolbar, templates, Mermaid              | [canvas-toolbar.tsx](canvas-toolbar.tsx), [canvas-templates.ts](canvas-templates.ts), [canvas-mermaid.ts](canvas-mermaid.ts)                                     |
| Workspace loading and save integration   | [use-canvas-workspace.ts](../orchestration/use-canvas-workspace.ts), [canvas-load-dedup.ts](../orchestration/canvas-load-dedup.ts)                               |

Read [vault format](../../../../docs/vault-format.md) before format/save changes.
Preserve unknown canvas content and use [storage](../../../lib/storage/MAP.md)
for I/O. Shared note-card UI belongs in [common/](../common/), so one optional
editor does not depend on another editor's toolbar or module lifecycle.

Tests: colocated format, layout, alignment, history, Markdown and document-hook
tests, plus orchestration dedup tests. Verify actual drag/drop and resize manually.
