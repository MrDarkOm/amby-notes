import type {
  ProjectCatalog,
  StorySummary,
  WorkshopSectionSummary,
  WorkshopSummary,
} from "@/lib/storage"

export interface SidebarSection {
  id: string
  workshopId: string
  name: string
  role: string | null
  state: WorkshopSectionSummary["state"]
  databaseId: string
  resolvedPath: string | null
  readOnly: boolean
}

/** The blocks of the workshop page: the world's lists, the work's lists, and the author's own. */
export interface SidebarGroup {
  id: "world" | "work" | "custom"
  sections: SidebarSection[]
}

export function sectionName(section: WorkshopSectionSummary): string {
  return section.name.trim() || section.id
}

export function toSidebarSection(
  workshop: WorkshopSummary,
  section: WorkshopSectionSummary,
): SidebarSection {
  return {
    id: section.id,
    workshopId: workshop.workshopId,
    name: sectionName(section),
    role: section.role,
    state: section.state,
    databaseId: section.databaseId,
    resolvedPath: section.pathHint,
    readOnly: workshop.readOnly,
  }
}

const WORLD_ROLES = new Set(["characters", "locations", "universes", "arcs"])
const WORK_ROLES = new Set(["stories", "notes", "anchors"])

/**
 * Sections of a workshop grouped into World, Work and Custom.
 */
export function groupSections(workshop: WorkshopSummary): SidebarGroup[] {
  const worldSections: SidebarSection[] = []
  const workSections: SidebarSection[] = []
  const customSections: SidebarSection[] = []

  for (const section of workshop.sections) {
    const item = toSidebarSection(workshop, section)
    if (section.role && WORLD_ROLES.has(section.role)) {
      worldSections.push(item)
    } else if (section.role && WORK_ROLES.has(section.role)) {
      workSections.push(item)
    } else {
      customSections.push(item)
    }
  }

  const groups: SidebarGroup[] = []
  if (worldSections.length > 0) {
    groups.push({ id: "world", sections: worldSections })
  }
  if (workSections.length > 0) {
    groups.push({ id: "work", sections: workSections })
  }
  if (customSections.length > 0) {
    groups.push({ id: "custom", sections: customSections })
  }
  return groups
}

export function findWorkshop(
  catalog: ProjectCatalog | null,
  workshopId: string,
): WorkshopSummary | null {
  return catalog?.workshops.find((w) => w.workshopId === workshopId) ?? null
}

export function findStory(
  catalog: ProjectCatalog | null,
  storyId: string,
): { workshop: WorkshopSummary; story: StorySummary } | null {
  if (!catalog) return null
  for (const workshop of catalog.workshops) {
    const story = workshop.stories.find((s) => s.storyId === storyId)
    if (story) return { workshop, story }
  }
  return null
}

/**
 * Finds a workshop or story by ID.
 */
export function findProject(
  catalog: ProjectCatalog | null,
  id: string,
): WorkshopSummary | StorySummary | null {
  if (!catalog) return null
  const workshop = catalog.workshops.find((w) => w.workshopId === id)
  if (workshop) return workshop
  for (const w of catalog.workshops) {
    const story = w.stories.find((s) => s.storyId === id)
    if (story) return story
  }
  return null
}

/** The stories of a workshop. */
export function storiesOfWorkshop(workshop: WorkshopSummary): StorySummary[] {
  return workshop.stories
}

/** Prefix of the tab target of a universe: `universe:<note ID of its card>`. */
const UNIVERSE_PREFIX = "universe:"
/** Prefix of the tab target of the stories that no universe holds: `standalone:<workshop ID>`. */
const STANDALONE_PREFIX = "standalone:"

export function universeTargetId(universeId: string): string {
  return `${UNIVERSE_PREFIX}${universeId}`
}

export function standaloneTargetId(workshopId: string): string {
  return `${STANDALONE_PREFIX}${workshopId}`
}

export type ProjectTarget =
  | { kind: "workshop"; workshop: WorkshopSummary }
  | { kind: "story"; workshop: WorkshopSummary; story: StorySummary }
  | { kind: "universe"; workshop: WorkshopSummary; universeId: string }
  /** The stories that belong to no universe, with their world: a page of the workshop. */
  | { kind: "standalone"; workshop: WorkshopSummary }

/**
 * Resolves a creative target (workshop, story, universe or the standalone stories) from the
 * catalog. A target that names nothing in the catalog is `null`.
 */
export function resolveProjectTarget(
  catalog: ProjectCatalog | null,
  id: string,
): ProjectTarget | null {
  if (!catalog) return null
  const workshop = catalog.workshops.find((w) => w.workshopId === id)
  if (workshop) return { kind: "workshop", workshop }
  for (const w of catalog.workshops) {
    const story = w.stories.find((s) => s.storyId === id)
    if (story) return { kind: "story", workshop: w, story }
  }
  if (id.startsWith(STANDALONE_PREFIX)) {
    const owner = catalog.workshops.find((w) => w.workshopId === id.slice(STANDALONE_PREFIX.length))
    return owner ? { kind: "standalone", workshop: owner } : null
  }
  if (id.startsWith(UNIVERSE_PREFIX)) {
    // There is one workshop per vault; its first one is the universe's.
    const owner = catalog.workshops[0]
    return owner
      ? { kind: "universe", workshop: owner, universeId: id.slice(UNIVERSE_PREFIX.length) }
      : null
  }
  return null
}

/** The words a tab or page is named with when the catalog does not name it. */
export interface TargetLabels {
  universe: string
  standalone: string
  /** For a target the catalog does not know. */
  fallback: string
}

/**
 * The name of a page and of its tab: a story's name, the name of the universe's card (the row's
 * title, once read), the "Standalone stories" label, or the workshop's name.
 */
export function projectTargetTitle(
  target: ProjectTarget | null,
  labels: TargetLabels,
  universeTitle?: string | null,
): string {
  if (!target) return labels.fallback
  switch (target.kind) {
    case "story":
      return target.story.name
    case "universe":
      return universeTitle?.trim() || labels.universe
    case "standalone":
      return labels.standalone
    case "workshop":
      return target.workshop.name
  }
}
