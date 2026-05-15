import { getSchema, type Extensions } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table"
import { TaskList } from "@tiptap/extension-task-list"
import { TaskItem } from "@tiptap/extension-task-item"
import { Image } from "@tiptap/extension-image"

import { AmbyTextStyle } from "./marks/amby-text-style"
import { AmbyUnderline } from "./marks/amby-underline"
import { AmbyHtml } from "./marks/amby-html"
import { MarkdownMarkup } from "./markdown-markup"
import { CalloutNode } from "./callout-node"

// Schema-defining extensions — identical for Live and Read, and the source of
// truth for the standalone schema used by the markdown conversion layer.
// Kept in its own module so `markdown.ts` and `extensions.ts` can both depend
// on it without a circular import.
export const schemaExtensions: Extensions = [
  StarterKit.configure({
    // We ship a custom underline mark (custom on-disk serialization).
    underline: false,
    // Clicks must not navigate away inside the Tauri webview.
    link: { openOnClick: false, autolink: true },
    heading: { levels: [1, 2, 3, 4, 5] },
  }),
  Table.configure({ resizable: true }),
  TableRow,
  TableHeader,
  TableCell,
  TaskList,
  TaskItem.configure({ nested: true }),
  Image.configure({ inline: true }),
  MarkdownMarkup,
  AmbyTextStyle,
  AmbyUnderline,
  AmbyHtml,
  CalloutNode,
]

export const editorSchema = getSchema(schemaExtensions)
