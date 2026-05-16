import type { Editor } from "@tiptap/core"
import {
  AtSign,
  CheckSquare,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Link2,
  List,
  ListOrdered,
  MessageSquare,
  Minus,
  Pilcrow,
  Quote,
} from "lucide-react"
import type { ElementType } from "react"

import { CALLOUT_DEFAULTS } from "./callout-node"

export interface BlockInsertItem {
  id: string
  title: string
  hint: string
  icon: ElementType
  /** Inserts a new block after the block at `nodePos` (used by + rail). */
  insertAfter: (editor: Editor, nodePos: number) => void
  /** Transforms/inserts at the current selection (used by slash menu and grip "turn into"). */
  inline: (editor: Editor) => void
}

function insertAfterBlock(editor: Editor, nodePos: number, json: object) {
  const node = editor.state.doc.nodeAt(nodePos)
  if (!node) return
  const after = nodePos + node.nodeSize
  editor.chain().focus().insertContentAt(after, json).run()
}

function getSelectionText(editor: Editor): string {
  const { from, to } = editor.state.selection
  if (from === to) return ""
  return editor.state.doc.textBetween(from, to, " ").trim()
}

function slugifyTag(s: string): string {
  return s.replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_\-/]/gu, "")
}

function insertInlineText(editor: Editor, text: string) {
  editor.chain().focus().insertContent(text).run()
}

function replaceSelectionOrInsert(editor: Editor, text: string) {
  const { from, to } = editor.state.selection
  if (from !== to) {
    editor.chain().focus().insertContentAt({ from, to }, text).run()
  } else {
    insertInlineText(editor, text)
  }
}

/** Wrap top-level block(s) spanning the current selection in a callout. */
export function wrapSelectionInCallout(editor: Editor) {
  const { state } = editor
  const { $from, $to } = state.selection
  const startDepth = Math.max(1, $from.depth)
  const endDepth = Math.max(1, $to.depth)
  const start = $from.before(startDepth)
  const end = $to.after(endDepth)
  const blocks: object[] = []
  state.doc.nodesBetween(start, end, (node, _pos, parent) => {
    if (parent === state.doc) {
      blocks.push(node.toJSON())
      return false
    }
    return true
  })
  if (blocks.length === 0) {
    blocks.push({ type: "paragraph" })
  }
  const callout = {
    type: "callout",
    attrs: { calloutType: "NOTE", emoji: CALLOUT_DEFAULTS.NOTE },
    content: blocks,
  }
  editor
    .chain()
    .focus()
    .insertContentAt({ from: start, to: end }, callout)
    .run()
}

export const INLINE_INSERT_ITEMS: BlockInsertItem[] = [
  {
    id: "paragraph",
    title: "Paragraph",
    hint: "Plain text",
    icon: Pilcrow,
    insertAfter: (e, pos) => insertAfterBlock(e, pos, { type: "paragraph" }),
    inline: e => e.chain().focus().setParagraph().run(),
  },
  {
    id: "h1",
    title: "Heading 1",
    hint: "# Title",
    icon: Heading1,
    insertAfter: (e, pos) => insertAfterBlock(e, pos, { type: "heading", attrs: { level: 1 } }),
    inline: e => e.chain().focus().setHeading({ level: 1 }).run(),
  },
  {
    id: "h2",
    title: "Heading 2",
    hint: "## Section",
    icon: Heading2,
    insertAfter: (e, pos) => insertAfterBlock(e, pos, { type: "heading", attrs: { level: 2 } }),
    inline: e => e.chain().focus().setHeading({ level: 2 }).run(),
  },
  {
    id: "h3",
    title: "Heading 3",
    hint: "### Subsection",
    icon: Heading3,
    insertAfter: (e, pos) => insertAfterBlock(e, pos, { type: "heading", attrs: { level: 3 } }),
    inline: e => e.chain().focus().setHeading({ level: 3 }).run(),
  },
  {
    id: "bullet",
    title: "Bullet list",
    hint: "- item",
    icon: List,
    insertAfter: (e, pos) =>
      insertAfterBlock(e, pos, {
        type: "bulletList",
        content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
      }),
    inline: e => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: "ordered",
    title: "Numbered list",
    hint: "1. item",
    icon: ListOrdered,
    insertAfter: (e, pos) =>
      insertAfterBlock(e, pos, {
        type: "orderedList",
        content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
      }),
    inline: e => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: "task",
    title: "Task list",
    hint: "[ ] todo",
    icon: CheckSquare,
    insertAfter: (e, pos) =>
      insertAfterBlock(e, pos, {
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph" }] },
        ],
      }),
    inline: e => e.chain().focus().toggleTaskList().run(),
  },
  {
    id: "code",
    title: "Code block",
    hint: "``` code",
    icon: Code2,
    insertAfter: (e, pos) => insertAfterBlock(e, pos, { type: "codeBlock" }),
    inline: e => e.chain().focus().setCodeBlock().run(),
  },
  {
    id: "callout",
    title: "Callout",
    hint: "> [!NOTE]",
    icon: MessageSquare,
    insertAfter: (e, pos) =>
      insertAfterBlock(e, pos, {
        type: "callout",
        attrs: { calloutType: "NOTE", emoji: CALLOUT_DEFAULTS.NOTE },
        content: [{ type: "paragraph" }],
      }),
    inline: e => wrapSelectionInCallout(e),
  },
  {
    id: "blockquote",
    title: "Blockquote",
    hint: "> quote",
    icon: Quote,
    insertAfter: (e, pos) =>
      insertAfterBlock(e, pos, { type: "blockquote", content: [{ type: "paragraph" }] }),
    inline: e => e.chain().focus().toggleBlockquote().run(),
  },
  {
    id: "divider",
    title: "Divider",
    hint: "---",
    icon: Minus,
    insertAfter: (e, pos) => insertAfterBlock(e, pos, { type: "horizontalRule" }),
    inline: e => e.chain().focus().setHorizontalRule().run(),
  },
  {
    id: "tag",
    title: "Tag",
    hint: "#tag",
    icon: AtSign,
    insertAfter: (e, pos) => {
      const sel = slugifyTag(getSelectionText(e)) || "tag"
      insertAfterBlock(e, pos, {
        type: "paragraph",
        content: [{ type: "text", text: `#${sel} ` }],
      })
    },
    inline: e => {
      const sel = slugifyTag(getSelectionText(e))
      replaceSelectionOrInsert(e, sel ? `#${sel} ` : "#tag ")
    },
  },
  {
    id: "backlink",
    title: "Backlink",
    hint: "[[Note]]",
    icon: Link2,
    insertAfter: (e, pos) => {
      const sel = getSelectionText(e) || "Note"
      insertAfterBlock(e, pos, {
        type: "paragraph",
        content: [{ type: "text", text: `[[${sel}]]` }],
      })
    },
    inline: e => {
      const sel = getSelectionText(e)
      replaceSelectionOrInsert(e, sel ? `[[${sel}]]` : "[[Note]]")
    },
  },
]
