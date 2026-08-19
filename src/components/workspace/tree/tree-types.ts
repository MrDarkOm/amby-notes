import type { TreeItem } from "@/lib/storage"

export type { TreeItem }

export type AttachableLayer = "canvas" | "database"

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
  sourceName: string
  startX: number
  startY: number
  ghostX: number
  ghostY: number
  active: boolean
  targetId: string | null
}

export interface SidebarTreeProps {
  items: TreeItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRename?: (id: string, newName: string) => void
  onDelete?: (id: string) => void
  onNewFile?: (parentId: string | null) => void
  onAttachCanvas?: (id: string) => void
  onOpenInNewTab?: (id: string) => void
  onOpenInNewWindow?: (id: string) => void
  onCloneFile?: (id: string) => void
  onOpenInExplorer?: (id: string) => void
  onMoveItem?: (sourceId: string, targetId: string | null) => void
  onSetIcon?: (id: string, icon: string) => void
  triggerRenameId?: string | null
  folderResetKey?: number
  folderTargetOpen?: boolean
  favorites?: Set<string>
  onToggleFavorite?: (id: string) => void
  onAttachLayer?: (id: string, layer: AttachableLayer) => void
  linkedLayersByDoc?: Record<string, NodeLayers>
  /** Increment to scroll the currently selected item into view. */
  findActiveKey?: number
}

export type FlatRow = { item: TreeItem; level: number }

export function flattenVisible(items: TreeItem[], closedIds: Set<string>, level = 0): FlatRow[] {
  const rows: FlatRow[] = []
  for (const item of items) {
    rows.push({ item, level })
    const hasChildren = (item.children && item.children.length > 0) || item.type === "folder"
    if (hasChildren && !closedIds.has(item.id) && item.children?.length) {
      for (const child of flattenVisible(item.children, closedIds, level + 1)) {
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
  onToggleOpen: () => void
  isEditing: boolean
  onStartEdit: () => void
  onFinishEdit: (newName: string | null) => void
  selectedId: string | null
  isKeyboardFocused: boolean
  onKeyboardFocus: (id: string) => void
  onSelect: (id: string) => void
  onDelete?: (id: string) => void
  onNewFile?: (parentId: string | null) => void
  onAttachCanvas?: (id: string) => void
  onOpenInNewTab?: (id: string) => void
  onOpenInNewWindow?: (id: string) => void
  onCloneFile?: (id: string) => void
  onOpenInExplorer?: (id: string) => void
  onSetIcon?: (id: string, icon: string) => void
  onPtrDragStart: (id: string, name: string, path: string, x: number, y: number) => void
  ptrDragSourceId: string | null
  ptrDragTargetId: string | null
  favorites?: Set<string>
  onToggleFavorite?: (id: string) => void
  onAttachLayer?: (id: string, layer: AttachableLayer) => void
  linkedLayersByDoc?: Record<string, NodeLayers>
}
