import type { DatabaseRow } from "@/lib/storage"
import { ARC_COLORS } from "@/themes/palettes"
import { orderByAuthor, relationTargetsOf } from "./workshop-model"

/**
 * Anchors and arcs on the pages of a story's text (`docs/creative-format.md` §6, W9): the pure
 * part. A page keeps the note IDs of its anchors and arcs in two relations; everything the panel
 * shows about them — the marks in the tree, the order of the anchors, who is bound where — is read
 * from the rows it already holds.
 */

export type PlotKind = "anchor" | "arc"

/** The anchors and arcs one page is bound to, as note IDs, in the order the author set them. */
export interface PageBinding {
  anchors: string[]
  arcs: string[]
}

export interface PlotPropertyIds {
  anchors?: string | null
  arcs?: string | null
}

/** The bindings of the pages of a story's text, by page. A page bound to nothing is left out. */
export function readBindings(
  textRows: readonly DatabaseRow[],
  properties: PlotPropertyIds,
): Map<string, PageBinding> {
  const bindings = new Map<string, PageBinding>()
  for (const row of textRows) {
    const anchors = properties.anchors ? relationTargetsOf(row.valuesJson, properties.anchors) : []
    const arcs = properties.arcs ? relationTargetsOf(row.valuesJson, properties.arcs) : []
    if (anchors.length > 0 || arcs.length > 0) bindings.set(row.noteId, { anchors, arcs })
  }
  return bindings
}

/** The IDs a page holds for one kind. */
export function boundTo(
  bindings: ReadonlyMap<string, PageBinding>,
  pageId: string,
  kind: PlotKind,
): string[] {
  const binding = bindings.get(pageId)
  return binding ? (kind === "anchor" ? binding.anchors : binding.arcs) : []
}

/**
 * The pages (in the order of the text) a note is bound to, one kind at a time; the pages that are
 * not in the text order (not in the tree) come after.
 */
export function pagesOf(
  bindings: ReadonlyMap<string, PageBinding>,
  order: readonly string[],
  kind: PlotKind,
  targetId: string,
): string[] {
  const rank = new Map(order.map((id, index) => [id, index]))
  const pages: string[] = []
  for (const [pageId, binding] of bindings) {
    if ((kind === "anchor" ? binding.anchors : binding.arcs).includes(targetId)) pages.push(pageId)
  }
  return pages.sort(
    (a, b) =>
      (rank.get(a) ?? Number.POSITIVE_INFINITY) - (rank.get(b) ?? Number.POSITIVE_INFINITY) ||
      (a < b ? -1 : a > b ? 1 : 0),
  )
}

// ── Anchor order ────────────────────────────────────────────────────────────────────────────────

export interface PlacedAnchor<T> {
  row: T
  /** The pages of this story the anchor is bound to, in the order of the text. */
  pageIds: string[]
}

export interface StoryAnchors<T> {
  /** Bound to the text: in the order of the text. */
  placed: PlacedAnchor<T>[]
  /** Bound to no page of this story ("ahead"): in the author's own order. */
  ahead: T[]
}

export interface AnchorLike {
  noteId: string
  title: string
}

/**
 * The anchors of one story in the order they stand in it. An anchor bound to pages of this story
 * stands where the earliest of them stands in the text (depth first, in the tree's order), so the
 * text decides; two anchors on one page keep the order the page lists them in. Anchors bound to
 * no page of this story are "ahead", in the order the author placed them by hand
 * (`manualOrder`), then by the time they were made, then by title. An anchor of two stories is
 * placed in each by that story's own pages.
 */
export function orderStoryAnchors<T extends AnchorLike>(input: {
  anchors: readonly T[]
  /** The pages of the story's text in the order the tree shows them (`textOrder`). */
  textOrder: readonly string[]
  bindings: ReadonlyMap<string, PageBinding>
  manualOrder: readonly string[]
  createdOf: (noteId: string) => number | null | undefined
}): StoryAnchors<T> {
  const { anchors, bindings, manualOrder, createdOf } = input
  const rank = new Map(input.textOrder.map((id, index) => [id, index]))
  const authored = rankByAuthor(anchors, manualOrder, createdOf)

  const found = new Map<string, { page: number; slot: number }>()
  const pages = new Map<string, string[]>()
  for (const [pageId, binding] of bindings) {
    const page = rank.get(pageId)
    if (page === undefined) continue
    binding.anchors.forEach((anchorId, slot) => {
      const list = pages.get(anchorId) ?? []
      list.push(pageId)
      pages.set(anchorId, list)
      const earliest = found.get(anchorId)
      if (!earliest || page < earliest.page || (page === earliest.page && slot < earliest.slot)) {
        found.set(anchorId, { page, slot })
      }
    })
  }

  const placed: PlacedAnchor<T>[] = []
  const ahead: T[] = []
  for (const row of anchors) {
    if (found.has(row.noteId)) {
      const pageIds = [...(pages.get(row.noteId) ?? [])].sort(
        (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0),
      )
      placed.push({ row, pageIds })
    } else ahead.push(row)
  }
  placed.sort((a, b) => {
    const at = found.get(a.row.noteId)!
    const bt = found.get(b.row.noteId)!
    return at.page - bt.page || at.slot - bt.slot || authored(a.row) - authored(b.row)
  })
  ahead.sort((a, b) => authored(a) - authored(b))
  return { placed, ahead }
}

/** The position of an anchor in the author's order: placed by hand, else when it was made. */
function rankByAuthor<T extends AnchorLike>(
  rows: readonly T[],
  manualOrder: readonly string[],
  createdOf: (noteId: string) => number | null | undefined,
): (row: T) => number {
  const position = new Map(
    orderByAuthor(rows, manualOrder, createdOf).map((row, index) => [row.noteId, index]),
  )
  return (row) => position.get(row.noteId) ?? Number.MAX_SAFE_INTEGER
}

// ── Marks in the text tree ──────────────────────────────────────────────────────────────────────

/** A color that an arc always has: the palette entry its note ID picks. */
export function arcColor(arcId: string): string {
  let hash = 2166136261
  for (let index = 0; index < arcId.length; index += 1) {
    hash ^= arcId.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return ARC_COLORS[(hash >>> 0) % ARC_COLORS.length]
}

export interface ArcDot {
  id: string
  title: string
  color: string
}

export interface PageMarks {
  /** How many anchors the page holds, and their titles for the tooltip. */
  anchorCount: number
  anchorTitles: string[]
  /** Up to `maxDots` arcs as colored dots, then how many more there are. */
  dots: ArcDot[]
  more: number
  arcTitles: string[]
}

/**
 * What a text row shows for its bindings: an anchor mark with a count above one, and a dot per arc
 * up to `maxDots`, then "+N". IDs that name no known note (deleted since) are not shown. `null`
 * when nothing is left to show, so a page bound to nothing keeps the row it had.
 */
export function pageMarks(
  binding: PageBinding | undefined,
  titleOf: (kind: PlotKind, id: string) => string | undefined,
  maxDots = 3,
): PageMarks | null {
  if (!binding) return null
  const anchorTitles = binding.anchors
    .map((id) => titleOf("anchor", id))
    .filter((title): title is string => title !== undefined)
  const arcs: ArcDot[] = []
  for (const id of binding.arcs) {
    const title = titleOf("arc", id)
    if (title !== undefined) arcs.push({ id, title, color: arcColor(id) })
  }
  if (anchorTitles.length === 0 && arcs.length === 0) return null
  return {
    anchorCount: anchorTitles.length,
    anchorTitles,
    dots: arcs.slice(0, maxDots),
    more: Math.max(0, arcs.length - maxDots),
    arcTitles: arcs.map((arc) => arc.title),
  }
}

// ── Dragging a row onto a page ──────────────────────────────────────────────────────────────────

/** The type a dragged anchor or arc carries, so a page row can tell it from a moved page. */
export const PLOT_DRAG_TYPE = "application/x-amby-plot"

export interface PlotDrag {
  kind: PlotKind
  id: string
}

export function encodePlotDrag(drag: PlotDrag): string {
  return JSON.stringify(drag)
}

export function decodePlotDrag(raw: string): PlotDrag | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object") return null
    const { kind, id } = value as { kind?: unknown; id?: unknown }
    if ((kind === "anchor" || kind === "arc") && typeof id === "string" && id !== "") {
      return { kind, id }
    }
  } catch {
    // Not ours.
  }
  return null
}
