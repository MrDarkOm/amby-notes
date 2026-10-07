import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"

import { AmbyBlockView } from "./AmbyBlockView"

/**
 * Inline "special block" placeholder. The note's `.md` carries only a fenced
 * code block as the portable marker:
 *
 *   ```amby-db
 *   <blockId>
 *   ```
 *
 * (round-tripped by detectAmbyBlocks + the `ambyBlock` serializer in markdown.ts).
 * The actual block data/config lives in `{vault}/.amby/blocks/<blockId>.json`, so
 * the `.md` stays clean and readable in Obsidian (where it shows as a code block).
 *
 * Attributes:
 *   blockType — kind of block (pilot: "db")
 *   blockId   — opaque id keying the sidecar JSON
 */
export const AmbyBlockNode = Node.create({
  name: "ambyBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      blockType: { default: "db" },
      blockId: { default: "" },
    }
  },

  parseHTML() {
    return [
      {
        tag: "div[data-type=amby-block]",
        getAttrs: (el) => {
          const div = el as HTMLElement
          return {
            blockType: div.getAttribute("data-block-type") ?? "db",
            blockId: div.getAttribute("data-block-id") ?? "",
          }
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "amby-block",
        "data-block-type": node.attrs.blockType,
        "data-block-id": node.attrs.blockId,
      }),
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(AmbyBlockView, {
      stopEvent: ({ event }) => stopsEditorEvent(event),
    })
  },
})

const FORM_TAGS = new Set(["INPUT", "BUTTON", "SELECT", "TEXTAREA"])
const EDITOR_OWNED_EVENTS = new Set([
  "mousedown",
  "dragstart",
  "dragover",
  "drop",
  "copy",
  "cut",
  "paste",
])

/**
 * Whether the block, not the editor, handles this event. Inside a database block
 * everything is the block's: otherwise a click on a tab or cell would also select
 * the block as a note object and pop up the text-formatting toolbar. Elsewhere
 * (the legacy table) form controls keep their events and the rest is the editor's.
 */
export function stopsEditorEvent(event: Event): boolean {
  const target = event.target
  if (!(target instanceof Element)) return false
  if (target.closest(".amby-database-host")) return true
  if (FORM_TAGS.has(target.tagName) || (target as HTMLElement).isContentEditable) return true
  return !EDITOR_OWNED_EVENTS.has(event.type)
}

/** Generate a fresh opaque block id (UUID; falls back if crypto is unavailable). */
export function newBlockId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `blk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}
