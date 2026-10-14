import type { ProjectCatalog, WorkshopSectionSummary, WorkshopSummary } from "@/lib/storage"
import { makeIconValue } from "../icon-values"
import type { TreeItem } from "../tree/tree-types"

/** The icon takes the colour of its tree row, so it follows the theme like the built-in ones. */
const CREATIVE_ICON_COLOR = "currentColor"

const ROLE_ICON_NAMES: Record<string, string> = {
  text: "file-text",
  notes: "sticky-note",
  characters: "users",
  locations: "map-pin",
  stories: "book-open",
  universes: "earth",
  arcs: "git-branch",
  anchors: "anchor",
}

interface CreativeFolderInfo {
  icon: string | null
  fallbackIconName: string
}

interface CreativeIndex {
  /** Folders by vault-relative path with forward slashes: workshops and stories. */
  folders: Map<string, CreativeFolderInfo>
  /** Section databases by database ID. */
  sections: Map<string, WorkshopSectionSummary>
}

function buildIndex(catalog: ProjectCatalog): CreativeIndex {
  const folders = new Map<string, CreativeFolderInfo>()
  const sections = new Map<string, WorkshopSectionSummary>()

  for (const workshop of catalog.workshops) {
    if (workshop.path) {
      folders.set(workshop.path, {
        icon: workshop.icon ?? null,
        fallbackIconName: "feather",
      })
    }
    for (const section of workshop.sections) {
      if (section.state !== "missing") {
        sections.set(section.databaseId, section)
      }
    }
    for (const story of workshop.stories) {
      if (story.folderPath) {
        folders.set(story.folderPath, {
          icon: null,
          fallbackIconName: "book-open",
        })
      }
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
    const folderInfo = relative === null ? undefined : index.folders.get(relative)
    if (folderInfo) {
      const own = folderInfo.icon ?? makeIconValue(folderInfo.fallbackIconName, CREATIVE_ICON_COLOR)
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
 * The file tree as the file panel shows it: creative folders and section databases
 * get an icon that says what they are.
 */
export function applyCreativeTree(
  items: TreeItem[],
  catalog: ProjectCatalog | null,
  vault: string | null,
  showInTree: boolean,
): TreeItem[] {
  if (!catalog || !vault || catalog.workshops.length === 0) return items
  return walk(items, buildIndex(catalog), vault, showInTree)
}

/**
 * The workshop whose folder a tree item is, if any.
 */
export function collectionForFolder(
  item: TreeItem,
  catalog: ProjectCatalog | null,
  vault: string | null,
): WorkshopSummary | null {
  if (item.type !== "folder" || !catalog || !vault) return null
  const relative = relativeTo(vault, item.path)
  if (relative === null || relative === "") return null
  return catalog.workshops.find((workshop) => workshop.path === relative) ?? null
}
