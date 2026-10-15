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

export interface SidebarGroup {
  id: string | null
  name: string | null
  sections: SidebarSection[]
}

export function sectionName(section: WorkshopSectionSummary): string {
  return section.name.trim() || section.id
}

function toSidebarSection(
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
    groups.push({ id: "world", name: "Мир", sections: worldSections })
  }
  if (workSections.length > 0) {
    groups.push({ id: "work", name: "Произведение", sections: workSections })
  }
  if (customSections.length > 0) {
    groups.push({ id: "custom", name: null, sections: customSections })
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

export type ProjectTarget =
  | { kind: "workshop"; workshop: WorkshopSummary }
  | { kind: "story"; workshop: WorkshopSummary; story: StorySummary }
  | { kind: "universe"; workshop: WorkshopSummary; universeId: string }

/**
 * Resolves a creative target (workshop, story, or universe) from catalog.
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
    if (id.startsWith("universe:")) {
      return { kind: "universe", workshop: w, universeId: id.slice("universe:".length) }
    }
  }
  return null
}
