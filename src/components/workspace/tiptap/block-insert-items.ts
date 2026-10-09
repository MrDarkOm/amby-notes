import type { Editor, Range } from "@tiptap/core"
import {
  AtSign,
  Bookmark,
  CheckSquare,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Image as ImageIcon,
  ClipboardPaste,
  Link as LinkIcon,
  Link2,
  List,
  ListOrdered,
  MessageSquare,
  Minus,
  Table2,
  DatabaseZap,
  Paperclip,
  Pilcrow,
  Quote,
  Sigma,
  Smile,
  Superscript,
} from "lucide-react"
import type { ElementType } from "react"

import { CALLOUT_DEFAULTS } from "./callout-node"
import { newBlockId } from "./amby-block-node"
import { insertFootnote } from "./footnote-nodes"
import { insertMathBlock } from "./math-block"
import { importImageFromClipboard } from "./media-drop"
import { attachmentKind } from "./attachment-kind"
import { importAsset, pickAssetFile } from "@/lib/storage"
import type { DatabaseViewChoice } from "@/components/workspace/database/database-view-picker-model"
import { useDatabaseStore } from "@/components/workspace/database/database-store"
import { newLinkedBlock, stringifyLinkedBlock } from "@/components/workspace/database/linked-block"
import { viewFromChoice } from "@/components/workspace/database/linked-view-factory"

export type BlockItemCategory = "text" | "list" | "media" | "embed"
export type BlockItemSurface = "plus" | "slash" | "turn-into"

export interface BlockMediaContext {
  vaultPath?: string
  notePath?: string
  /** Panel-provided overlay: request inline URL input mode (for an image or a bookmark). */
  requestUrlInput?: (purpose?: "image" | "bookmark") => void
  /** Panel-provided overlay: request emoji-picker mode. */
  requestEmojiPicker?: () => void
  /** Panel-provided overlay: request the database view picker. */
  requestDatabasePicker?: () => void
}

export interface BlockInsertItem {
  id: string
  icon: ElementType
  category: BlockItemCategory
  availableIn: ReadonlyArray<BlockItemSurface>
  shortcut?: string
  /** Inserts a new block after the block at `nodePos` (used by + rail). */
  insertAfter: (editor: Editor, nodePos: number, ctx?: BlockMediaContext) => unknown
  /** Transforms/inserts at the current selection (used by slash menu and grip "turn into"). */
  inline: (editor: Editor, ctx?: BlockMediaContext) => unknown
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
  editor.chain().focus().insertContentAt({ from: start, to: end }, callout).run()
}

async function pickAndImportImage(ctx?: BlockMediaContext): Promise<string | null> {
  if (!ctx?.vaultPath || !ctx.notePath) return null
  const src = await pickAssetFile(true)
  if (!src) return null
  const result = await importAsset(ctx.vaultPath, ctx.notePath, src)
  return result?.relPath ?? null
}

async function pickAndImportFile(
  ctx?: BlockMediaContext,
): Promise<{ relPath: string; fileName: string } | null> {
  if (!ctx?.vaultPath || !ctx.notePath) return null
  const src = await pickAssetFile(false)
  if (!src) return null
  const result = await importAsset(ctx.vaultPath, ctx.notePath, src)
  if (!result) return null
  return { relPath: result.relPath, fileName: result.fileName }
}

/**
 * An audio, video or PDF file is written like an image, `![name](assets/file)`, and shown
 * as a player or a card; any other file is a link to it.
 */
function fileContent(picked: { relPath: string; fileName: string }) {
  if (attachmentKind(picked.relPath)) {
    return { type: "image", attrs: { src: picked.relPath, alt: picked.fileName } }
  }
  return {
    type: "text",
    marks: [{ type: "link", attrs: { href: picked.relPath } }],
    text: picked.fileName,
  }
}

const COMMON: ReadonlyArray<BlockItemSurface> = ["plus", "slash", "turn-into"]
const PLUS_SLASH: ReadonlyArray<BlockItemSurface> = ["plus", "slash"]
const SLASH_ONLY: ReadonlyArray<BlockItemSurface> = ["slash"]

export const INLINE_INSERT_ITEMS: BlockInsertItem[] = [
  {
    id: "paragraph",
    icon: Pilcrow,
    category: "text",
    availableIn: COMMON,
    insertAfter: (e, pos) => insertAfterBlock(e, pos, { type: "paragraph" }),
    inline: (e) => e.chain().focus().setParagraph().run(),
  },
  {
    id: "h1",
    icon: Heading1,
    category: "text",
    availableIn: COMMON,
    shortcut: "#",
    insertAfter: (e, pos) => insertAfterBlock(e, pos, { type: "heading", attrs: { level: 1 } }),
    inline: (e) => e.chain().focus().setHeading({ level: 1 }).run(),
  },
  {
    id: "h2",
    icon: Heading2,
    category: "text",
    availableIn: COMMON,
    shortcut: "##",
    insertAfter: (e, pos) => insertAfterBlock(e, pos, { type: "heading", attrs: { level: 2 } }),
    inline: (e) => e.chain().focus().setHeading({ level: 2 }).run(),
  },
  {
    id: "h3",
    icon: Heading3,
    category: "text",
    availableIn: COMMON,
    shortcut: "###",
    insertAfter: (e, pos) => insertAfterBlock(e, pos, { type: "heading", attrs: { level: 3 } }),
    inline: (e) => e.chain().focus().setHeading({ level: 3 }).run(),
  },
  {
    id: "h4",
    icon: Heading4,
    category: "text",
    availableIn: COMMON,
    shortcut: "####",
    insertAfter: (e, pos) => insertAfterBlock(e, pos, { type: "heading", attrs: { level: 4 } }),
    inline: (e) => e.chain().focus().setHeading({ level: 4 }).run(),
  },
  {
    id: "h5",
    icon: Heading5,
    category: "text",
    availableIn: COMMON,
    shortcut: "#####",
    insertAfter: (e, pos) => insertAfterBlock(e, pos, { type: "heading", attrs: { level: 5 } }),
    inline: (e) => e.chain().focus().setHeading({ level: 5 }).run(),
  },
  {
    id: "h6",
    icon: Heading6,
    category: "text",
    availableIn: COMMON,
    shortcut: "######",
    insertAfter: (e, pos) => insertAfterBlock(e, pos, { type: "heading", attrs: { level: 6 } }),
    inline: (e) => e.chain().focus().setHeading({ level: 6 }).run(),
  },
  {
    id: "bullet",
    icon: List,
    category: "list",
    availableIn: COMMON,
    insertAfter: (e, pos) =>
      insertAfterBlock(e, pos, {
        type: "bulletList",
        content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
      }),
    inline: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: "ordered",
    icon: ListOrdered,
    category: "list",
    availableIn: COMMON,
    insertAfter: (e, pos) =>
      insertAfterBlock(e, pos, {
        type: "orderedList",
        content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
      }),
    inline: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: "task",
    icon: CheckSquare,
    category: "list",
    availableIn: COMMON,
    insertAfter: (e, pos) =>
      insertAfterBlock(e, pos, {
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph" }] },
        ],
      }),
    inline: (e) => {
      const ok = e.chain().focus().toggleTaskList().run()
      if (ok) return
      // Fallback: replace the current top-level block with a fresh taskList.
      const { $from } = e.state.selection
      const depth = Math.max(1, $from.depth)
      const start = $from.before(depth)
      const end = $from.after(depth)
      e.chain()
        .focus()
        .insertContentAt(
          { from: start, to: end },
          {
            type: "taskList",
            content: [
              { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph" }] },
            ],
          },
        )
        // taskList(1) + taskItem(1) + paragraph(1) = start + 3
        .setTextSelection(start + 3)
        .run()
    },
  },
  {
    id: "code",
    icon: Code2,
    category: "text",
    availableIn: COMMON,
    insertAfter: (e, pos) => insertAfterBlock(e, pos, { type: "codeBlock" }),
    inline: (e) => e.chain().focus().setCodeBlock().run(),
  },
  {
    id: "math",
    icon: Sigma,
    category: "text",
    availableIn: PLUS_SLASH,
    insertAfter: (e, pos) => insertMathBlock(e.state, pos, e.view.dispatch),
    inline: (e) => insertMathBlock(e.state, e.state.selection.from, e.view.dispatch),
  },
  {
    id: "footnote",
    icon: Superscript,
    category: "text",
    availableIn: SLASH_ONLY,
    insertAfter: () => undefined,
    inline: (e) => insertFootnote(e.state, e.view.dispatch),
  },
  {
    id: "callout",
    icon: MessageSquare,
    category: "text",
    availableIn: COMMON,
    insertAfter: (e, pos) => {
      const node = e.state.doc.nodeAt(pos)
      if (!node) return
      const after = pos + node.nodeSize
      e.chain()
        .focus()
        .insertContentAt(after, {
          type: "callout",
          attrs: { calloutType: "NOTE", emoji: CALLOUT_DEFAULTS.NOTE },
          content: [{ type: "paragraph" }],
        })
        // callout open(1) + paragraph open(1) = put cursor at after + 2
        .setTextSelection(after + 2)
        .run()
    },
    inline: (e) => {
      const { from, to } = e.state.selection
      if (from !== to) {
        wrapSelectionInCallout(e)
        return
      }
      // No selection: replace current empty/active block with a callout, cursor inside.
      const { $from } = e.state.selection
      const depth = Math.max(1, $from.depth)
      const start = $from.before(depth)
      const end = $from.after(depth)
      e.chain()
        .focus()
        .insertContentAt(
          { from: start, to: end },
          {
            type: "callout",
            attrs: { calloutType: "NOTE", emoji: CALLOUT_DEFAULTS.NOTE },
            content: [{ type: "paragraph" }],
          },
        )
        .setTextSelection(start + 2)
        .run()
    },
  },
  {
    id: "database",
    icon: Table2,
    category: "embed",
    availableIn: PLUS_SLASH,
    insertAfter: (e, pos) => {
      const node = e.state.doc.nodeAt(pos)
      if (!node) return
      const after = pos + node.nodeSize
      e.chain()
        .focus()
        .insertContentAt(after, {
          type: "ambyBlock",
          attrs: { blockType: "db", blockId: newBlockId() },
        })
        .run()
    },
    inline: (e) =>
      e
        .chain()
        .focus()
        .insertContent({ type: "ambyBlock", attrs: { blockType: "db", blockId: newBlockId() } })
        .run(),
  },
  {
    id: "database-view",
    icon: DatabaseZap,
    category: "embed",
    availableIn: PLUS_SLASH,
    // The panel owns the picker; the block is inserted by `insertDatabaseView`.
    insertAfter: (_e, _pos, ctx) => {
      ctx?.requestDatabasePicker?.()
    },
    inline: (_e, ctx) => {
      ctx?.requestDatabasePicker?.()
    },
  },
  {
    id: "blockquote",
    icon: Quote,
    category: "text",
    availableIn: COMMON,
    insertAfter: (e, pos) =>
      insertAfterBlock(e, pos, { type: "blockquote", content: [{ type: "paragraph" }] }),
    inline: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    id: "divider",
    icon: Minus,
    category: "text",
    availableIn: COMMON,
    insertAfter: (e, pos) => insertAfterBlock(e, pos, { type: "horizontalRule" }),
    inline: (e) => e.chain().focus().setHorizontalRule().run(),
  },
  {
    id: "image-local",
    icon: ImageIcon,
    category: "media",
    availableIn: PLUS_SLASH,
    insertAfter: async (e, pos, ctx) => {
      const rel = await pickAndImportImage(ctx)
      if (!rel) return
      insertAfterBlock(e, pos, {
        type: "paragraph",
        content: [{ type: "image", attrs: { src: rel } }],
      })
    },
    inline: async (e, ctx) => {
      const rel = await pickAndImportImage(ctx)
      if (!rel) return
      e.chain()
        .focus()
        .insertContent({ type: "image", attrs: { src: rel } })
        .run()
    },
  },
  {
    id: "image-clipboard",
    icon: ClipboardPaste,
    category: "media",
    availableIn: PLUS_SLASH,
    insertAfter: async (e, pos, ctx) => {
      const rel = await importImageFromClipboard(ctx)
      if (!rel) return
      insertAfterBlock(e, pos, {
        type: "paragraph",
        content: [{ type: "image", attrs: { src: rel } }],
      })
    },
    inline: async (e, ctx) => {
      const rel = await importImageFromClipboard(ctx)
      if (!rel) return
      e.chain()
        .focus()
        .insertContent({ type: "image", attrs: { src: rel } })
        .run()
    },
  },
  {
    id: "image-url",
    icon: LinkIcon,
    category: "media",
    availableIn: PLUS_SLASH,
    insertAfter: (_e, _pos, ctx) => {
      ctx?.requestUrlInput?.()
    },
    inline: (_e, ctx) => {
      ctx?.requestUrlInput?.()
    },
  },
  {
    id: "file-local",
    icon: Paperclip,
    category: "media",
    availableIn: PLUS_SLASH,
    insertAfter: async (e, pos, ctx) => {
      const picked = await pickAndImportFile(ctx)
      if (!picked) return
      insertAfterBlock(e, pos, { type: "paragraph", content: [fileContent(picked)] })
    },
    inline: async (e, ctx) => {
      const picked = await pickAndImportFile(ctx)
      if (!picked) return
      e.chain()
        .focus()
        .insertContent(fileContent(picked) as never)
        .run()
    },
  },
  {
    id: "bookmark",
    icon: Bookmark,
    category: "embed",
    availableIn: PLUS_SLASH,
    insertAfter: (_e, _pos, ctx) => {
      ctx?.requestUrlInput?.("bookmark")
    },
    inline: (_e, ctx) => {
      ctx?.requestUrlInput?.("bookmark")
    },
  },
  {
    id: "tag",
    icon: AtSign,
    category: "embed",
    availableIn: SLASH_ONLY,
    insertAfter: (e, pos) => {
      const node = e.state.doc.nodeAt(pos)
      if (!node) return
      const after = pos + node.nodeSize
      e.chain()
        .focus()
        .insertContentAt(after, { type: "paragraph", content: [{ type: "text", text: "#" }] })
        .setTextSelection(after + 2)
        .run()
    },
    inline: (e) => {
      const sel = slugifyTag(getSelectionText(e))
      if (sel) {
        replaceSelectionOrInsert(e, `#${sel} `)
      } else {
        // Insert just "#" and leave cursor right after — user types tag name.
        replaceSelectionOrInsert(e, "#")
      }
    },
  },
  {
    id: "backlink",
    icon: Link2,
    category: "embed",
    availableIn: SLASH_ONLY,
    insertAfter: (e, pos) => {
      const node = e.state.doc.nodeAt(pos)
      if (!node) return
      const after = pos + node.nodeSize
      e.chain()
        .focus()
        .insertContentAt(after, {
          type: "paragraph",
          content: [{ type: "text", text: "[[]]" }],
        })
        // open(1) + text "[[ " offset of 2 brackets = after + 3
        .setTextSelection(after + 3)
        .run()
    },
    inline: (e) => {
      const sel = getSelectionText(e)
      if (sel) {
        replaceSelectionOrInsert(e, `[[${sel}]]`)
        return
      }
      // Insert [[]] and place cursor between brackets.
      const { from } = e.state.selection
      e.chain()
        .focus()
        .insertContent("[[]]")
        .setTextSelection(from + 2)
        .run()
    },
  },
  {
    id: "emoji",
    icon: Smile,
    category: "embed",
    availableIn: PLUS_SLASH,
    insertAfter: (_e, _pos, ctx) => {
      ctx?.requestEmojiPicker?.()
    },
    inline: (_e, ctx) => {
      ctx?.requestEmojiPicker?.()
    },
  },
]

/**
 * Inserts a database shortcut at the selection: one tab on the chosen database,
 * shown as chosen, with a private copy of the saved view's settings if one was
 * chosen. The slash text goes away together with the insertion, so a cancelled
 * picker leaves the note as it was.
 */
export async function insertDatabaseView(
  editor: Editor,
  choice: DatabaseViewChoice,
  range?: Range,
) {
  const { databases, vaultGeneration } = useDatabaseStore.getState()
  const database = databases.find((candidate) => candidate.databaseId === choice.databaseId)
  if (!database) return
  const view = await viewFromChoice(choice, database, vaultGeneration)
  if (editor.isDestroyed) return
  const chain = editor.chain().focus()
  if (range) chain.deleteRange(range)
  chain
    .insertContent({
      type: "ambyBlock",
      attrs: { blockType: "db", blockId: stringifyLinkedBlock(newLinkedBlock(view)) },
    })
    .run()
}

const TURN_INTO_BLACKLIST = new Set([
  "divider",
  "database-view",
  "image-local",
  "image-clipboard",
  "image-url",
  "file-local",
  "bookmark",
])

export function getPlusItems(): BlockInsertItem[] {
  return INLINE_INSERT_ITEMS.filter((i) => i.availableIn.includes("plus"))
}

export function getSlashItems(): BlockInsertItem[] {
  return INLINE_INSERT_ITEMS.filter((i) => i.availableIn.includes("slash"))
}

export function getTurnIntoItems(): BlockInsertItem[] {
  return INLINE_INSERT_ITEMS.filter(
    (i) => i.availableIn.includes("turn-into") && !TURN_INTO_BLACKLIST.has(i.id),
  )
}

const CATEGORY_ORDER: ReadonlyArray<BlockItemCategory> = ["text", "list", "media", "embed"]

/**
 * The items a query leaves, in the order the menu shows them: group by group; inside a
 * group a title that starts with the query comes before one that only contains it, and
 * a match in the Markdown hint or the id comes last.
 */
export function filterBlockItems(
  items: ReadonlyArray<BlockInsertItem>,
  query: string,
  title: (item: BlockInsertItem) => string,
  hint: (item: BlockInsertItem) => string,
): BlockInsertItem[] {
  const needle = query.trim().toLocaleLowerCase()
  const ranked: Array<{ item: BlockInsertItem; rank: number; index: number }> = []
  items.forEach((item, index) => {
    if (!needle) {
      ranked.push({ item, rank: 0, index })
      return
    }
    const name = title(item).toLocaleLowerCase()
    const words = name.split(/\s+/u)
    const other = `${item.id} ${item.shortcut ?? ""} ${hint(item)}`.toLocaleLowerCase()
    const rank = name.startsWith(needle)
      ? 0
      : words.some((word) => word.startsWith(needle))
        ? 1
        : name.includes(needle)
          ? 2
          : other.includes(needle)
            ? 3
            : -1
    if (rank >= 0) ranked.push({ item, rank, index })
  })
  return ranked
    .sort(
      (a, b) =>
        CATEGORY_ORDER.indexOf(a.item.category) - CATEGORY_ORDER.indexOf(b.item.category) ||
        a.rank - b.rank ||
        a.index - b.index,
    )
    .map((entry) => entry.item)
}
