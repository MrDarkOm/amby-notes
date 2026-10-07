# Tiptap and Markdown map

This folder owns rich editing and byte-preserving Markdown conversion.
Read [Markdown compatibility](../../../../docs/markdown-compatibility.md) and
[vault format](../../../../docs/vault-format.md) before serialization changes.

| Concern                                      | Owner                                                                                                                                                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React/ProseMirror lifecycle                  | [TiptapEditor.tsx](TiptapEditor.tsx), [editor-serialization-lifecycle.ts](editor-serialization-lifecycle.ts)                                                                                                                                 |
| Public conversion API and lossless gate      | [markdown.ts](markdown.ts), [markdown-compatibility.ts](markdown-compatibility.ts)                                                                                                                                                           |
| Parse / serialize                            | [markdown-parser.ts](markdown-parser.ts), [markdown-serializer.ts](markdown-serializer.ts)                                                                                                                                                   |
| Inline, block, table and raw markup handling | [markdown-inline.ts](markdown-inline.ts), [markdown-block-plugins.ts](markdown-block-plugins.ts), [markdown-special-blocks.ts](markdown-special-blocks.ts), [markdown-table.ts](markdown-table.ts), [markdown-markup.ts](markdown-markup.ts) |
| Schema / extension registration              | [schema.ts](schema.ts), [extensions.ts](extensions.ts), [marks/](marks/)                                                                                                                                                                     |
| Unknown source preservation                  | [opaque-markdown-node.ts](opaque-markdown-node.ts), [opaque-html-node.ts](opaque-html-node.ts)                                                                                                                                               |
| Columns: structure, movement, width          | [columns-node.ts](columns-node.ts), [columns-transaction.ts](columns-transaction.ts), [column-resize.ts](column-resize.ts)                                                                                                                   |
| Block controls / conversions                 | [BlockHandles.tsx](BlockHandles.tsx), [BlockActionsPanel.tsx](BlockActionsPanel.tsx), [BlockInsertPanel.tsx](BlockInsertPanel.tsx), [block-conversion.ts](block-conversion.ts)                                                               |
| Inline toolbar / slash menu                  | [BubbleToolbar.tsx](BubbleToolbar.tsx), [slash-menu.ts](slash-menu.ts)                                                                                                                                                                       |
| Tags / wiki links / transclusions            | [tags-wikilinks.ts](tags-wikilinks.ts), [WikiLinkContextMenu.tsx](WikiLinkContextMenu.tsx), [transclusion-node.ts](transclusion-node.ts), [transclusion-view.tsx](transclusion-view.tsx)                                                     |
| Images / drops / asset URLs                  | [amby-image.ts](amby-image.ts), [media-drop.ts](media-drop.ts), [asset-resolver.ts](asset-resolver.ts)                                                                                                                                       |
| Amby blocks and callouts                     | [amby-block-node.ts](amby-block-node.ts), [AmbyBlockView.tsx](AmbyBlockView.tsx), [callout-node.ts](callout-node.ts)                                                                                                                         |
| Source ↔ rich selection                      | [markdown-selection.ts](markdown-selection.ts)                                                                                                                                                                                               |

The insert menu's "Database view" item opens the database picker inside
`BlockInsertPanel`; the slash text is removed only together with the insertion.

Keep unsupported/lossy syntax Source-only. Preserve `amby:columns` comments,
column order, explicit widths and empty blocks. Editor-only unlink controls must
leave the visible label as ordinary text, never appear in Markdown, and preserve
normal navigation outside the control. Do not add feature rules to the serializer
without a lossless fixture and a rejection case for unsupported input.

Tests start with [markdown.test.ts](markdown.test.ts) and [fixtures/](fixtures/).
Columns and media have focused colocated tests. The shared indexing corpus is
[markdown-compatibility.json](../../../../tests/fixtures/markdown-compatibility.json).
For mode policy follow [the editor map](../editor/MAP.md); for saves follow
[the autosave map](../autosave/MAP.md).
