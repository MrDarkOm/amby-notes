import * as React from "react"
import type { CustomProperty, NoteProperties, TreeItem } from "@/lib/storage"

export type Side = "left" | "right"

export type PanelId =
  "files" | "tags" | "favorites" | "databases" | "archive" | "info" | "history" | "links" | "ai"

export interface DocumentProperties {
  kind?: "document"
  type: string
  backlinks: number
  created: string
  modified: string
  id: string
  frontmatter: NoteProperties
  nestedNotes: Array<{ id: string; name: string; icon?: string }>
}

export interface FolderProperties {
  kind: "folder"
  type: string
  id: string
  path: string
  noteCount: number
  folderCount: number
  nestedNotes: Array<{ id: string; name: string; icon?: string }>
}

export interface LinkGraphNode {
  id: string
  label: string
  unresolved?: boolean
}

export interface LinkGraphEdge {
  source: string
  target: string
  label: string
  unresolved?: boolean
}

export interface LinkGraph {
  nodes: LinkGraphNode[]
  edges: LinkGraphEdge[]
}

/** Everything any panel might need. Plumbed from Workspace through PanelHost. */
export interface PanelRenderProps {
  // Tree / files
  treeItems: TreeItem[]
  selectedId: string | null
  vault: string | null
  onSelect: (id: string) => void
  onOpenVault: () => void
  onRename?: (id: string, newName: string) => void
  onDelete?: (id: string) => void
  onNewFile?: (parentId: string | null) => void
  onNewFolder?: (parentId: string | null) => void
  onNewCanvas?: (parentId: string | null) => void
  onAttachCanvas?: (id: string) => void
  onOpenInNewTab?: (id: string) => void
  onOpenInNewWindow?: (id: string) => void
  onCloneFile?: (id: string) => void
  onOpenInExplorer?: (id: string) => void
  onMoveItem?: (sourceId: string, targetFolderId: string | null) => void
  onSetIcon?: (id: string, icon: string) => void
  triggerRenameId?: string | null
  readFile?: (path: string) => Promise<string>

  // Favorites
  favorites?: Set<string>
  onToggleFavorite?: (id: string) => void

  // Layer attachment from tree
  onAttachLayer?: (id: string, layer: "canvas" | "database") => void
  linkedLayersByDoc?: Record<string, { canvas: boolean; database: boolean; sketch: boolean }>

  // Right side
  properties?: DocumentProperties | FolderProperties | null
  linkGraph?: LinkGraph
  currentDocId?: string | null
  currentDocPath?: string | null
  onSelectLink?: (id: string) => void
  onUpsertCustomProperty?: (property: CustomProperty) => Promise<CustomProperty>
  onDeleteCustomProperty?: (propertyId: string) => Promise<void>
  onHistoryRestored?: () => Promise<void>
  workspaceSwitcher?: React.ReactNode
}

/** Action button context — what actions can invoke. */
export interface ActionContext {
  openGraphTab: () => void
  refreshVault: () => void
  openSearch: () => void
  openSettings: () => void
}

export interface PanelDef {
  id: PanelId
  labelKey: string
  icon: React.ComponentType<{ className?: string }>
  kind: "view"
  render: (props: PanelRenderProps) => React.ReactNode
}

export interface ActionDef {
  id: string
  labelKey: string
  icon: React.ComponentType<{ className?: string }>
  kind: "action"
  /** Always available, even when a minimal preset disables optional modules. */
  persistent?: boolean
  invoke: (ctx: ActionContext) => void
}

export type ButtonDef = PanelDef | ActionDef

export interface ActivityButton {
  defId: string // PanelId for view, action id for action
  side: Side
  order: number
}

// Re-export panel implementations from panels/
export {
  FilesPanel,
  TagsPanel,
  FavoritesPanel,
  ComingSoonPanel,
  InfoPanel,
  PropertyEditor,
  HistoryPanel,
  LinksPanel,
} from "./panels"
