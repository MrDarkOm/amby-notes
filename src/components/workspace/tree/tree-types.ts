import type * as React from "react"
import type { TreeItem } from "@/lib/storage"
import type { TreeReorderPosition } from "../tree-sort"

export type { TreeItem }

export type AttachableLayer = "canvas" | "database" | "sketch"

export interface NodeLayers {
  canvas: boolean
  database: boolean
  sketch: boolean
}

export const KNOWN_ICONS = new Set([
  "folder",
  "file",
  "supernote",
  "page",
  "workspace",
  "canvas",
  "draft",
  "brain",
])

export const ROOT_DROP_TARGET = "__amby_root__"

export interface PtrDrag {
  sourceId: string
  sourceIds: string[]
  sourceName: string
  sourcePath: string
  startX: number
  startY: number
  ghostX: number
  ghostY: number
  active: boolean
  targetId: string | null
  /** Reorder preview: before/after a sibling or append at the root. */
  dropPosition: TreeReorderPosition | null
}

function normalizeTreePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

function pathName(path: string): string {
  return path.split("/").pop() ?? ""
}

function pathParent(path: string): string {
  const index = path.lastIndexOf("/")
  return index === -1 ? "" : path.slice(0, index)
}

function isBundleMainPath(path: string): boolean {
  const name = pathName(path)
  return name.endsWith(".md") && pathName(pathParent(path)) === name.slice(0, -3)
}

/** Reject self-drops and folder drops into their own descendant paths. */
export function isValidTreeDropTarget(
  sourceId: string,
  sourcePath: string,
  targetId: string,
  targetPath: string,
): boolean {
  if (!sourcePath || !targetPath || sourceId === targetId) return false
  const source = normalizeTreePath(sourcePath)
  const target = normalizeTreePath(targetPath)
  if (target === source) return false

  // A bundle main note visually represents its containing directory. A child
  // (or the bundle itself) cannot be dropped onto that main note because the
  // filesystem destination would be the same container.
  const sourceRoot = isBundleMainPath(source) ? pathParent(source) : source
  const targetIsBundleMain = isBundleMainPath(target)
  const targetRoot = targetIsBundleMain ? pathParent(target) : target
  return (
    !target.startsWith(`${sourceRoot}/`) &&
    !(targetIsBundleMain && (sourceRoot === targetRoot || sourceRoot.startsWith(`${targetRoot}/`)))
  )
}

export interface SidebarTreeProps {
  items: TreeItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRename?: (id: string, newName: string) => void
  onDelete?: (id: string, mode?: "archive") => void
  onDeleteMany?: (ids: string[]) => void
  onNewFile?: (parentId: string | null) => void
  onAttachCanvas?: (id: string) => void
  onOpenInNewTab?: (id: string) => void
  onOpenInNewWindow?: (id: string) => void
  onCloneFile?: (id: string) => void
  onOpenInExplorer?: (id: string) => void
  onMoveItem?: (sourceIds: string[], targetId: string | null) => void
  onReorderItems?: (
    sourceIds: string[],
    targetId: string | null,
    position: TreeReorderPosition,
  ) => void
  onSetIcon?: (id: string, icon: string) => void
  onContextMenuSelect?: (id: string) => void
  triggerRenameId?: string | null
  favorites?: Set<string>
  onToggleFavorite?: (id: string) => void
  onAttachLayer?: (id: string, layer: AttachableLayer) => void
  canCreateDatabaseLayer?: boolean
  linkedLayersByDoc?: Record<string, NodeLayers>
  /** Increment to scroll the currently selected item into view. */
  findActiveKey?: number
}

export type FlatRow = { item: TreeItem; level: number; branchIndex: number | null }

export function treeItemHasChildren(item: TreeItem): boolean {
  return Boolean(item.children?.length)
}

export function treeBranchGradientColor(branchIndex: number, branchCount: number): string {
  const endWeight =
    branchCount <= 1 ? 0 : Math.min(100, Math.max(0, (branchIndex / (branchCount - 1)) * 100))
  return `color-mix(in oklch, var(--tree-gradient-start) ${100 - endWeight}%, var(--tree-gradient-end) ${endWeight}%)`
}

export function flattenVisible(
  items: TreeItem[],
  closedIds: Set<string>,
  level = 0,
  inheritedBranchIndex: number | null = null,
): FlatRow[] {
  const rows: FlatRow[] = []
  let nextRootBranchIndex = 0
  for (const item of items) {
    const hasChildren = treeItemHasChildren(item)
    const isRootBranch = item.type === "folder" || hasChildren
    const branchIndex =
      level === 0 ? (isRootBranch ? nextRootBranchIndex++ : null) : inheritedBranchIndex
    rows.push({ item, level, branchIndex })
    if (hasChildren && !closedIds.has(item.id) && item.children?.length) {
      for (const child of flattenVisible(item.children, closedIds, level + 1, branchIndex)) {
        rows.push(child)
      }
    }
  }
  return rows
}

export interface TreeNodeProps {
  item: TreeItem
  level: number
  isOpen: boolean
  onToggleOpen: (id: string) => void
  isEditing: boolean
  onStartEdit: (id: string) => void
  onFinishEdit: (id: string, newName: string | null) => void
  selectedIds: ReadonlySet<string>
  isKeyboardFocused: boolean
  onKeyboardFocus: (id: string) => void
  onSelect: (id: string, event?: React.MouseEvent<HTMLElement>) => void
  onDelete?: (id: string, mode?: "archive") => void
  onDeleteMany?: (ids: string[]) => void
  onNewFile?: (parentId: string | null) => void
  onAttachCanvas?: (id: string) => void
  onOpenInNewTab?: (id: string) => void
  onOpenInNewWindow?: (id: string) => void
  onCloneFile?: (id: string) => void
  onOpenInExplorer?: (id: string) => void
  onSetIcon?: (id: string, icon: string) => void
  onContextMenuSelect?: (id: string) => void
  onPtrDragStart: (id: string, name: string, path: string, x: number, y: number) => void
  isPtrDragSource: boolean
  isPtrDragTarget: boolean
  favorites?: Set<string>
  onToggleFavorite?: (id: string) => void
  onAttachLayer?: (id: string, layer: AttachableLayer) => void
  canCreateDatabaseLayer?: boolean
  linkedLayersByDoc?: Record<string, NodeLayers>
}
