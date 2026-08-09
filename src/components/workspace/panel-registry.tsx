"use client"

import * as React from "react"
import {
  ArrowDownUp,
  Bookmark,
  BookmarkCheck,
  Braces,
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock,
  Copy,
  Database,
  FileCode2,
  FilePlus,
  FileText,
  FolderPlus,
  Hash,
  History,
  LayoutGrid,
  Link as LinkIcon,
  List as ListIcon,
  LocateFixed,
  RefreshCw,
  Search,
  ToggleLeft,
  Type as TypeIcon,
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
import {
  confirmAction,
  listTrash,
  listSnapshots,
  readFile,
  readSnapshotText,
  restoreTrash,
  restoreSnapshot,
  type SnapshotEntry,
  type TrashEntry,
} from "@/lib/storage"
import type { NoteProperties } from "@/lib/storage"

export type Side = "left" | "right"

export type PanelId =
  "files" | "tags" | "favorites" | "databases" | "archive" | "info" | "history" | "links" | "ai"

export interface DocumentProperties {
  type: string
  backlinks: number
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

export function FilesPanel(props: PanelRenderProps) {
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

export function TagsPanel({ treeItems, onSelect, readFile, vault }: PanelRenderProps) {
  return <SidebarTags items={treeItems} onSelect={onSelect} readFile={readFile} vault={vault} />
}

export function FavoritesPanel({
  treeItems,
  favorites,
  onSelect,
  onToggleFavorite,
}: PanelRenderProps) {
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

export function ComingSoonPanel({ labelKey }: { labelKey: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <p className="text-[12px] text-muted-foreground">{t(labelKey)}</p>
      <p className="text-[11px] text-muted-foreground">{t("common.comingSoon")}</p>
    </div>
  )
}

function PropertyTypeIcon({ kind }: { kind: string }) {
  const Icon =
    kind === "checkbox"
      ? ToggleLeft
      : kind === "list"
        ? ListIcon
        : kind === "object"
          ? Braces
          : kind === "number"
            ? Hash
            : TypeIcon

  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent/70 text-muted-foreground">
      <Icon className="size-3.5" />
    </span>
  )
}

function PropertyValue({ kind, value }: { kind: string; value: string }) {
  if (kind === "checkbox") {
    const enabled = value.trim().toLowerCase() === "true"
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
          enabled ? "bg-emerald-500/10 text-emerald-400" : "bg-accent text-muted-foreground",
        )}
      >
        {enabled && <Check className="size-3" />}
        {enabled ? "True" : "False"}
      </span>
    )
  }

  if (kind === "list") {
    const items = value
      .split("\n")
      .map((item) => item.replace(/^\s*-\s*/, "").trim())
      .filter(Boolean)
    if (items.length > 0 && items.every((item) => !item.includes(":"))) {
      return (
        <div className="flex flex-wrap justify-end gap-1">
          {items.map((item, index) => (
            <span
              key={`${item}-${index}`}
              className="max-w-full truncate rounded-md bg-accent px-1.5 py-0.5 text-[10px] text-foreground"
            >
              {item}
            </span>
          ))}
        </div>
      )
    }
  }

  if (kind === "null") return <span className="text-muted-foreground">—</span>

  return (
    <span
      className={cn(
        "whitespace-pre-wrap break-words text-right text-xs text-foreground",
        (kind === "object" || kind === "unknown") && "font-mono text-[10px] leading-relaxed",
        kind === "number" && "tabular-nums text-blue-400",
      )}
    >
      {value}
    </span>
  )
}

function PropertyRow({ property }: { property: NoteProperties["properties"][number] }) {
  return (
    <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-2 px-2.5 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <PropertyTypeIcon kind={property.valueKind} />
        <span className="truncate text-xs text-muted-foreground" title={property.key}>
          {property.key}
        </span>
      </div>
      <div className="flex min-w-0 items-center justify-end">
        <PropertyValue kind={property.valueKind} value={property.value} />
      </div>
    </div>
  )
}

export function InfoPanel({ properties }: PanelRenderProps) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState("")
  const [technicalOpen, setTechnicalOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  if (!properties) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("infoPanel.noDocument")}
      </div>
    )
  }

  const customProperties = properties.frontmatter.properties.filter(
    (property) => !["id", "amby-kind"].includes(property.key.trim().toLowerCase()),
  )
  const visibleProperties = customProperties.filter((property) =>
    `${property.key} ${property.value}`.toLowerCase().includes(query.trim().toLowerCase()),
  )

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard access can be unavailable in browser previews.
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-medium text-foreground">{t("infoPanel.properties")}</h2>
            <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
              {t("infoPanel.description")}
            </p>
          </div>
          <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {customProperties.length}
          </span>
        </div>
        {customProperties.length >= 4 && (
          <div className="relative mt-3">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("infoPanel.search")}
              className="h-7 border-border bg-background/50 pl-7 text-xs text-foreground placeholder:text-muted-foreground"
            />
          </div>
        )}
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-5 px-3 py-3">
          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("infoPanel.custom")}
            </div>
            {properties.frontmatter.parseError ? (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-amber-300">
                {t("infoPanel.parseError")}
              </div>
            ) : visibleProperties.length > 0 ? (
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background/30">
                {visibleProperties.map((property) => (
                  <PropertyRow key={property.key} property={property} />
                ))}
              </div>
            ) : query ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-[11px] text-muted-foreground">
                {t("infoPanel.noMatches")}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center">
                <Braces className="mx-auto size-4 text-muted-foreground" />
                <p className="mt-2 text-xs text-foreground">{t("infoPanel.noCustom")}</p>
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                  {t("infoPanel.noCustomHint")}
                </p>
              </div>
            )}
          </section>

          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("infoPanel.overview")}
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-background/30">
              <div className="grid grid-cols-2 divide-x divide-border border-b border-border">
                <div className="px-3 py-2.5">
                  <FileCode2 className="mb-1.5 size-3.5 text-muted-foreground" />
                  <div className="text-[10px] text-muted-foreground">{t("infoPanel.type")}</div>
                  <div className="mt-0.5 text-xs text-foreground">{properties.type}</div>
                </div>
                <div className="px-3 py-2.5">
                  <LinkIcon className="mb-1.5 size-3.5 text-muted-foreground" />
                  <div className="text-[10px] text-muted-foreground">
                    {t("infoPanel.backlinks")}
                  </div>
                  <div className="mt-0.5 text-xs tabular-nums text-blue-400">
                    {properties.backlinks}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2.5 px-3 py-2.5">
                <Clock className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] text-muted-foreground">{t("infoPanel.modified")}</div>
                  <div className="truncate text-xs text-foreground">
                    {properties.modified || "—"}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border border-border bg-background/30">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2.5 text-left"
              aria-expanded={technicalOpen}
              onClick={() => setTechnicalOpen((open) => !open)}
            >
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {t("infoPanel.technical")}
              </span>
              <ChevronDown
                className={cn(
                  "size-3.5 text-muted-foreground transition-transform",
                  technicalOpen && "rotate-180",
                )}
              />
            </button>
            {technicalOpen && (
              <div className="border-t border-border px-3 py-2.5">
                <div className="text-[10px] text-muted-foreground">ID</div>
                <div className="mt-1 flex items-start gap-2">
                  <code className="min-w-0 flex-1 break-all font-mono text-[10px] leading-relaxed text-foreground">
                    {properties.id}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyId(properties.id)}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title={t("infoPanel.copyId")}
                  >
                    {copied ? (
                      <Check className="size-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </button>
                </div>
                {copied && (
                  <div className="mt-1 text-[10px] text-emerald-400">{t("infoPanel.copied")}</div>
                )}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}

export function HistoryPanel({ currentDocPath, onHistoryRestored }: PanelRenderProps) {
  const { t } = useTranslation()
  const [snapshots, setSnapshots] = React.useState<SnapshotEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [restoringId, setRestoringId] = React.useState<string | null>(null)
  const [trash, setTrash] = React.useState<TrashEntry[]>([])
  const [comparison, setComparison] = React.useState<{
    id: string
    previous: string
    current: string
  } | null>(null)

  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      setSnapshots(currentDocPath ? await listSnapshots(currentDocPath) : [])
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

  async function restoreTrashEntry(entry: TrashEntry) {
    if (!(await confirmAction(t("historyPanel.restoreTrashConfirm", { name: entry.name })))) return
    setRestoringId(entry.id)
    try {
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

export function LinksPanel({ linkGraph, currentDocId, onSelectLink }: PanelRenderProps) {
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
