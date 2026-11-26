# Tiptap and Markdown map

Owns rich editing and byte-preserving Markdown conversion.
Read [Markdown compatibility](../../../../docs/markdown-compatibility.md) and
[vault format](../../../../docs/vault-format.md) before serialization changes.

| Concern                                      | Owner                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React/ProseMirror lifecycle                  | [TiptapEditor.tsx](TiptapEditor.tsx), [editor-serialization-lifecycle.ts](editor-serialization-lifecycle.ts), [use-editor-serialization.ts](use-editor-serialization.ts) (the save gate and flushes)                                                                                                                    |
| Public conversion API and Live admission     | [markdown.ts](markdown.ts), [markdown-compatibility.ts](markdown-compatibility.ts), [markdown-meaning.ts](markdown-meaning.ts)                                                                                                                                                                                          |
| Source text kept per top-level block         | [markdown-block-source.ts](markdown-block-source.ts), [markdown-markup.ts](markdown-markup.ts)                                                                                                                                                                                                                          |
| Parse / serialize                            | [markdown-parser.ts](markdown-parser.ts), [markdown-serializer.ts](markdown-serializer.ts)                                                                                                                                                                                                                              |
| Inline, block, table and raw markup handling | [markdown-inline.ts](markdown-inline.ts), [markdown-block-plugins.ts](markdown-block-plugins.ts), [markdown-special-blocks.ts](markdown-special-blocks.ts), [markdown-table.ts](markdown-table.ts), [markdown-markup.ts](markdown-markup.ts)                                                                            |
| Schema / extension registration              | [schema.ts](schema.ts), [extensions.ts](extensions.ts), [marks/](marks/)                                                                                                                                                                                                                                                |
| Unknown source preservation                  | [opaque-markdown-node.ts](opaque-markdown-node.ts), [opaque-html-node.ts](opaque-html-node.ts)                                                                                                                                                                                                                          |
| Columns: structure, movement, width          | [columns-node.ts](columns-node.ts), [columns-transaction.ts](columns-transaction.ts), [column-resize.ts](column-resize.ts)                                                                                                                                                                                              |
| Block controls / conversions                 | [BlockHandles.tsx](BlockHandles.tsx) (hooks `use-block-*.ts`, geometry `block-handles-geometry.ts`), [BlockActionsPanel.tsx](BlockActionsPanel.tsx), [BlockInsertPanel.tsx](BlockInsertPanel.tsx), [block-conversion.ts](block-conversion.ts), [menu-keyboard.ts](menu-keyboard.ts)                                     |
| Typing and keyboard habits, Markdown paste   | [block-shortcuts.ts](block-shortcuts.ts) (`- [ ] `, `1) `, Backspace in a heading, Mod-D, Mod-Shift-arrows, Mod-K), [markdown-paste.ts](markdown-paste.ts), [indent-shortcut.ts](indent-shortcut.ts), [wrap-shortcuts.ts](wrap-shortcuts.ts)                                                                            |
| Inline toolbar / slash menu                  | [BubbleToolbar.tsx](BubbleToolbar.tsx), [slash-menu.ts](slash-menu.ts)                                                                                                                                                                                                                                                  |
| Suggestions while typing `[[` and `#`        | [inline-suggest.ts](inline-suggest.ts), [InlineSuggestPanel.tsx](InlineSuggestPanel.tsx), [link-suggestions.ts](link-suggestions.ts) (sources registered by [the workspace hook](../orchestration/use-link-suggestion-sources.ts))                                                                                      |
| Find in note (Live / Read)                   | [find-in-note.ts](find-in-note.ts), [FindBar.tsx](FindBar.tsx); Source uses CodeMirror search in [source-editor.tsx](../source-editor.tsx)                                                                                                                                                                              |
| Tables: rows, columns, alignment             | [table-commands.ts](table-commands.ts), [TableControls.tsx](TableControls.tsx), [markdown-table.ts](markdown-table.ts), [table-alignment.ts](table-alignment.ts)                                                                                                                                                        |
| Code block: colours, language, Copy          | [code-block.ts](code-block.ts)                                                                                                                                                                                                                                                                                          |
| Formulas and diagrams                        | [markdown-math.ts](markdown-math.ts) (what an inline formula is, for parser, serializer and drawing), [math-inline.ts](math-inline.ts), [rendered-source.ts](rendered-source.ts) (lazy KaTeX / Mermaid), display math in [opaque-markdown-node.ts](opaque-markdown-node.ts), diagrams in [code-block.ts](code-block.ts) |
| Footnotes                                    | [markdown-footnotes.ts](markdown-footnotes.ts) (reading), [footnote-nodes.ts](footnote-nodes.ts) (nodes, typing, insert), writing in [markdown-serializer.ts](markdown-serializer.ts)                                                                                                                                   |
| Tags / wiki links / transclusions            | [tags-wikilinks.ts](tags-wikilinks.ts), [WikiLinkContextMenu.tsx](WikiLinkContextMenu.tsx), [transclusion-node.ts](transclusion-node.ts), [transclusion-view.tsx](transclusion-view.tsx)                                                                                                                                |
| Images / attachments / bookmarks / drops     | [amby-image.ts](amby-image.ts), [image-line.ts](image-line.ts), [media-drop.ts](media-drop.ts), [asset-resolver.ts](asset-resolver.ts), [attachment-kind.ts](attachment-kind.ts), [attachment-view.tsx](attachment-view.tsx), [bookmark-card.ts](bookmark-card.ts)                                                      |
| Amby blocks and callouts                     | [amby-block-node.ts](amby-block-node.ts), [AmbyBlockView.tsx](AmbyBlockView.tsx), [callout-node.ts](callout-node.ts)                                                                                                                                                                                                    |
| Source ↔ rich selection                      | [markdown-selection.ts](markdown-selection.ts), pointer gaps: [use-gap-selection.ts](use-gap-selection.ts), [nearest-line.ts](nearest-line.ts)                                                                                                                                                                          |

[Note pages](note-pages.ts) decorate first-level heading ranges (dossiers: the top heading level)
without editing the document. The [tab controls](note-page-controls.tsx) remember the selected tab per vault
and note. Explicit page edits use plugin metadata, including reorder and extraction, which move complete blocks.
[Pointer reorder](use-note-page-drag.ts) previews changes in the tab row and compact list, then commits on drop.
Find searches the whole note and reveals the match's page. Heading links use [anchor navigation](../anchor-navigation.ts).

Block-link IDs: [block-anchors.ts](block-anchors.ts).

Drag: [placement](image-placement.ts), [feedback](image-drag-feedback.ts), [shared geometry](block-drop-geometry.ts). Selection: [selection-highlight.ts](selection-highlight.ts).

"Database view" opens the block picker. Insertion removes the slash text.

Top-level blocks and list items retain their source while unchanged. `docToMarkdown` checks
the result before reusing kept bytes, including after movement. Live admission also checks
an independent Markdown reading (`markdown-meaning.ts`). Unsafe blocks keep their original
source (`isolateUnsafeBlocks`). Preserve column comments, order, widths and empty blocks.
New serializer rules require a lossless fixture and an unsupported-input case.

Markdown paste uses the note parser and creates new blocks without kept source,
rebuilt for the editor's schema. Behaviour that depends on
real typing, focus or the clipboard also has a case in
[the browser suite](../../../../tests/e2e/).

Tag and wikilink decorations are kept between transactions: a cursor move reuses the
set, an edit maps it and looks again only at the text blocks it touched
(`changedTextRanges`). A decoration therefore outlives the position it was made at:
never write a position into its DOM or a closure, ask `inlineTokenRange` / `getPos`
when it is needed, and check the text before replacing it.

A GFM table has exactly one header row and keeps column alignment in its delimiter
row (`markdownSeparator`): change rows, columns and alignment through `table-commands.ts`,
which keeps both; cells are drawn aligned from that row only. Anything drawn inside a node view outside its content (the code block bar)
needs `ignoreMutation`, or a change to it makes the editor draw the node again.

A display formula is made and changed through [math-block.ts](math-block.ts), which
refuses TeX that would not read back as the same block. The TeX being written is in the
node view's text area, not in the document, until it is applied.

Tests: [markdown.test.ts](markdown.test.ts) and [fixtures/](fixtures/).
The no-edit and edit invariants live in
[markdown-block-source.test.ts](markdown-block-source.test.ts). Link titles ([markdown-link-title.test.ts](markdown-link-title.test.ts)), ordered-list
numbers ([markdown-ordered-list.test.ts](markdown-ordered-list.test.ts)), typed text,
columns and media have focused colocated tests. The shared indexing corpus is
[markdown-compatibility.json](../../../../tests/fixtures/markdown-compatibility.json).
For mode policy follow [the editor map](../editor/MAP.md); for saves follow
[the autosave map](../autosave/MAP.md).
