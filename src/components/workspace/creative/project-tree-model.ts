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

/** A project no other project in the catalog contains: a collection or a stand-alone story. */
function topLevelProjects(catalog: ProjectCatalog): ProjectSummary[] {
  const ids = new Set(catalog.projects.map((project) => project.projectId))
  return catalog.projects.filter(
    (project) => project.collectionId === null || !ids.has(project.collectionId),
  )
}

/**
 * A scope is the one part of the catalog the sidebar shows: a top-level collection
 * (by its project ID) or the bucket of stand-alone stories (`STANDALONE_SCOPE`).
 */
export const STANDALONE_SCOPE = null

/** The top-level collections, in catalog order: the choices of the scope switcher. */
export function listScopes(catalog: ProjectCatalog): ProjectSummary[] {
  return topLevelProjects(catalog).filter((project) => project.kind === "collection")
}

/**
 * The scope to show for a wanted one. The stand-alone bucket the author chose (`null`) and a
 * wanted collection that still exists are kept. With no choice yet (`undefined`) or a
 * collection that is gone, the first collection is shown, or the bucket when there is none.
 */
export function resolveScope(
  catalog: ProjectCatalog,
  wanted: string | null | undefined,
): string | null {
  if (wanted === STANDALONE_SCOPE) return STANDALONE_SCOPE
  const scopes = listScopes(catalog)
  if (scopes.some((scope) => scope.projectId === wanted)) return wanted ?? STANDALONE_SCOPE
  return scopes[0]?.projectId ?? STANDALONE_SCOPE
}

/** The collection a new section or story can go into: none for a read-only collection. */
export function writableCollection(scope: ProjectSummary | null): ProjectSummary | null {
  return scope && scope.kind === "collection" && !scope.readOnly ? scope : null
}

export function findProject(catalog: ProjectCatalog | null, projectId: string) {
  return catalog?.projects.find((project) => project.projectId === projectId) ?? null
}

/** Project IDs, in tree order, so an overview can list the stories of a collection. */
export function storiesOfCollection(catalog: ProjectCatalog, collectionId: string) {
  return catalog.projects.filter((project) => project.collectionId === collectionId)
}
