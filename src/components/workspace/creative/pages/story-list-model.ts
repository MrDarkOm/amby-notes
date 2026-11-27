import type { DatabasePropertySummary, DatabaseRow, StorySummary } from "@/lib/storage"
import { draftsFromProperty } from "../../database/option-model"
import { optionIdOf, orderByAuthor } from "../workshop/workshop-model"
import type { StoryStat } from "./story-stats-model"

export const STORY_FILTERS = ["all", "favorites", "inProgress", "finished"] as const
export type StoryFilter = (typeof STORY_FILTERS)[number]

export const STORY_SORTS = ["recent", "name", "words", "progress", "created", "order"] as const
export type StorySort = (typeof STORY_SORTS)[number]

/** The world filter: every world, the stories no universe holds, or one universe's ID. */
export type WorldFilter = "all" | "standalone" | (string & {})

/** One story as the card and the list work with it: the catalog entry and its numbers joined. */
export interface StoryEntry {
  storyId: string
  name: string
  /** The story's main note ID: the key of the shared favorites; `null` for a story with no card. */
  cardNoteId: string | null
  universeId: string | null
  universeName: string | null
  finished: boolean
  favorite: boolean
  words: number
  pages: number
  /** Pages done; `null` when the story keeps no page status. */
  donePages: number | null
  /** Seconds since the epoch; `null` before any page has a time. */
  lastModified: number | null
  created: number | null
}

export type StoriesView = "cards" | "timeline"

/** Reads a remembered view of a universe's stories; anything unknown is the cards. */
export function parseStoriesView(value: unknown): StoriesView {
  return value === "timeline" ? "timeline" : "cards"
}

/** Reads a remembered filter; anything unknown is "all". */
export function parseStoryFilter(value: unknown): StoryFilter {
  return STORY_FILTERS.find((filter) => filter === value) ?? "all"
}

/** The sorts the workshop's page and the standalone page offer: the hand-placed order is a universe's. */
export const PLAIN_STORY_SORTS: readonly StorySort[] = STORY_SORTS.filter(
  (sort) => sort !== "order",
)

/**
 * Reads a remembered sort; anything unknown, or not offered where it is read, is `fallback`
 * (the last change unless the page says otherwise).
 */
export function parseStorySort(
  value: unknown,
  offered: readonly StorySort[] = PLAIN_STORY_SORTS,
  fallback: StorySort = "recent",
): StorySort {
  return offered.find((sort) => sort === value) ?? fallback
}

/** What puts the stories in the author's order: the hand-placed card IDs and when cards were made. */
export interface StoryOrderInput {
  /** Card note IDs the author placed by hand, in order (the stories base's first view). */
  manualOrder: readonly string[]
  /** When a card was made, by its note ID; a story without a time comes after those with one. */
  createdOf?: (cardNoteId: string) => number | null | undefined
}

/**
 * The stories in the author's order: those placed by hand first, the rest by the time their card
 * was made (the time of their first page where the card has none), then by name. A story with no
 * card cannot be placed and goes by time like an unplaced one.
 */
export function orderStoryEntries(
  entries: readonly StoryEntry[],
  order: StoryOrderInput,
): StoryEntry[] {
  const keyOf = (entry: StoryEntry) => entry.cardNoteId ?? `story:${entry.storyId}`
  const byKey = new Map(entries.map((entry) => [keyOf(entry), entry]))
  return orderByAuthor(
    entries.map((entry) => ({ noteId: keyOf(entry), title: entry.name })),
    order.manualOrder,
    (key) => order.createdOf?.(key) ?? byKey.get(key)?.created,
  ).flatMap((item) => byKey.get(item.noteId) ?? [])
}

/**
 * The options of a status property that stand in its "done" group; the "Status" of the stories
 * base is read like any status (`draftsFromProperty`), so a renamed option still counts.
 */
export function doneOptionIds(property: DatabasePropertySummary | null): Set<string> {
  if (!property) return new Set()
  return new Set(
    draftsFromProperty(property)
      .filter((draft) => draft.group === "done" && draft.id)
      .map((draft) => draft.id as string),
  )
}

/** The first status property of a database: how the stories base marks a finished story. */
export function statusPropertyOf(
  properties: readonly DatabasePropertySummary[] | undefined,
): DatabasePropertySummary | null {
  return properties?.find((property) => property.propertyType === "status") ?? null
}

/** Whether the story's card row has a status in the "done" group. */
export function isStoryFinished(
  card: DatabaseRow | undefined,
  statusProperty: DatabasePropertySummary | null,
): boolean {
  if (!card || !statusProperty) return false
  const optionId = optionIdOf(card.valuesJson, statusProperty.propertyId)
  return optionId !== null && doneOptionIds(statusProperty).has(optionId)
}

export function buildStoryEntries(input: {
  stories: readonly StorySummary[]
  stats: Readonly<Record<string, StoryStat | undefined>>
  finished: (story: StorySummary) => boolean
  universeOf: (story: StorySummary) => string | null
  universeName: (universeId: string) => string | null
  favorites: ReadonlySet<string>
}): StoryEntry[] {
  return input.stories.map((story) => {
    const stat = input.stats[story.storyId]
    const universeId = input.universeOf(story)
    return {
      storyId: story.storyId,
      name: story.name,
      cardNoteId: story.cardNoteId,
      universeId,
      universeName: universeId ? input.universeName(universeId) : null,
      finished: input.finished(story),
      favorite: story.cardNoteId !== null && input.favorites.has(story.cardNoteId),
      words: stat?.words ?? 0,
      pages: stat?.pages ?? 0,
      donePages: stat?.donePages ?? null,
      lastModified: stat?.lastModified ?? null,
      created: stat?.created ?? null,
    }
  })
}

/** How far the story is, 0 to 1: finished is whole; otherwise done pages of all pages. */
export function progressOf(entry: StoryEntry): number {
  if (entry.finished) return 1
  if (entry.donePages === null || entry.pages === 0) return 0
  return Math.min(1, entry.donePages / entry.pages)
}

export function matchesFilter(entry: StoryEntry, filter: StoryFilter): boolean {
  switch (filter) {
    case "favorites":
      return entry.favorite
    case "inProgress":
      return !entry.finished
    case "finished":
      return entry.finished
    default:
      return true
  }
}

export function matchesWorld(entry: StoryEntry, world: WorldFilter): boolean {
  if (world === "all") return true
  if (world === "standalone") return entry.universeId === null
  return entry.universeId === world
}

/** How many stories each filter would show, among those the world filter lets through. */
export function filterCounts(
  entries: readonly StoryEntry[],
  world: WorldFilter = "all",
): Record<StoryFilter, number> {
  const inWorld = entries.filter((entry) => matchesWorld(entry, world))
  return {
    all: inWorld.length,
    favorites: inWorld.filter((entry) => matchesFilter(entry, "favorites")).length,
    inProgress: inWorld.filter((entry) => matchesFilter(entry, "inProgress")).length,
    finished: inWorld.filter((entry) => matchesFilter(entry, "finished")).length,
  }
}

/** Most recent first; an entry without the number comes last. */
function byNumberDesc(a: number | null, b: number | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return b - a
}

const byName = (a: StoryEntry, b: StoryEntry) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" })

/**
 * The list in the order asked for: the last change, the most words, the furthest along and the
 * newest start come first; names go A to Z. Ties fall back to the name, so the order is stable.
 */
export function sortEntries(
  entries: readonly StoryEntry[],
  sort: StorySort,
  order: StoryOrderInput = { manualOrder: [] },
): StoryEntry[] {
  if (sort === "order") return orderStoryEntries(entries, order)
  const compare = (a: StoryEntry, b: StoryEntry): number => {
    switch (sort) {
      case "name":
        return byName(a, b)
      case "words":
        return b.words - a.words
      case "progress":
        return progressOf(b) - progressOf(a)
      case "created":
        return byNumberDesc(a.created, b.created)
      default:
        return byNumberDesc(a.lastModified, b.lastModified)
    }
  }
  return [...entries].sort((a, b) => compare(a, b) || byName(a, b))
}

export function filterAndSort(
  entries: readonly StoryEntry[],
  options: { filter: StoryFilter; sort: StorySort; world?: WorldFilter; order?: StoryOrderInput },
): StoryEntry[] {
  const { filter, sort, world = "all", order } = options
  return sortEntries(
    entries.filter((entry) => matchesWorld(entry, world) && matchesFilter(entry, filter)),
    sort,
    order,
  )
}
