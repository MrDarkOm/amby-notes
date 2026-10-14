import type { NoteReference, WorkshopSummary } from "@/lib/storage"
import {
  boundTo,
  orderStoryAnchors,
  pagesOf,
  type AnchorLike,
  type PageBinding,
  type StoryAnchors,
} from "./plot-model"
import { orderByAuthor, type Membership, type PanelFilter } from "./workshop-model"

/**
 * What the plot looks like from one place (`docs/creative-format.md` §6): the neighbours of a page
 * of the text, the anchors of a story as a ribbon, the anchors of a universe or of the whole
 * workshop, and the anchors and chapters of an arc. All of it is computed from rows already read;
 * nothing is stored, and the components only show what these return.
 */

// ── Neighbours of a page ────────────────────────────────────────────────────────────────────────

export interface PageNeighbours<T> {
  /** The anchors bound to this very page, in the order the page lists them. */
  own: T[]
  /** The nearest bound anchor before the page in the order of the text, not counting its own. */
  from: T | null
  /** The nearest bound anchor after the page; else the first one "ahead". */
  to: T | null
  /** `to` is an anchor bound to no page ("ahead"), because none stands after the page. */
  toAhead: boolean
}

/**
 * Where a page stands among the anchors of its story. An anchor stands at the earliest of its
 * pages (`orderStoryAnchors`), so "before" and "after" compare that place with the page's.
 * The anchors of the page itself are neither. A page that is not in the text order (or an unknown
 * one) has no neighbours.
 */
export function pageNeighbours<T extends AnchorLike>(
  pageId: string,
  ordered: StoryAnchors<T>,
  textOrder: readonly string[],
  bindings: ReadonlyMap<string, PageBinding>,
): PageNeighbours<T> {
  const rank = new Map(textOrder.map((id, index) => [id, index]))
  const byId = new Map(ordered.placed.map((entry) => [entry.row.noteId, entry.row]))
  const own: T[] = []
  for (const id of boundTo(bindings, pageId, "anchor")) {
    const row = byId.get(id)
    if (row && !own.includes(row)) own.push(row)
  }
  const here = rank.get(pageId)
  if (here === undefined) return { own, from: null, to: null, toAhead: false }

  const ownIds = new Set(own.map((row) => row.noteId))
  let from: T | null = null
  let to: T | null = null
  for (const entry of ordered.placed) {
    if (ownIds.has(entry.row.noteId)) continue
    const place = rank.get(entry.pageIds[0] ?? "") ?? Number.POSITIVE_INFINITY
    if (place < here) from = entry.row
    else if (to === null) to = entry.row
  }
  if (to !== null) return { own, from, to, toAhead: false }
  const ahead = ordered.ahead[0] ?? null
  return { own, from, to: ahead, toAhead: ahead !== null }
}

// ── The ribbon of a story ───────────────────────────────────────────────────────────────────────

export interface RibbonItem<T> {
  row: T
  /** The first page the anchor is bound to, or `null` for an anchor "ahead". */
  pageId: string | null
  /** The anchor stands on a page whose status is in the "done" group. */
  done: boolean
}

/**
 * The anchors of a story in the order of its text: the bound ones first (with their first page),
 * then those "ahead". An anchor is "passed" when its first page is done.
 */
export function anchorRibbon<T extends AnchorLike>(
  ordered: StoryAnchors<T>,
  isDone: (pageId: string) => boolean,
): RibbonItem<T>[] {
  return [
    ...ordered.placed.map((entry) => {
      const pageId = entry.pageIds[0] ?? null
      return { row: entry.row, pageId, done: pageId !== null && isDone(pageId) }
    }),
    ...ordered.ahead.map((row) => ({ row, pageId: null, done: false })),
  ]
}

// ── Anchors of a universe or of the whole workshop ──────────────────────────────────────────────

export interface AnchorBuckets<T> {
  /** The events of the shown universe: anchors that name it themselves. Only for a universe. */
  events: T[]
  /** The anchors of the shown stories (or all the anchors that belong somewhere). */
  shown: T[]
  /** Only for the whole workshop: in no story, bound to no page and with no universe. */
  withoutStory: T[]
}

/**
 * The anchors a panel shows when it is not about one story, all in the author's own order. In the
 * whole workshop those that belong nowhere (no story, no page, no universe) come last; in a
 * universe its events come first and then the anchors of its stories.
 */
export function bucketAnchors<T extends AnchorLike>(input: {
  anchors: readonly T[]
  filter: PanelFilter
  membership: Membership
  /** The universe an anchor names, if it does. */
  universeOf: (noteId: string) => string | null
  manualOrder: readonly string[]
  createdOf: (noteId: string) => number | null | undefined
}): AnchorBuckets<T> {
  const { filter, membership, universeOf } = input
  const ordered = orderByAuthor(input.anchors, input.manualOrder, input.createdOf)
  const result: AnchorBuckets<T> = { events: [], shown: [], withoutStory: [] }
  for (const row of ordered) {
    const stories = membership.storiesOf(row.noteId)
    if (filter.kind === "all") {
      ;(stories.length > 0 || universeOf(row.noteId) !== null
        ? result.shown
        : result.withoutStory
      ).push(row)
    } else if (filter.kind === "universe") {
      if (universeOf(row.noteId) === filter.universeId) result.events.push(row)
      else if (stories.some((storyId) => membership.universeOf(storyId) === filter.universeId)) {
        result.shown.push(row)
      }
    } else if (stories.includes(filter.storyId)) result.shown.push(row)
  }
  return result
}

/** The events of one universe: the anchors that name it, in the author's order. */
export function universeEvents<T extends AnchorLike>(input: {
  anchors: readonly T[]
  universeId: string
  universeOf: (noteId: string) => string | null
  manualOrder: readonly string[]
  createdOf: (noteId: string) => number | null | undefined
}): T[] {
  return orderByAuthor(
    input.anchors.filter((row) => input.universeOf(row.noteId) === input.universeId),
    input.manualOrder,
    input.createdOf,
  )
}

// ── An arc ──────────────────────────────────────────────────────────────────────────────────────

/** The text of one story as the plot reads it. */
export interface StoryPlotText {
  storyId: string
  storyName: string
  /** The pages of the text in the order the tree shows them. */
  textOrder: readonly string[]
  bindings: ReadonlyMap<string, PageBinding>
}

export interface ArcAnchorGroup<T> {
  storyId: string
  storyName: string
  anchors: T[]
}

export interface ArcAnchors<T> {
  /** The anchors that name the arc and stand in a story's text, story by story in text order. */
  byStory: ArcAnchorGroup<T>[]
  /** The anchors that name the arc and stand in no text, in the author's order. */
  unbound: T[]
}

/** The anchors of an arc: those whose "Arcs" relation holds it, placed by each story's text. */
export function arcAnchors<T extends AnchorLike>(input: {
  arcId: string
  anchors: readonly T[]
  /** The arcs an anchor names. */
  arcsOf: (noteId: string) => readonly string[]
  stories: readonly StoryPlotText[]
  manualOrder: readonly string[]
  createdOf: (noteId: string) => number | null | undefined
}): ArcAnchors<T> {
  const named = input.anchors.filter((row) => input.arcsOf(row.noteId).includes(input.arcId))
  const placedAnywhere = new Set<string>()
  const byStory: ArcAnchorGroup<T>[] = []
  for (const story of input.stories) {
    const { placed } = orderStoryAnchors({
      anchors: named,
      textOrder: story.textOrder,
      bindings: story.bindings,
      manualOrder: input.manualOrder,
      createdOf: input.createdOf,
    })
    if (placed.length === 0) continue
    for (const entry of placed) placedAnywhere.add(entry.row.noteId)
    byStory.push({
      storyId: story.storyId,
      storyName: story.storyName,
      anchors: placed.map((entry) => entry.row),
    })
  }
  const unbound = orderByAuthor(
    named.filter((row) => !placedAnywhere.has(row.noteId)),
    input.manualOrder,
    input.createdOf,
  )
  return { byStory, unbound }
}

export interface ArcChapters {
  storyId: string
  storyName: string
  /** The pages of the text this story binds the arc to, in the order of the text. */
  pageIds: string[]
  /** The first and the last of them; `null` when the arc covers a single page. */
  span: { from: string; to: string } | null
}

/** The chapters an arc is bound to, story by story; a story that does not bind it is left out. */
export function arcChapters(arcId: string, stories: readonly StoryPlotText[]): ArcChapters[] {
  const result: ArcChapters[] = []
  for (const story of stories) {
    const pageIds = pagesOf(story.bindings, story.textOrder, "arc", arcId)
    if (pageIds.length === 0) continue
    const first = pageIds[0]
    const last = pageIds[pageIds.length - 1]
    result.push({
      storyId: story.storyId,
      storyName: story.storyName,
      pageIds,
      span: first === last ? null : { from: first, to: last },
    })
  }
  return result
}

// ── Arcs of a character ─────────────────────────────────────────────────────────────────────────

/**
 * The arcs that name a character in their "Characters" relation, by title. They are the
 * references that point at the page through that property (the arcs' own side of the relation).
 */
export function characterArcs(
  references: readonly NoteReference[],
  charactersPropertyId: string | null,
): NoteReference[] {
  if (!charactersPropertyId) return []
  return references
    .filter(
      (reference) =>
        reference.direction === "in" &&
        reference.propertyId === charactersPropertyId &&
        reference.title !== null,
    )
    .sort((a, b) =>
      (a.title ?? "").localeCompare(b.title ?? "", undefined, { sensitivity: "base" }),
    )
}

// ── The anchors' own links ──────────────────────────────────────────────────────────────────────

/**
 * Whether the anchors database lacks a relation it could have: "Arcs" while there are arcs, or
 * "Universe" while there are universes. Whichever base was made second leaves the other without
 * its relation (one operation has room for one structure file), and `ensure_plot_links` with the
 * `anchors` target makes it.
 */
export function anchorLinksMissing(workshop: WorkshopSummary): boolean {
  const exists = (role: string) =>
    workshop.sections.find((section) => section.role === role && section.state !== "missing")
  const anchors = exists("anchors")
  if (!anchors) return false
  return (
    (exists("arcs") !== undefined && !anchors.arcsPropertyId) ||
    (exists("universes") !== undefined && !anchors.universePropertyId)
  )
}
