import type { ProjectCatalog, ProjectSectionSummary, ProjectSummary } from "@/lib/storage"
import { makeIconValue } from "../icon-values"
import type { TreeItem } from "../tree/tree-types"

/** The icon takes the colour of its tree row, so it follows the theme like the built-in ones. */
const CREATIVE_ICON_COLOR = "currentColor"

const ROLE_ICON_NAMES: Record<string, string> = {
  text: "file-text",
  notes: "sticky-note",
  characters: "users",
  locations: "map-pin",
}

/** What a project folder shows when its structure file names no icon of its own. */
export function projectIconName(project: ProjectSummary): string {
  if (project.kind === "story") return "book-open"
  // A collection with its own world sections is a universe.
  return project.sections.length > 0 ? "earth" : "layers"
}

interface CreativeIndex {
  /** Project folders by vault-relative path with forward slashes. */
  folders: Map<string, ProjectSummary>
  /** Section databases by database ID. */
  sections: Map<string, ProjectSectionSummary>
}

function buildIndex(catalog: ProjectCatalog): CreativeIndex {
  const folders = new Map<string, ProjectSummary>()
  const sections = new Map<string, ProjectSectionSummary>()
  for (const project of catalog.projects) {
    // A project at the vault root is the whole vault: there is no folder to mark or hide.
    if (project.path) folders.set(project.path, project)
    for (const section of project.sections) {
      if (section.state !== "missing") sections.set(section.databaseId, section)
    }
  }
  return { folders, sections }
}

function relativeTo(vault: string, path: string): string | null {
  const root = vault.replace(/\\/gu, "/").replace(/\/+$/u, "")
  const normalized = path.replace(/\\/gu, "/")
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : null
}

function decorate(item: TreeItem, index: CreativeIndex, vault: string): TreeItem {
  if (item.type === "folder") {
    const relative = relativeTo(vault, item.path)
    const project = relative === null ? undefined : index.folders.get(relative)
    if (project) {
      const own = project.icon ?? makeIconValue(projectIconName(project), CREATIVE_ICON_COLOR)
      // A folder the author gave an icon of their own keeps it; the glyph at the end of the
      // row still says what the folder is.
      const custom = Boolean(item.icon) && item.icon !== "folder"
      return { ...item, icon: custom ? item.icon : own, statusIcon: own }
    }
  } else if (item.type === "database") {
    const section = index.sections.get(item.id)
    const iconName = section?.role ? ROLE_ICON_NAMES[section.role] : undefined
    if (iconName && (!item.icon || item.icon === "database")) {
      return { ...item, icon: makeIconValue(iconName, CREATIVE_ICON_COLOR) }
    }
  }
  return item
}

function isCreative(item: TreeItem, index: CreativeIndex, vault: string): boolean {
  if (item.type === "folder") {
    const relative = relativeTo(vault, item.path)
    return relative !== null && index.folders.has(relative)
  }
  return item.type === "database" && index.sections.has(item.id)
}

function walk(
  items: TreeItem[],
  index: CreativeIndex,
  vault: string,
  showInTree: boolean,
): TreeItem[] {
  let changed = false
  const next: TreeItem[] = []
  for (const item of items) {
    if (!showInTree && isCreative(item, index, vault)) {
      changed = true
      continue
    }
    const decorated = showInTree ? decorate(item, index, vault) : item
    const children = decorated.children
      ? walk(decorated.children, index, vault, showInTree)
      : undefined
    if (decorated === item && children === item.children) {
      next.push(item)
    } else {
      changed = true
      next.push(children === decorated.children ? decorated : { ...decorated, children })
    }
  }
  return changed ? next : items
}

/**
 * The file tree as the file panel shows it: creative project folders and section databases
 * get an icon that says what they are, or, with `showInTree` off, are left out together with
 * everything inside them. It is a view only; nothing is renamed, moved or written, and the
 * same array comes back when there is nothing to change.
 */
export function applyCreativeTree(
  items: TreeItem[],
  catalog: ProjectCatalog | null,
  vault: string | null,
  showInTree: boolean,
): TreeItem[] {
  if (!catalog || !vault || catalog.projects.length === 0) return items
  return walk(items, buildIndex(catalog), vault, showInTree)
}

/**
 * The collection (a universe, or a plain collection) whose folder a tree item is, if any.
 * Only the module's own view of the catalog decides: a story's folder or an ordinary folder
 * is not one.
 */
export function collectionForFolder(
  item: TreeItem,
  catalog: ProjectCatalog | null,
  vault: string | null,
): ProjectSummary | null {
  if (item.type !== "folder" || !catalog || !vault) return null
  const relative = relativeTo(vault, item.path)
  if (relative === null || relative === "") return null
  return (
    catalog.projects.find(
      (project) => project.kind === "collection" && project.path === relative,
    ) ?? null
  )
}
