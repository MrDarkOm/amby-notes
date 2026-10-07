# Tiptap and Markdown map

This folder owns rich editing and byte-preserving Markdown conversion.
Read [Markdown compatibility](../../../../docs/markdown-compatibility.md) and
[vault format](../../../../docs/vault-format.md) before serialization changes.

| Concern                                      | Owner                                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React/ProseMirror lifecycle                  | [TiptapEditor.tsx](TiptapEditor.tsx), [editor-serialization-lifecycle.ts](editor-serialization-lifecycle.ts)                                                                                                                                                                                   |
| Public conversion API and Live admission     | [markdown.ts](markdown.ts), [markdown-compatibility.ts](markdown-compatibility.ts), [markdown-meaning.ts](markdown-meaning.ts)                                                                                                                                                                 |
| Source text kept per top-level block         | [markdown-block-source.ts](markdown-block-source.ts), [markdown-markup.ts](markdown-markup.ts)                                                                                                                                                                                                 |
| Parse / serialize                            | [markdown-parser.ts](markdown-parser.ts), [markdown-serializer.ts](markdown-serializer.ts)                                                                                                                                                                                                     |
| Inline, block, table and raw markup handling | [markdown-inline.ts](markdown-inline.ts), [markdown-it-rules.d.ts](markdown-it-rules.d.ts), [markdown-block-plugins.ts](markdown-block-plugins.ts), [markdown-special-blocks.ts](markdown-special-blocks.ts), [markdown-table.ts](markdown-table.ts), [markdown-markup.ts](markdown-markup.ts) |
| Schema / extension registration              | [schema.ts](schema.ts), [extensions.ts](extensions.ts), [marks/](marks/)                                                                                                                                                                                                                       |
| Unknown source preservation                  | [opaque-markdown-node.ts](opaque-markdown-node.ts), [opaque-html-node.ts](opaque-html-node.ts)                                                                                                                                                                                                 |
| Columns: structure, movement, width          | [columns-node.ts](columns-node.ts), [columns-transaction.ts](columns-transaction.ts), [column-resize.ts](column-resize.ts)                                                                                                                                                                     |
| Block controls / conversions                 | [BlockHandles.tsx](BlockHandles.tsx), [BlockActionsPanel.tsx](BlockActionsPanel.tsx), [BlockInsertPanel.tsx](BlockInsertPanel.tsx), [block-conversion.ts](block-conversion.ts)                                                                                                                 |
| Typing and keyboard habits, Markdown paste   | [block-shortcuts.ts](block-shortcuts.ts) (`- [ ] `, `1) `, Backspace in a heading, Mod-D, Mod-Shift-arrows, Mod-K), [markdown-paste.ts](markdown-paste.ts), [indent-shortcut.ts](indent-shortcut.ts), [wrap-shortcuts.ts](wrap-shortcuts.ts)                                                   |
| Inline toolbar / slash menu                  | [BubbleToolbar.tsx](BubbleToolbar.tsx), [slash-menu.ts](slash-menu.ts)                                                                                                                                                                                                                         |
| Tags / wiki links / transclusions            | [tags-wikilinks.ts](tags-wikilinks.ts), [WikiLinkContextMenu.tsx](WikiLinkContextMenu.tsx), [transclusion-node.ts](transclusion-node.ts), [transclusion-view.tsx](transclusion-view.tsx)                                                                                                       |
| Images / drops / asset URLs                  | [amby-image.ts](amby-image.ts), [media-drop.ts](media-drop.ts), [asset-resolver.ts](asset-resolver.ts)                                                                                                                                                                                         |
| Amby blocks and callouts                     | [amby-block-node.ts](amby-block-node.ts), [AmbyBlockView.tsx](AmbyBlockView.tsx), [callout-node.ts](callout-node.ts)                                                                                                                                                                           |
| Source ↔ rich selection                      | [markdown-selection.ts](markdown-selection.ts)                                                                                                                                                                                                                                                 |

The insert menu's "Database view" item opens the database picker inside
`BlockInsertPanel`; the slash text is removed only together with the insertion.

A top-level block keeps the text it was read from and is written as that text
until it is edited; `docToMarkdown` reads its result back before trusting kept
text in a new place. `docToNormalizedMarkdown` is the editor's own form of every
block. A note is admitted to Live only when that form reads back as the same
document, also for the independent reading in `markdown-meaning.ts`; teach that
reading a new equivalence only when two spellings are the same to every reader.
A block whose rewriting would lose anything is kept as its source text (`isolateUnsafeBlocks`), never rebuilt. Preserve `amby:columns` comments,
column order, explicit widths and empty blocks. Editor-only unlink controls must
leave the visible label as ordinary text, never appear in Markdown, and preserve
normal navigation outside the control. Do not add feature rules to the serializer
without a lossless fixture and a rejection case for unsupported input.

Pasted plain text that is Markdown is read by the note parser and inserted as new
blocks without kept source; nodes from the parser belong to its own schema and are
rebuilt for the editor's schema before they are inserted. Behaviour that depends on
real typing, focus or the clipboard also has a case in
[the browser suite](../../../../tests/e2e/).

Tests start with [markdown.test.ts](markdown.test.ts) and [fixtures/](fixtures/).
The no-edit and edit invariants live in
[markdown-block-source.test.ts](markdown-block-source.test.ts). Link titles ([markdown-link-title.test.ts](markdown-link-title.test.ts)), ordered-list
numbers ([markdown-ordered-list.test.ts](markdown-ordered-list.test.ts)), typed text,
columns and media have focused colocated tests. The shared indexing corpus is
[markdown-compatibility.json](../../../../tests/fixtures/markdown-compatibility.json).
For mode policy follow [the editor map](../editor/MAP.md); for saves follow
[the autosave map](../autosave/MAP.md).
