# Excalidraw / sketch map

Owns the Excalidraw editor and its scene lifecycle. Public access goes through
[../sketch-editor.tsx](../sketch-editor.tsx) / [index.ts](index.ts).

| Concern                             | Owner                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Feature registration                | [sketch-module.tsx](sketch-module.tsx)                                                                             |
| Excalidraw surface and scene events | [sketch-editor.tsx](sketch-editor.tsx)                                                                             |
| Embedded notes / objects toolbar    | [sketch-note-embeddable.tsx](sketch-note-embeddable.tsx), [sketch-objects-toolbar.tsx](sketch-objects-toolbar.tsx) |
| Error boundary                      | [sketch-error-boundary.tsx](sketch-error-boundary.tsx)                                                             |
| Scene format                        | [sketch-format.ts](../../../lib/sketch-format.ts)                                                                  |
| Workspace load/save integration     | [use-sketch-workspace.ts](../orchestration/use-sketch-workspace.ts)                                                |

Preserve unknown scene data; consult [vault format](../../../../docs/vault-format.md)
before persistence changes. Use [storage](../../../lib/storage/MAP.md), shared
[common/](../common/) controls and the existing workspace document lifecycle.
Excalidraw scene history and filesystem save/recovery have different owners.

Tests: [sketch-editor.test.ts](sketch-editor.test.ts),
[sketch-editor-lifecycle.test.ts](sketch-editor-lifecycle.test.ts),
[use-sketch-workspace.test.ts](../orchestration/use-sketch-workspace.test.ts), and
[sketch-format.test.ts](../../../lib/sketch-format.test.ts).
Check scene switching, resize and embedded-note interactions in the native app.
