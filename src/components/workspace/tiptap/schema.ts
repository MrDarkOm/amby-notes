import { getSchema, type Extensions } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TableCell, TableHeader, TableRow } from "@tiptap/extension-table"
import { TaskList } from "@tiptap/extension-task-list"
import { TaskItem } from "@tiptap/extension-task-item"
import { AmbyTextStyle } from "./marks/amby-text-style"
import { AmbyUnderline } from "./marks/amby-underline"
import { AmbyHtml } from "./marks/amby-html"
import { MarkdownMarkup } from "./markdown-markup"
import { CalloutNode } from "./callout-node"
import { AmbyBlockNode } from "./amby-block-node"
import { AmbyImage } from "./amby-image"
import { TransclusionNode } from "./transclusion-node"
import { OpaqueHtmlBlock } from "./opaque-html-node"
import { MarkdownTable } from "./markdown-table"
import { OpaqueMarkdownBlock } from "./opaque-markdown-node"
import { Column, ColumnSet } from "./columns-node"

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
  MarkdownTable.configure({ resizable: true }),
  TableRow,
  TableHeader,
  TableCell,
  TaskList,
  TaskItem.configure({ nested: true }),
  AmbyImage.configure({ inline: true }),
  MarkdownMarkup,
  AmbyTextStyle,
  AmbyUnderline,
  AmbyHtml,
  OpaqueHtmlBlock,
  OpaqueMarkdownBlock,
  ColumnSet,
  Column,
  CalloutNode,
  AmbyBlockNode,
  TransclusionNode,
]

export const editorSchema = getSchema(schemaExtensions)
