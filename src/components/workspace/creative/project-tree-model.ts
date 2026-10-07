import type { ProjectCatalog, ProjectSectionSummary, ProjectSummary } from "@/lib/storage"

export interface SidebarSection {
  id: string
  projectId: string
  /** The database's own name when it was found, else the folder name from the file. */
  name: string
  role: string | null
  state: ProjectSectionSummary["state"]
  databaseId: string
  resolvedPath: string | null
}

export interface SidebarGroup {
  /** `null` for sections that belong to no declared group. */
  id: string | null
  name: string | null
  sections: SidebarSection[]
}

export interface SidebarProject {
  project: ProjectSummary
  groups: SidebarGroup[]
  /** The stories of a collection, by folder nesting. */
  stories: SidebarProject[]
}

export function sectionName(section: ProjectSectionSummary): string {
  return section.databaseName?.trim() || section.pathHint.split("/").pop() || section.id
}

function toSidebarSection(project: ProjectSummary, section: ProjectSectionSummary): SidebarSection {
  return {
    id: section.id,
    projectId: project.projectId,
    name: sectionName(section),
    role: section.role,
    state: section.state,
    databaseId: section.databaseId,
    resolvedPath: section.resolvedPath,
  }
}

/** Sections in file order, gathered under the groups the file declares, in the file's group order. */
export function groupSections(project: ProjectSummary): SidebarGroup[] {
  const groups: SidebarGroup[] = project.groups.map((group) => ({
    id: group.id,
    name: group.name,
    sections: [],
  }))
  const loose: SidebarGroup = { id: null, name: null, sections: [] }
  for (const section of project.sections) {
    const target =
      groups.find((group) => section.groupId !== null && group.id === section.groupId) ?? loose
    target.sections.push(toSidebarSection(project, section))
  }
  return [...groups, loose].filter((group) => group.sections.length > 0)
}

function toSidebarProject(project: ProjectSummary, stories: SidebarProject[]): SidebarProject {
  return { project, groups: groupSections(project), stories }
}

/**
 * Collections and stand-alone stories at the top, the stories of a collection
 * beneath it. The Rust catalog already decided membership by folder nesting.
 */
export function buildProjectTree(catalog: ProjectCatalog): SidebarProject[] {
  const ids = new Set(catalog.projects.map((project) => project.projectId))
  const storiesOf = (collectionId: string) =>
    catalog.projects
      .filter((project) => project.collectionId === collectionId)
      .map((project) => toSidebarProject(project, []))
  return catalog.projects
    .filter((project) => project.collectionId === null || !ids.has(project.collectionId))
    .map((project) =>
      toSidebarProject(project, project.kind === "collection" ? storiesOf(project.projectId) : []),
    )
}

export function findProject(catalog: ProjectCatalog | null, projectId: string) {
  return catalog?.projects.find((project) => project.projectId === projectId) ?? null
}

/** Project IDs, in tree order, so an overview can list the stories of a collection. */
export function storiesOfCollection(catalog: ProjectCatalog, collectionId: string) {
  return catalog.projects.filter((project) => project.collectionId === collectionId)
}
