# Document editor map

Owns the document surface, editing policy and controls. Public imports come through
[../document-editor.tsx](../document-editor.tsx) and [index.ts](index.ts).

| Concern                             | Owner                                                                                                                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor composition / mode admission | [document-editor.tsx](document-editor.tsx), [note-editing-policy.ts](note-editing-policy.ts)                                                                                                         |
| Body and active layer surface       | [document-body.tsx](document-body.tsx), [module-required-fallback.tsx](module-required-fallback.tsx)                                                                                                 |
| Mode preference                     | [use-document-view-mode.ts](use-document-view-mode.ts)                                                                                                                                               |
| Title, header, breadcrumb, controls | [document-title.tsx](document-title.tsx), [document-header.tsx](document-header.tsx), [document-breadcrumbs.tsx](document-breadcrumbs.tsx), [document-area-controls.tsx](document-area-controls.tsx) |
| Export                              | [layer-export.ts](layer-export.ts), [note-pdf-export.tsx](note-pdf-export.tsx)                                                                                                                       |
| Rich Markdown internals             | [Tiptap map](../tiptap/MAP.md)                                                                                                                                                                       |
| CodeMirror source surface           | [../source-editor.tsx](../source-editor.tsx)                                                                                                                                                         |

Before changing mode admission, read
[Markdown compatibility](../../../../docs/markdown-compatibility.md) and
[vault format](../../../../docs/vault-format.md). An existing mode preference
does not override the current document's lossless-editing policy. Malformed YAML
and identity conflicts have separate policies; preserve their source bytes.

Content changes flow into the [save lifecycle](../autosave/MAP.md), not direct I/O.
Use the existing document buffer for views of the same note. See database
[editor-surface-lease.ts](../database/peek/editor-surface-lease.ts) for peek ownership.

Tests: [note-editing-policy.test.ts](note-editing-policy.test.ts),
[document-title.test.tsx](document-title.test.tsx),
[source-editor.test.tsx](../source-editor.test.tsx), plus current colocated editor tests.
