import type {
  DatabaseSummary,
  DatabasePropertySummary,
  ProjectCatalog,
  ProjectSectionSummary,
  ProjectSummary,
} from "@/lib/storage"

/** Roles that belong to a story's work (text, notes, anchors) and are not entity tabs. */
const WORK_ROLES = new Set(["text", "notes", "anchors"])
const ROLE_ORDER = ["characters", "locations"]

/**
 * The three parts of the works tab: the whole text as one tree (every page once, whatever its
 * level), the anchors (the key, unchanging events) and the notes.
 */
export type WorksSection = "text" | "anchors" | "notes"
export const WORKS_SECTIONS: readonly WorksSection[] = ["text", "anchors", "notes"]

/**
 * The parts that were unfolded, from what was saved. The text used to be two parts, "books" and
 * "arcs"; either of them is the text now, so an author who had them open keeps it open. Nothing
 * saved: the text is unfolded.
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
 * goes under `parentId` (the top of the text for `null`); a note or an anchor into its list of the
 * story; a world page into the category.
 */
export type WorkshopDraft =
  | { kind: "page"; storyId: string; parentId: string | null }
  | { kind: "note" | "anchor"; storyId: string }
  | { kind: "entity"; categoryKey: string }

export interface WorkshopSource {
  project: ProjectSummary
  section: ProjectSectionSummary
}

export interface WorkshopTab {
  key: string
  role: string | null
  /** The database's own name of the first source. */
  name: string
  sources: WorkshopSource[]
}

export interface WorkshopScope {
  /** The chosen collection, or `null` for the stand-alone stories. */
  collection: ProjectSummary | null
  /** The stories shown, in catalog order. */
  stories: ProjectSummary[]
}

/** The projects a scope holds: a collection with its stories, or the stand-alone stories. */
export function workshopScope(catalog: ProjectCatalog, scope: string | null): WorkshopScope {
  if (scope !== null) {
    const collection =
      catalog.projects.find((p) => p.projectId === scope && p.kind === "collection") ?? null
    return {
      collection,
      stories: catalog.projects.filter((p) => p.kind === "story" && p.collectionId === scope),
    }
  }
  const ids = new Set(catalog.projects.map((p) => p.projectId))
  return {
    collection: null,
    stories: catalog.projects.filter(
      (p) => p.kind === "story" && (p.collectionId === null || !ids.has(p.collectionId)),
    ),
  }
}

function sectionName(section: ProjectSectionSummary): string {
  return section.databaseName?.trim() || section.pathHint.split("/").pop() || section.id
}

/**
 * What makes sections one tab: their role, or, for a section the author made, its name. A
 * universe's "Organizations" and a story's "Organizations" are the same tab.
 */
export function sectionTabKey(section: ProjectSectionSummary): string {
  return section.role ?? `name:${sectionName(section).toLocaleLowerCase()}`
}

/** The entity tabs of a scope: one per role or name across the collection and its stories. */
export function entityTabs(scope: WorkshopScope): WorkshopTab[] {
  const tabs = new Map<string, WorkshopTab>()
  const projects = [...(scope.collection ? [scope.collection] : []), ...scope.stories]
  for (const project of projects) {
    for (const section of project.sections) {
      if (section.state === "missing") continue
      if (section.role && WORK_ROLES.has(section.role)) continue
      const key = sectionTabKey(section)
      const tab = tabs.get(key) ?? {
        key,
        role: section.role,
        name: sectionName(section),
        sources: [],
      }
      tab.sources.push({ project, section })
      tabs.set(key, tab)
    }
  }
  const rank = (tab: WorkshopTab) => {
    const index = tab.role ? ROLE_ORDER.indexOf(tab.role) : -1
    return index === -1 ? ROLE_ORDER.length : index
  }
  // `sort` is stable, so tabs of equal rank keep the order they were found in.
  return [...tabs.values()].sort((a, b) => rank(a) - rank(b))
}

/** The story the panel shows: the one wanted when the scope holds it, else the first. */
export function selectedStoryOf(
  stories: ProjectSummary[],
  wanted: string | null,
): ProjectSummary | null {
  return stories.find((story) => story.projectId === wanted) ?? stories[0] ?? null
}

/** What the world lists: this story's pages, or everything of the collection and its stories. */
export type WorldScope = "story" | "universe"

/** The sections of one kind in one story: its text, or its notes. */
export function storySection(
  story: ProjectSummary,
  role: "text" | "notes" | "anchors",
): ProjectSectionSummary | null {
  return story.sections.find((s) => s.role === role && s.state !== "missing") ?? null
}

// ── Entities ────────────────────────────────────────────────────────────────────────────────────

export interface EntityItem {
  noteId: string
  title: string
  databaseId: string
  /** The project whose folder holds the page: a collection (shared) or a story. */
  projectId: string
  valuesJson: string
}

/** Relation targets of every row of a story's text, by story ID: who appears in which story. */
export type TextReferences = ReadonlyMap<string, ReadonlySet<string>>

/** The stories an entity belongs to: the one it lives in, and those whose text names it. */
export function storiesOfEntity(
  item: EntityItem,
  stories: ProjectSummary[],
  references: TextReferences,
): ProjectSummary[] {
  return stories.filter(
    (story) =>
      story.projectId === item.projectId || references.get(story.projectId)?.has(item.noteId),
  )
}

/** Whether an entity shows with a story filter: it lives in the story or its text names it. */
export function inStory(item: EntityItem, storyId: string, references: TextReferences): boolean {
  return item.projectId === storyId || Boolean(references.get(storyId)?.has(item.noteId))
}

/**
 * Whether a page of the shared world is still in no story's text: it lives in the collection, and
 * no story's relations name it. A page just made there is such a page, so the story's list shows
 * it (apart, as "not in the text yet") instead of letting it vanish until some chapter names it.
 */
export function isUnplaced(
  item: EntityItem,
  sharedProjectId: string | null,
  references: TextReferences,
): boolean {
  if (!sharedProjectId || item.projectId !== sharedProjectId) return false
  for (const targets of references.values()) if (targets.has(item.noteId)) return false
  return true
}

/**
 * Pages in the author's order: those placed by hand first, in the order they were placed; the
 * rest in the order they were made (a page without a time last), then by title. For anchors,
 * which are events: an alphabetical list would tear them out of the story's order.
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

export type GroupMode = "importance" | "story" | "none"

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
  projectName: (projectId: string) => string
  /** Names the collection's own pages when grouping by story. */
  sharedLabel: string
  noValueLabel: string
  /** The project order of the scope, shared first. */
  projectOrder: string[]
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
  if (mode === "story") {
    const groups = new Map<string, EntityGroup>()
    for (const item of sorted) {
      const group = groups.get(item.projectId) ?? {
        key: item.projectId,
        label: context.projectName(item.projectId) || context.sharedLabel,
        color: null,
        items: [],
      }
      group.items.push(item)
      groups.set(item.projectId, group)
    }
    const order = (key: string) => {
      const index = context.projectOrder.indexOf(key)
      return index === -1 ? context.projectOrder.length : index
    }
    return [...groups.values()].sort((a, b) => order(a.key) - order(b.key))
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
  // A list nobody grouped (no importance set anywhere) needs no heading.
  if (result.length === 1 && result[0].key === "none") {
    return [{ key: "all", label: null, color: null, items: result[0].items }]
  }
  return result.map(({ rank: _rank, ...group }) => group)
}

/** Relation targets stored in one row's values, for the text-references set of a story. */
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

/** The tab a new page goes to by default: the filtered story's section, else the shared one. */
export function defaultSource(
  tab: WorkshopTab,
  storyFilter: string | null,
  collectionId: string | null,
): WorkshopSource | null {
  return (
    (storyFilter ? tab.sources.find((s) => s.project.projectId === storyFilter) : undefined) ??
    tab.sources.find((s) => s.project.projectId === collectionId) ??
    tab.sources[0] ??
    null
  )
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
