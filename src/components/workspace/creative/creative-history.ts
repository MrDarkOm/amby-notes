import type { TFunction } from "i18next"
import type { ProjectCatalog } from "@/lib/storage"
import type { TabTarget } from "../use-tabs-store"
import { creativeTitleLabels } from "./project-labels"
import { projectTargetTitle, resolveProjectTarget } from "./project-tree-model"

/**
 * A workshop page in a tab's history is `creative:<projectId>` (the overview) or
 * `creative:<projectId>#<sectionId>` (a section tab of it). The first shape is the one every
 * session and tab of earlier versions holds, so it reads unchanged. Project and section IDs are
 * generated tokens and never hold a `#`.
 */
const PREFIX = "creative:"
const SECTION_MARK = "#"

export interface CreativeLocation {
  projectId: string
  /** The section tab that is open; `null` is the overview. */
  sectionId: string | null
}

/** The OVERVIEW pseudo-section of `creative-nav-store` is the entry without a section. */
const OVERVIEW = "overview"

export function creativeFileId(projectId: string, sectionId?: string | null): string {
  return sectionId && sectionId !== OVERVIEW
    ? `${PREFIX}${projectId}${SECTION_MARK}${sectionId}`
    : `${PREFIX}${projectId}`
}

export function isCreativeFileId(fileId: string): boolean {
  return fileId.startsWith(PREFIX)
}

export function parseCreativeFileId(fileId: string): CreativeLocation | null {
  if (!isCreativeFileId(fileId)) return null
  const rest = fileId.slice(PREFIX.length)
  const mark = rest.indexOf(SECTION_MARK)
  const projectId = mark === -1 ? rest : rest.slice(0, mark)
  if (!projectId) return null
  const sectionId = mark === -1 ? "" : rest.slice(mark + 1)
  return { projectId, sectionId: sectionId && sectionId !== OVERVIEW ? sectionId : null }
}

/** The tab target of a workshop page: the name is the page's, section or not. */
export function creativeTabTarget(
  catalog: ProjectCatalog | null,
  t: TFunction,
  projectId: string,
  sectionId?: string | null,
): TabTarget {
  const target = resolveProjectTarget(catalog, projectId)
  return {
    kind: "creative",
    fileId: creativeFileId(projectId, sectionId),
    title: projectTargetTitle(target, creativeTitleLabels(t)),
  }
}

/** The target a history entry names, or `null` when it is not a workshop page. */
export function creativeHistoryTarget(
  fileId: string,
  catalog: ProjectCatalog | null,
  t: TFunction,
): TabTarget | null {
  const location = parseCreativeFileId(fileId)
  return location ? creativeTabTarget(catalog, t, location.projectId, location.sectionId) : null
}
