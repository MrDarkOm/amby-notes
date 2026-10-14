import type {
  DatabasePropertySummary,
  DatabaseRow,
  DatabaseSummary,
  ProjectCatalog,
  StorySummary,
  WorkshopSectionSummary,
  WorkshopSummary,
} from "@/lib/storage"

/** Roles that belong to workshop/story functional parts (stories, notes, anchors) and are not world tabs. */
const WORK_ROLES = new Set(["stories", "text", "notes", "anchors"])
const ROLE_ORDER = ["characters", "locations", "universes", "arcs"]

/**
 * The three parts of the works tab: the whole text as one tree (every page once, whatever its
 * level), the anchors (the key, unchanging events) and the notes.
 */
export type WorksSection = "text" | "anchors" | "notes"
export const WORKS_SECTIONS: readonly WorksSection[] = ["text", "anchors", "notes"]

/**
 * The parts that were unfolded, from what was saved.
 */
export function worksSectionsFromPrefs(saved: unknown): WorksSection[] {
  if (!Array.isArray(saved)) return ["text"]
  const open = new Set<WorksSection>()
  for (const entry of saved) {
    if (entry === "books" || entry === "arcs") open.add("text")
    else {
      const section = WORKS_SECTIONS.find((candidate) => candidate === entry)
      if (section) open.add(section)
    }
  }
  return [...open]
}

/**
 * An item being named where it will stand: a row with an empty field, created on Enter. A page
 * goes under `parentId` (the top of the text for `null`); a note or an anchor into its list;
 * a world page into the category.
 */
export type WorkshopDraft =
  | { kind: "page"; storyId: string; parentId: string | null }
  /** A note goes into a notebook (the folder names from the base's root; none is the root). */
  | { kind: "note"; notebook?: string[] }
  | { kind: "anchor"; storyId?: string }
  /** A notebook goes inside another (`[]`: the root of the base). */
  | { kind: "notebook"; parent: string[] }
  | { kind: "entity"; categoryKey: string }

export interface WorkshopTab {
  key: string
  role: string | null
  /** The ID of the section in the workshop file. */
  sectionId: string
  /** The section database's display name. */
  name: string
  databaseId: string
  readOnly: boolean
  /** The relation property that links this section's pages to stories; `null` before it is set. */
  storiesPropertyId: string | null
}

export interface WorkshopScope {
  /** The chosen workshop, or `null` if none exist. */
  workshop: WorkshopSummary | null
  /** The stories shown, in catalog order. */
  stories: StorySummary[]
  /** The sections of the workshop. */
  sections: WorkshopSectionSummary[]
}

/** Resolves the active workshop and its stories. */
export function workshopScope(
  catalog: ProjectCatalog,
  wantedWorkshopId: string | null,
): WorkshopScope {
  const workshop =
    (wantedWorkshopId !== null
      ? catalog.workshops.find((w) => w.workshopId === wantedWorkshopId)
      : null) ??
    catalog.workshops[0] ??
    null
  return {
    workshop,
    stories: workshop?.stories ?? [],
    sections: workshop?.sections ?? [],
  }
}

/** What makes a section its tab: its role, or, for an author-created section, its name. */
export function sectionTabKey(section: WorkshopSectionSummary): string {
  return section.role && section.role !== "custom"
    ? section.role
    : `name:${section.name.trim().toLocaleLowerCase()}`
}

/** The entity tabs of a workshop: one per world section. */
export function entityTabs(target: WorkshopScope | WorkshopSummary | null): WorkshopTab[] {
  const workshop = target ? ("workshop" in target ? target.workshop : target) : null
  if (!workshop) return []
  const tabs: WorkshopTab[] = []
  for (const section of workshop.sections) {
    if (section.state === "missing") continue
    if (section.role && WORK_ROLES.has(section.role)) continue
    const key = sectionTabKey(section)
    tabs.push({
      key,
      role: section.role,
      sectionId: section.id,
      name: section.name,
      databaseId: section.databaseId,
      readOnly: workshop.readOnly,
      storiesPropertyId: section.storiesPropertyId,
    })
  }
  const rank = (tab: WorkshopTab) => {
    const index = tab.role ? ROLE_ORDER.indexOf(tab.role) : -1
    return index === -1 ? ROLE_ORDER.length : index
  }
  return tabs.sort((a, b) => rank(a) - rank(b))
}

/** The story the panel shows: the one wanted when the scope holds it, else the first. */
export function selectedStoryOf(
  stories: StorySummary[],
  wanted: string | null,
): StorySummary | null {
  return stories.find((story) => story.storyId === wanted) ?? stories[0] ?? null
}

/** The workshop section for notes or anchors. */
export function storySection(
  workshop: WorkshopSummary | null,
  role: "notes" | "anchors",
): WorkshopSectionSummary | null {
  return workshop?.sections.find((s) => s.role === role && s.state !== "missing") ?? null
}

// ── Entities ────────────────────────────────────────────────────────────────────────────────────

export interface EntityItem {
  noteId: string
  title: string
  databaseId: string
  workshopId: string
  valuesJson: string
}

/** Rows of one database as the list items the panel and the pages work with. */
export function entityItemsOf(
  rows: readonly DatabaseRow[],
  databaseId: string,
  workshopId: string,
): EntityItem[] {
  return rows.map((row) => ({
    noteId: row.noteId,
    title: row.title,
    databaseId,
    workshopId,
    valuesJson: row.valuesJson,
  }))
}

/**
 * Pages in the author's order: those placed by hand first, in the order they were placed; the
 * rest in the order they were made (a page without a time last), then by title.
 */
export function orderByAuthor<T extends { noteId: string; title: string }>(
  rows: readonly T[],
  manualOrder: readonly string[],
  createdOf: (noteId: string) => number | null | undefined,
): T[] {
  const rank = new Map(manualOrder.map((id, index) => [id, index]))
  return [...rows].sort((a, b) => {
    const placedA = rank.get(a.noteId)
    const placedB = rank.get(b.noteId)
    if (placedA !== undefined && placedB !== undefined) return placedA - placedB
    if (placedA !== undefined) return -1
    if (placedB !== undefined) return 1
    const madeA = createdOf(a.noteId) ?? Number.POSITIVE_INFINITY
    const madeB = createdOf(b.noteId) ?? Number.POSITIVE_INFINITY
    if (madeA !== madeB) return madeA < madeB ? -1 : 1
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
  })
}

/** The letters a page's round face shows when it has no picture: its first two words' initials. */
export function initialsOf(title: string): string {
  const letters = title
    .split(/\s+/u)
    .map((word) => Array.from(word.replace(/^[^\p{L}\p{N}]+/u, ""))[0] ?? "")
    .filter(Boolean)
    .slice(0, 2)
    .join("")
  return letters.toLocaleUpperCase() || "?"
}

export type GroupMode = "importance" | "none"

export interface EntityGroup {
  key: string
  /** `null` for a single group that needs no heading. */
  label: string | null
  color: string | null
  items: EntityItem[]
}

function compareTitle(a: EntityItem, b: EntityItem): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
}

function parseValues(valuesJson: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(valuesJson)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The Select (or Status) a database's first grouped view is grouped by, as the preset sets it. */
export function groupPropertyOf(
  summary: DatabaseSummary | undefined,
): DatabasePropertySummary | null {
  if (!summary) return null
  for (const view of summary.views) {
    const field = view.groupField
    if (field && field.kind === "property") {
      const property = summary.properties.find((p) => p.propertyId === field.propertyId)
      if (property && (property.propertyType === "select" || property.propertyType === "status")) {
        return property
      }
    }
  }
  return null
}

export function optionIdOf(valuesJson: string, propertyId: string): string | null {
  const value = parseValues(valuesJson)[propertyId]
  if (value && typeof value === "object") {
    const optionId = (value as { optionId?: unknown }).optionId
    if (typeof optionId === "string") return optionId
  }
  return null
}

export interface GroupContext {
  /** The grouped property of an entity's database, if its views have one. */
  groupProperty: (databaseId: string) => DatabasePropertySummary | null
  sharedLabel: string
  noValueLabel: string
}

/** Entities grouped and sorted for a list. Groups of one name from different databases merge. */
export function groupEntities(
  items: EntityItem[],
  mode: GroupMode,
  context: GroupContext,
): EntityGroup[] {
  const sorted = [...items].sort(compareTitle)
  if (mode === "none" || sorted.length === 0) {
    return sorted.length ? [{ key: "all", label: null, color: null, items: sorted }] : []
  }
  const groups = new Map<string, EntityGroup & { rank: number }>()
  for (const item of sorted) {
    const property = context.groupProperty(item.databaseId)
    const optionId = property ? optionIdOf(item.valuesJson, property.propertyId) : null
    const optionIndex =
      property && optionId ? property.options.findIndex((o) => o.optionId === optionId) : -1
    const option = optionIndex >= 0 ? property!.options[optionIndex] : null
    const key = option ? `option:${option.name.toLocaleLowerCase()}` : "none"
    const group = groups.get(key) ?? {
      key,
      label: option ? option.name : context.noValueLabel,
      color: option ? option.color : null,
      items: [],
      rank: option ? optionIndex : Number.MAX_SAFE_INTEGER,
    }
    group.items.push(item)
    groups.set(key, group)
  }
  const result = [...groups.values()].sort((a, b) => a.rank - b.rank)
  if (result.length === 1 && result[0].key === "none") {
    return [{ key: "all", label: null, color: null, items: result[0].items }]
  }
  return result.map(({ rank: _rank, ...group }) => group)
}

/** Relation targets stored under one property of a row's values. */
export function relationTargetsOf(valuesJson: string, propertyId: string): string[] {
  const value = parseValues(valuesJson)[propertyId]
  if (value && typeof value === "object" && (value as { type?: unknown }).type === "relation") {
    const targets = (value as { targetNoteIds?: unknown }).targetNoteIds
    if (Array.isArray(targets)) return targets.filter((id): id is string => typeof id === "string")
  }
  return []
}

/** Relation targets stored in one row's values. */
export function relationTargets(valuesJson: string): string[] {
  const ids: string[] = []
  for (const value of Object.values(parseValues(valuesJson))) {
    if (value && typeof value === "object" && (value as { type?: unknown }).type === "relation") {
      const targets = (value as { targetNoteIds?: unknown }).targetNoteIds
      if (Array.isArray(targets)) {
        for (const id of targets) if (typeof id === "string") ids.push(id)
      }
    }
  }
  return ids
}

// ── Search ──────────────────────────────────────────────────────────────────────────────────────

export interface SearchSource {
  key: string
  label: string
  items: EntityItem[]
}

/** Pages whose title contains the query, kept under the tab they belong to; empty groups drop out. */
export function buildSearchGroups(query: string, sources: SearchSource[]): SearchSource[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  return sources
    .map((source) => ({
      ...source,
      items: source.items
        .filter((item) => item.title.toLocaleLowerCase().includes(needle))
        .sort(compareTitle),
    }))
    .filter((source) => source.items.length > 0)
}

// ── Belonging: stories and universes ───────────────────────────────────────────────────────────

/**
 * What the panel shows. A page belongs to a story when its "Stories" relation names the story's
 * card or when a relation of one of the story's own text pages points at it (the text names it);
 * it belongs to a universe through any story whose "Universe" relation is that universe.
 */
export type PanelFilter =
  { kind: "all" } | { kind: "story"; storyId: string } | { kind: "universe"; universeId: string }

/**
 * The filter the stored choices mean. A universe wins over a story; `"all"` is "the whole
 * workshop"; a story that is unknown (or none chosen yet) falls back on the first one, and a
 * workshop without stories on the whole workshop.
 */
export function resolvePanelFilter(
  stories: readonly StorySummary[],
  universeIds: readonly string[],
  storyFilter: string | null,
  universeFilter: string | null,
): PanelFilter {
  if (universeFilter !== null && universeIds.includes(universeFilter)) {
    return { kind: "universe", universeId: universeFilter }
  }
  if (storyFilter === "all") return { kind: "all" }
  const story = selectedStoryOf([...stories], storyFilter)
  return story ? { kind: "story", storyId: story.storyId } : { kind: "all" }
}

export interface Membership {
  /** The stories a page is in, in the order of the catalog. */
  storiesOf: (noteId: string) => readonly string[]
  /** The universe note a story is in, if it has one. */
  universeOf: (storyId: string) => string | null
}

interface MembershipInput {
  stories: readonly StorySummary[]
  sections: readonly WorkshopSectionSummary[]
  /** Rows by database ID: the sections, the stories section, and the text of every story whose
   * text should count (a story whose text is not loaded counts through its relations only). */
  rows: Readonly<Record<string, readonly DatabaseRow[] | undefined>>
}

/** Who belongs to which story, read from the rows the panel already holds. */
export function buildMembership({ stories, sections, rows }: MembershipInput): Membership {
  const storyIndex = new Map(stories.map((story, index) => [story.storyId, index]))
  const storyOfCard = new Map<string, string>()
  for (const story of stories) {
    if (story.cardNoteId) storyOfCard.set(story.cardNoteId, story.storyId)
  }

  const inStories = new Map<string, Set<string>>()
  const add = (noteId: string, storyId: string) => {
    const set = inStories.get(noteId) ?? new Set<string>()
    set.add(storyId)
    inStories.set(noteId, set)
  }

  // The page names the story.
  for (const section of sections) {
    if (!section.storiesPropertyId) continue
    for (const row of rows[section.databaseId] ?? []) {
      for (const target of relationTargetsOf(row.valuesJson, section.storiesPropertyId)) {
        const storyId = storyOfCard.get(target)
        if (storyId) add(row.noteId, storyId)
      }
    }
  }
  // The story's text names the page. Only this story's own pages are read.
  for (const story of stories) {
    for (const row of story.databaseId ? (rows[story.databaseId] ?? []) : []) {
      for (const target of relationTargets(row.valuesJson)) add(target, story.storyId)
    }
  }

  // The universe of a story is a relation of its card.
  const universeOfStory = new Map<string, string>()
  const storiesSection = sections.find((section) => section.role === "stories")
  if (storiesSection?.universePropertyId) {
    const cards = new Map((rows[storiesSection.databaseId] ?? []).map((row) => [row.noteId, row]))
    for (const story of stories) {
      const card = story.cardNoteId ? cards.get(story.cardNoteId) : undefined
      const universe = card
        ? relationTargetsOf(card.valuesJson, storiesSection.universePropertyId)[0]
        : undefined
      if (universe) universeOfStory.set(story.storyId, universe)
    }
  }
  // A universe is "in" the stories that belong to it.
  for (const [storyId, universeId] of universeOfStory) add(universeId, storyId)

  const sortedStories = (noteId: string): readonly string[] =>
    [...(inStories.get(noteId) ?? [])].sort(
      (a, b) => (storyIndex.get(a) ?? 0) - (storyIndex.get(b) ?? 0),
    )
  return {
    storiesOf: sortedStories,
    universeOf: (storyId) => universeOfStory.get(storyId) ?? null,
  }
}

export interface ScopedEntities<T extends EntityItem = EntityItem> {
  shown: T[]
  /** Pages in no story and named by no text: the workshop's "no story" group, only for "all". */
  withoutStory: T[]
}

/** The pages the filter lets through. */
export function scopeEntities<T extends EntityItem>(
  items: readonly T[],
  filter: PanelFilter,
  membership: Membership,
): ScopedEntities<T> {
  if (filter.kind === "all") {
    const shown: T[] = []
    const withoutStory: T[] = []
    for (const item of items) {
      ;(membership.storiesOf(item.noteId).length > 0 ? shown : withoutStory).push(item)
    }
    return { shown, withoutStory }
  }
  if (filter.kind === "story") {
    return {
      shown: items.filter((item) => membership.storiesOf(item.noteId).includes(filter.storyId)),
      withoutStory: [],
    }
  }
  return {
    shown: items.filter(
      (item) =>
        item.noteId === filter.universeId ||
        membership
          .storiesOf(item.noteId)
          .some((storyId) => membership.universeOf(storyId) === filter.universeId),
    ),
    withoutStory: [],
  }
}

export interface StoryLabels {
  names: string[]
  /** How many more stories there are than names. */
  more: number
}

/** Up to `limit` story names for a row, then how many were left out. */
export function storyLabels(
  storyIds: readonly string[],
  nameOf: (storyId: string) => string | undefined,
  limit = 2,
): StoryLabels {
  const names = storyIds
    .map(nameOf)
    .filter((name): name is string => name !== undefined && name !== "")
  return { names: names.slice(0, limit), more: Math.max(0, names.length - limit) }
}
