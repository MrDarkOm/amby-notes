import type { Extensions } from "@tiptap/core"
import { Placeholder } from "@tiptap/extension-placeholder"

import i18n from "@/lib/i18n"
import { schemaExtensions } from "./schema"
import { TagsWikilinks, type TagsWikilinksCallbacks } from "./tags-wikilinks"
import { SlashMenu } from "./slash-menu"
import { InlineSuggest } from "./inline-suggest"
import { FindInNote } from "./find-in-note"
import { InlineMathView } from "./math-inline"
import { FootnoteTyping } from "./footnote-nodes"
import { IndentShortcut } from "./indent-shortcut"
import { LineAfterBlock } from "./line-after-block"
import { EmptyLineHint } from "./empty-line-hint"
import { WrapShortcuts } from "./wrap-shortcuts"
import { MediaDrop } from "./media-drop"
import { ColumnResize } from "./column-resize"
import { MarkdownPaste } from "./markdown-paste"
import { BlockShortcuts } from "./block-shortcuts"
import { TableAlignment } from "./table-alignment"
import { BookmarkCards } from "./bookmark-card"
import { LinkOpen } from "./link-open"
import { ImageLine } from "./image-line"
import { SelectionHighlight } from "./selection-highlight"

export interface BuildExtensionsOptions {
  placeholder: string
  callbacks: { current: TagsWikilinksCallbacks }
}

// Full extension list for an editor instance (Live or Read).
// CalloutNode is already part of schemaExtensions (see schema.ts) so it does
// not need to be listed separately here.
export function buildExtensions({ placeholder, callbacks }: BuildExtensionsOptions): Extensions {
  return [
    ...schemaExtensions,
    Placeholder.configure({
      // The empty note asks to start writing; any other empty top-level line the cursor
      // is on hints at the slash menu (`EmptyLineHint` does the same for nested lines).
      placeholder: ({ editor }) => (editor.isEmpty ? placeholder : i18n.t("editor.slashHint")),
      showOnlyWhenEditable: true,
    }),
    TagsWikilinks.configure({ callbacks }),
    InlineMathView,
    FootnoteTyping,
    SlashMenu,
    InlineSuggest,
    FindInNote,
    IndentShortcut,
    LineAfterBlock,
    EmptyLineHint,
    WrapShortcuts,
    ColumnResize,
    TableAlignment,
    BookmarkCards,
    LinkOpen,
    BlockShortcuts,
    ImageLine,
    SelectionHighlight,
    // Files and image addresses first; plain text written as Markdown after them.
    MediaDrop,
    MarkdownPaste,
  ]
}
