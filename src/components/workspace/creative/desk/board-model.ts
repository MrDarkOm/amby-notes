import {
  assessPageMove,
  findNode,
  lastOrderKey,
  type MovePlan,
  type MoveRefusal,
  type TextNode,
} from "../workshop/text-tree-model"

/**
 * The text of a story as a board (pure): a column per top page that holds pages, its pages as
 * cards, and the top pages that hold nothing as one column of their own. Moves on the board are
 * the moves of the tree (`assessPageMove`), so the levels of the schema decide what is allowed.
 */

export interface BoardColumn {
  /** The page whose pages are the cards; `null` for the top pages with nothing inside. */
  id: string | null
  title: string | null
  cards: TextNode[]
}

export function boardColumns(roots: TextNode[]): BoardColumn[] {
  const columns: BoardColumn[] = []
  let loose: BoardColumn | null = null
  for (const root of roots) {
    if (root.children.length > 0) {
      columns.push({ id: root.noteId, title: root.title, cards: root.children })
    } else {
      if (!loose) {
        loose = { id: null, title: null, cards: [] }
        columns.push(loose)
      }
      loose.cards.push(root)
    }
  }
  return columns
}

/** Where a card dropped on another card (before it) or on a column (at its end) goes. */
export function boardDropPlan(
  roots: TextNode[],
  levels: { id: string }[],
  draggedId: string,
  target: { card: string } | { column: string | null },
): { plan: MovePlan } | { reason: MoveRefusal } {
  if ("card" in target) return assessPageMove(roots, levels, draggedId, target.card, "before")
  if (target.column !== null) {
    return assessPageMove(roots, levels, draggedId, target.column, "inside")
  }
  // The column of loose top pages: the end of the top of the text.
  const dragged = findNode(roots, draggedId)
  if (!dragged) return { reason: "missingPage" }
  return {
    plan: {
      newParentId: null,
      orderKey: lastOrderKey(roots.filter((root) => root.noteId !== draggedId)),
    },
  }
}

const SYNOPSIS_LENGTH = 160
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)

/** Markdown marks a reader does not see: emphasis, code, wiki links and links shown by text. */
function plain(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/(\*\*|__|\*|_|~~|`)/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
}

/**
 * The first paragraph of a page, as a card shows it: past the frontmatter, headings, quotes'
 * marks and fences, without Markdown marks, at most a short line long.
 */
export function synopsisOf(markdown: string): string {
  const text = markdown.startsWith(BYTE_ORDER_MARK) ? markdown.slice(1) : markdown
  const lines = text.split(/\r?\n/u)
  let start = 0
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/u.test(line))
    start = end < 0 ? lines.length : end + 1
  }
  const paragraph: string[] = []
  let fence = false
  for (const raw of lines.slice(start)) {
    const line = raw.trim()
    if (/^(```|~~~)/u.test(line)) {
      fence = !fence
      if (paragraph.length) break
      continue
    }
    if (fence) continue
    if (!line) {
      if (paragraph.length) break
      continue
    }
    if (/^#{1,6}\s/u.test(line) || /^(-{3,}|\*{3,})$/u.test(line)) {
      if (paragraph.length) break
      continue
    }
    paragraph.push(line.replace(/^>\s?/u, "").replace(/^([-*+]|\d+\.)\s+/u, ""))
  }
  const result = plain(paragraph.join(" "))
  if (result.length <= SYNOPSIS_LENGTH) return result
  return `${result.slice(0, SYNOPSIS_LENGTH).trimEnd()}…`
}
