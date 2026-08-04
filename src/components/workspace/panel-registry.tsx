"use client"

import * as React from "react"
import {
  Archive,
  ArrowDownUp,
  Bell,
  Bookmark,
  BookmarkCheck,
  Calendar,
  ChevronsDownUp,
  ChevronsUpDown,
  Circle,
  Clock,
  Database,
  FilePlus,
  FileText,
  FolderPlus,
  FolderTree,
  Hash,
  History,
  Info,
  HelpCircle,
  LayoutGrid,
  LayoutTemplate,
  Link as LinkIcon,
  LocateFixed,
  Network,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Tag,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { SidebarTree, type TreeItem } from "./sidebar-tree"
import { SidebarTags } from "./sidebar-tags"
import { NewItemModal } from "./new-item-modal"
import { AiPanel } from "./ai-panel"
import {
  confirmAction,
  listSnapshots,
  readFile,
  readSnapshotText,
  restoreSnapshot,
  type SnapshotEntry,
} from "@/lib/storage"
import type { NoteProperties } from "@/lib/storage"

export type Side = "left" | "right"

export type PanelId =
  "files" | "tags" | "favorites" | "databases" | "archive" | "info" | "history" | "links" | "ai"

export interface DocumentProperties {
  type: string
  status: string
  revisions: number
  backlinks: number
  created: string
  modified: string
  id: string
  frontmatter: NoteProperties
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
  properties?: DocumentProperties | null
  linkGraph?: LinkGraph
  currentDocId?: string | null
  currentDocPath?: string | null
  onSelectLink?: (id: string) => void
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

// ── Panels ──────────────────────────────────────────────────────────────

function flattenTreeItems(items: TreeItem[]): TreeItem[] {
  const result: TreeItem[] = []
  function walk(list: TreeItem[]) {
    for (const item of list) {
      result.push(item)
      if (item.children) walk(item.children)
    }
  }
  walk(items)
  return result
}

function FilesPanel(props: PanelRenderProps) {
  const { t } = useTranslation()
  const {
    treeItems,
    selectedId,
    vault,
    onSelect,
    onOpenVault,
    onRename,
    onDelete,
    onNewFile,
    onNewFolder,
    onNewCanvas,
    onAttachCanvas,
    onOpenInNewTab,
    onOpenInExplorer,
    onMoveItem,
    onSetIcon,
    triggerRenameId,
    favorites,
    onToggleFavorite,
    onAttachLayer,
    linkedLayersByDoc,
    workspaceSwitcher,
  } = props
  const [newItemModalOpen, setNewItemModalOpen] = React.useState(false)
  const [folderResetKey, setFolderResetKey] = React.useState(0)
  const [folderTargetOpen, setFolderTargetOpen] = React.useState(true)
  const [allOpen, setAllOpen] = React.useState(true)
  const [findActiveKey, setFindActiveKey] = React.useState(0)

  function handleNewButtonClick() {
    if (!vault) {
      onOpenVault()
      return
    }
    setNewItemModalOpen(true)
  }

  function handleToggleFolders() {
    const next = !allOpen
    setAllOpen(next)
    setFolderTargetOpen(next)
    setFolderResetKey((k) => k + 1)
  }

  function handleFindActive() {
    setFindActiveKey((k) => k + 1)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:bg-accent hover:text-white"
            title={t("filesPanel.create")}
            onClick={handleNewButtonClick}
          >
            <FilePlus className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:bg-accent hover:text-white"
            title={t("filesPanel.sortOrder")}
          >
            <ArrowDownUp className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:bg-accent hover:text-white"
            title={t("filesPanel.findActive")}
            onClick={handleFindActive}
          >
            <LocateFixed className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:bg-accent hover:text-white"
            title={allOpen ? t("filesPanel.collapseAll") : t("filesPanel.expandAll")}
            onClick={handleToggleFolders}
          >
            {allOpen ? (
              <ChevronsDownUp className="size-3.5" />
            ) : (
              <ChevronsUpDown className="size-3.5" />
            )}
          </Button>
        </div>
      </div>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex flex-1 min-h-0 flex-col">
            {/* SidebarTree owns its own scroll container for virtualizer access */}
            <div className="flex-1 min-h-0">
              {treeItems.length === 0 ? (
                <p className="px-4 py-3 text-[12px] text-muted-foreground">
                  {t("filesPanel.empty")}
                </p>
              ) : (
                <SidebarTree
                  items={treeItems}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onRename={onRename}
                  onDelete={onDelete}
                  onNewFile={onNewFile}
                  onNewFolder={onNewFolder}
                  onNewCanvas={onNewCanvas}
                  onAttachCanvas={onAttachCanvas}
                  onOpenInNewTab={onOpenInNewTab}
                  onOpenInExplorer={onOpenInExplorer}
                  onMoveItem={onMoveItem}
                  onSetIcon={onSetIcon}
                  triggerRenameId={triggerRenameId}
                  folderResetKey={folderResetKey}
                  folderTargetOpen={folderTargetOpen}
                  favorites={favorites}
                  onToggleFavorite={onToggleFavorite}
                  onAttachLayer={onAttachLayer}
                  linkedLayersByDoc={linkedLayersByDoc}
                  findActiveKey={findActiveKey}
                />
              )}
            </div>

            <div className="shrink-0 p-2">
              <Button
                className="w-full gap-2 bg-secondary text-secondary-foreground hover:bg-secondary/80"
                onClick={handleNewButtonClick}
              >
                <FilePlus className="size-4" />
                {t("filesPanel.create")}
              </Button>
              {workspaceSwitcher && <div className="mt-2">{workspaceSwitcher}</div>}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52 border-border bg-popover text-foreground">
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => {
              if (!vault) onOpenVault()
              else onNewFile?.(null)
            }}
          >
            <FileText className="size-3.5 text-muted-foreground" />
            {t("filesPanel.newNote")}
          </ContextMenuItem>
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => {
              if (!vault) onOpenVault()
              else onNewFolder?.(null)
            }}
          >
            <FolderPlus className="size-3.5 text-muted-foreground" />
            {t("filesPanel.newFolder")}
          </ContextMenuItem>
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => {
              if (!vault) onOpenVault()
              else onNewCanvas?.(null)
            }}
          >
            <LayoutGrid className="size-3.5 text-muted-foreground" />
            {t("filesPanel.newCanvas")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled
            className="flex items-center gap-2 text-[13px] text-muted-foreground"
          >
            <Database className="size-3.5" />
            {t("filesPanel.database")}
            <span className="ml-auto text-[10px] text-muted-foreground">
              {t("common.comingSoon")}
            </span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <NewItemModal
        open={newItemModalOpen}
        onClose={() => setNewItemModalOpen(false)}
        onCreateNote={() => onNewFile?.(null)}
        onCreateFolder={() => onNewFolder?.(null)}
        onCreateCanvas={() => onNewCanvas?.(null)}
      />
    </div>
  )
}

function TagsPanel({ treeItems, onSelect, readFile }: PanelRenderProps) {
  return <SidebarTags items={treeItems} onSelect={onSelect} readFile={readFile} />
}

function FavoritesPanel({ treeItems, favorites, onSelect, onToggleFavorite }: PanelRenderProps) {
  const { t } = useTranslation()
  const all = flattenTreeItems(treeItems)
  const favItems = all.filter((i) => i.type === "file" && favorites?.has(i.id))

  if (favItems.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center px-4">
        <Bookmark className="size-8 text-muted-foreground" />
        <p className="text-[12px] text-muted-foreground">{t("favoritesPanel.empty")}</p>
        <p className="text-[11px] text-muted-foreground">{t("favoritesPanel.emptyHint")}</p>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div className="flex flex-col gap-px p-1">
        {favItems.map((item) => (
          <div
            key={item.id}
            className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent cursor-pointer"
            onClick={() => onSelect(item.id)}
          >
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate text-[13px] text-foreground">{item.name}</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onToggleFavorite?.(item.id)
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity"
              title={t("favoritesPanel.removeBookmark")}
            >
              <BookmarkCheck className="size-3.5 text-amber-400" />
            </button>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}

function ComingSoonPanel({ labelKey }: { labelKey: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <p className="text-[12px] text-muted-foreground">{t(labelKey)}</p>
      <p className="text-[11px] text-muted-foreground">{t("common.comingSoon")}</p>
    </div>
  )
}

function PropertyRow({
  icon: Icon,
  label,
  value,
  valueClassName,
}: {
  icon: React.ElementType
  label: string
  value: React.ReactNode
  valueClassName?: string
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        <span>{label}</span>
      </div>
      <div className={cn("text-xs text-foreground", valueClassName)}>{value}</div>
    </div>
  )
}

function InfoPanel({ properties }: PanelRenderProps) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState("")
  if (!properties) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("infoPanel.noDocument")}
      </div>
    )
  }
  const frontmatter = properties.frontmatter.properties.filter((property) =>
    `${property.key} ${property.value}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("infoPanel.search")}
            className="h-7 border-border bg-card pl-7 text-xs text-foreground placeholder:text-muted-foreground"
          />
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="px-3 py-2">
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("infoPanel.properties")}
          </div>
          <div className="divide-y divide-border">
            {properties.frontmatter.parseError && (
              <div className="py-2 text-xs text-amber-300">{t("infoPanel.parseError")}</div>
            )}
            {frontmatter.map((property) => (
              <PropertyRow
                key={property.key}
                icon={property.valueKind === "checkbox" ? BookmarkCheck : Hash}
                label={property.key}
                value={
                  <span className="max-w-36 whitespace-pre-wrap break-words text-right">
                    {property.value}
                  </span>
                }
                valueClassName="text-muted-foreground"
              />
            ))}
            <PropertyRow icon={Circle} label={t("infoPanel.type")} value={properties.type} />
            <PropertyRow
              icon={Info}
              label={t("infoPanel.status")}
              value={
                <span className="rounded-full border border-border bg-accent px-2 py-0.5 text-[10px] font-medium text-foreground">
                  {properties.status}
                </span>
              }
            />
            <PropertyRow
              icon={History}
              label={t("infoPanel.revisions")}
              value={properties.revisions}
              valueClassName="text-blue-400"
            />
            <PropertyRow
              icon={LinkIcon}
              label={t("infoPanel.backlinks")}
              value={`${properties.backlinks} ${t("infoPanel.incoming")}`}
              valueClassName="text-blue-400"
            />
            <PropertyRow
              icon={Calendar}
              label={t("infoPanel.created")}
              value={properties.created}
              valueClassName="text-blue-400"
            />
            <PropertyRow icon={Clock} label={t("infoPanel.modified")} value={properties.modified} />
            <PropertyRow
              icon={Hash}
              label="ID"
              value={
                <span className="font-mono text-[10px] text-muted-foreground">{properties.id}</span>
              }
            />
          </div>
          <Button
            variant="ghost"
            className="mt-3 h-7 w-full justify-start gap-1.5 px-0 text-xs text-muted-foreground hover:text-white"
          >
            <Plus className="size-3.5" />
            {t("infoPanel.addProperty")}
          </Button>
        </div>
      </ScrollArea>
    </div>
  )
}

function HistoryPanel({ currentDocPath, onHistoryRestored }: PanelRenderProps) {
  const { t } = useTranslation()
  const [snapshots, setSnapshots] = React.useState<SnapshotEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [restoringId, setRestoringId] = React.useState<string | null>(null)
  const [trash, setTrash] = React.useState<import("@/lib/storage").TrashEntry[]>([])
  const [comparison, setComparison] = React.useState<{
    id: string
    previous: string
    current: string
  } | null>(null)

  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      setSnapshots(currentDocPath ? await listSnapshots(currentDocPath) : [])
      const { listTrash } = await import("@/lib/storage")
      setTrash(await listTrash())
    } finally {
      setLoading(false)
    }
  }, [currentDocPath])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  async function restore(entry: SnapshotEntry) {
    if (!(await confirmAction(t("historyPanel.restoreConfirm")))) return
    setRestoringId(entry.id)
    try {
      await restoreSnapshot(entry.id)
      await onHistoryRestored?.()
      await refresh()
    } finally {
      setRestoringId(null)
    }
  }

  async function compare(entry: SnapshotEntry) {
    if (!currentDocPath) return
    const [snapshot, current] = await Promise.all([
      readSnapshotText(entry.id),
      readFile(currentDocPath),
    ])
    setComparison({ id: entry.id, previous: snapshot.content, current })
  }

  async function restoreTrashEntry(entry: import("@/lib/storage").TrashEntry) {
    if (!(await confirmAction(t("historyPanel.restoreTrashConfirm", { name: entry.name })))) return
    setRestoringId(entry.id)
    try {
      const { restoreTrash } = await import("@/lib/storage")
      await restoreTrash(entry.id)
      await onHistoryRestored?.()
      await refresh()
    } finally {
      setRestoringId(null)
    }
  }

  if (!currentDocPath && trash.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
        <History className="size-8 text-muted-foreground" />
        <p className="text-[12px] text-muted-foreground">{t("historyPanel.openNote")}</p>
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">{t("panels.history")}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void refresh()}
          disabled={loading}
          title={t("historyPanel.refresh")}
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {snapshots.length === 0 && !loading ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            {t("historyPanel.empty")}
          </p>
        ) : (
          <div className="divide-y">
            {snapshots.map((entry) => (
              <div key={entry.id} className="space-y-1.5 px-3 py-3">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span>{new Date(entry.createdAtMs).toLocaleString()}</span>
                  <span className="text-muted-foreground">
                    {Math.max(1, Math.ceil(entry.sizeBytes / 1024))} KB
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] text-muted-foreground">{entry.reason}</span>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => void compare(entry)}>
                      {t("historyPanel.compare")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void restore(entry)}
                      disabled={restoringId !== null}
                    >
                      {restoringId === entry.id
                        ? t("historyPanel.restoring")
                        : t("historyPanel.restore")}
                    </Button>
                  </div>
                </div>
                {comparison?.id === entry.id && (
                  <div className="grid max-h-72 grid-cols-2 gap-2 overflow-auto rounded border bg-muted/30 p-2 text-[10px] leading-relaxed">
                    <div>
                      <p className="mb-1 font-medium text-muted-foreground">
                        {t("historyPanel.version")}
                      </p>
                      <pre className="whitespace-pre-wrap break-words">{comparison.previous}</pre>
                    </div>
                    <div>
                      <p className="mb-1 font-medium text-muted-foreground">
                        {t("historyPanel.current")}
                      </p>
                      <pre className="whitespace-pre-wrap break-words">{comparison.current}</pre>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {trash.length > 0 && (
          <div className="border-t">
            <p className="px-3 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("historyPanel.trash")}
            </p>
            {trash.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between gap-2 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-xs">{entry.name}</p>
                  <p className="truncate text-[10px] text-muted-foreground">{entry.originalPath}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void restoreTrashEntry(entry)}
                  disabled={restoringId !== null}
                >
                  {restoringId === entry.id
                    ? t("historyPanel.restoring")
                    : t("historyPanel.return")}
                </Button>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

function LinksPanel({ linkGraph, currentDocId, onSelectLink }: PanelRenderProps) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState("")
  const nodes = linkGraph?.nodes ?? []
  const edges = linkGraph?.edges ?? []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const q = query.trim().toLocaleLowerCase()
  const outgoing = currentDocId ? edges.filter((e) => e.source === currentDocId) : []
  const backlinks = currentDocId ? edges.filter((e) => e.target === currentDocId) : []
  const allLinks = edges.filter((edge) => {
    if (!q) return true
    const from = nodeById.get(edge.source)?.label ?? edge.source
    const to = nodeById.get(edge.target)?.label ?? edge.label
    return `${from} ${to} ${edge.label}`.toLocaleLowerCase().includes(q)
  })

  function LinkRow({ edge, direction }: { edge: LinkGraphEdge; direction: "out" | "in" | "all" }) {
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    const clickableId = direction === "in" ? edge.source : edge.target
    const clickableNode = nodeById.get(clickableId)
    return (
      <button
        disabled={!clickableNode || clickableNode.unresolved}
        onClick={() =>
          clickableNode && !clickableNode.unresolved && onSelectLink?.(clickableNode.id)
        }
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
      >
        <LinkIcon
          className={cn(
            "size-3.5 shrink-0",
            edge.unresolved ? "text-muted-foreground" : "text-primary",
          )}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "truncate text-[12px]",
              edge.unresolved ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {direction === "all"
              ? `${source?.label ?? edge.source} → ${target?.label ?? edge.label}`
              : (clickableNode?.label ?? edge.label)}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {edge.unresolved
              ? t("linksPanel.unresolved")
              : direction === "in"
                ? t("linksPanel.backlink")
                : t("linksPanel.wikiLink")}
          </p>
        </div>
      </button>
    )
  }

  function Section({
    title,
    list,
    direction,
  }: {
    title: string
    list: LinkGraphEdge[]
    direction: "out" | "in" | "all"
  }) {
    return (
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between px-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {title}
          </p>
          <span className="text-[10px] text-muted-foreground">{list.length}</span>
        </div>
        {list.length ? (
          list.map((edge, i) => (
            <LinkRow
              key={`${edge.source}-${edge.target}-${direction}-${i}`}
              edge={edge}
              direction={direction}
            />
          ))
        ) : (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">{t("graph.noLinks")}</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("linksPanel.search")}
            className="h-7 border-border bg-card pl-7 text-xs text-foreground placeholder:text-muted-foreground"
          />
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="px-1 py-2">
          <Section title={t("linksPanel.outgoing")} list={outgoing} direction="out" />
          <Section title={t("linksPanel.backlinks")} list={backlinks} direction="in" />
          <Section title={t("linksPanel.all")} list={allLinks} direction="all" />
        </div>
      </ScrollArea>
    </div>
  )
}

// ── Registries ──────────────────────────────────────────────────────────

export const PANEL_DEFS: PanelDef[] = [
  {
    id: "files",
    labelKey: "panels.files",
    icon: FolderTree,
    kind: "view",
    render: (p) => <FilesPanel {...p} />,
  },
  {
    id: "tags",
    labelKey: "panels.tags",
    icon: Tag,
    kind: "view",
    render: (p) => <TagsPanel {...p} />,
  },
  {
    id: "favorites",
    labelKey: "panels.favorites",
    icon: Bookmark,
    kind: "view",
    render: (p) => <FavoritesPanel {...p} />,
  },
  {
    id: "databases",
    labelKey: "panels.databases",
    icon: Database,
    kind: "view",
    render: () => <ComingSoonPanel labelKey="panels.databases" />,
  },
  {
    id: "archive",
    labelKey: "panels.archive",
    icon: Archive,
    kind: "view",
    render: () => <ComingSoonPanel labelKey="panels.archive" />,
  },
  {
    id: "info",
    labelKey: "panels.info",
    icon: Info,
    kind: "view",
    render: (p) => <InfoPanel {...p} />,
  },
  {
    id: "history",
    labelKey: "panels.history",
    icon: History,
    kind: "view",
    render: (p) => <HistoryPanel {...p} />,
  },
  {
    id: "links",
    labelKey: "panels.links",
    icon: LinkIcon,
    kind: "view",
    render: (p) => <LinksPanel {...p} />,
  },
  {
    id: "ai",
    labelKey: "panels.ai",
    icon: Sparkles,
    kind: "view",
    render: (p) => <AiPanel {...p} />,
  },
]

export const ACTION_DEFS: ActionDef[] = [
  {
    id: "search",
    labelKey: "actions.search",
    icon: Search,
    kind: "action",
    invoke: (ctx) => ctx.openSearch(),
  },
  {
    id: "refresh",
    labelKey: "actions.refresh",
    icon: RefreshCw,
    kind: "action",
    persistent: true,
    invoke: (ctx) => ctx.refreshVault(),
  },
  {
    id: "network",
    labelKey: "actions.network",
    icon: Network,
    kind: "action",
    invoke: (ctx) => ctx.openGraphTab(),
  },
  {
    id: "notifications",
    labelKey: "actions.notifications",
    icon: Bell,
    kind: "action",
    persistent: true,
    invoke: () => {},
  },
  {
    id: "presets",
    labelKey: "actions.presets",
    icon: LayoutTemplate,
    kind: "action",
    persistent: true,
    invoke: () => {},
  },
  {
    id: "settings",
    labelKey: "actions.settings",
    icon: Settings,
    kind: "action",
    persistent: true,
    invoke: (ctx) => ctx.openSettings(),
  },
  {
    id: "help",
    labelKey: "actions.help",
    icon: HelpCircle,
    kind: "action",
    persistent: true,
    invoke: () => {},
  },
]

export function findButtonDef(defId: string): ButtonDef | undefined {
  return PANEL_DEFS.find((d) => d.id === defId) ?? ACTION_DEFS.find((d) => d.id === defId)
}

export const PERSISTENT_ACTION_BUTTONS: ActivityButton[] = [
  { defId: "refresh", side: "left", order: 1 },
  { defId: "presets", side: "left", order: 3 },
  { defId: "settings", side: "left", order: 4 },
  { defId: "notifications", side: "right", order: 0 },
  { defId: "help", side: "right", order: 1 },
]

export const DEFAULT_BUTTONS: ActivityButton[] = [
  { defId: "files", side: "left", order: 0 },
  { defId: "tags", side: "left", order: 1 },
  { defId: "favorites", side: "left", order: 2 },
  { defId: "databases", side: "left", order: 3 },
  { defId: "archive", side: "left", order: 4 },
  { defId: "search", side: "left", order: 0 },
  { defId: "network", side: "left", order: 2 },
  { defId: "info", side: "right", order: 0 },
  { defId: "history", side: "right", order: 1 },
  { defId: "links", side: "right", order: 2 },
  { defId: "ai", side: "right", order: 3 },
  ...PERSISTENT_ACTION_BUTTONS,
]

export function buttonsForSide(buttons: ActivityButton[], side: Side): ActivityButton[] {
  const seen = new Set<string>()
  return buttons
    .filter((button) => {
      if (button.side !== side || seen.has(button.defId)) return false
      seen.add(button.defId)
      return true
    })
    .slice()
    .sort((a, b) => a.order - b.order)
}

/** Returns the first view-button on a side, or null if none. */
export function firstViewOnSide(buttons: ActivityButton[], side: Side): PanelId | null {
  for (const b of buttonsForSide(buttons, side)) {
    const def = findButtonDef(b.defId)
    if (def?.kind === "view") return def.id
  }
  return null
}
