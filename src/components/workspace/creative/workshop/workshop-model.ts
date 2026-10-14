import type {
  DatabasePropertySummary,
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
  | { kind: "note" | "anchor"; storyId?: string }
  | { kind: "entity"; categoryKey: string }

export interface WorkshopTab {
  key: string
  role: string | null
  /** The section database's display name. */
  name: string
  databaseId: string
  readOnly: boolean
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
      name: section.name,
      databaseId: section.databaseId,
      readOnly: workshop.readOnly,
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
