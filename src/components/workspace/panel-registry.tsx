"use client"

import * as React from "react"
import {
  Archive,
  ArrowDownUp,
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
  Link as LinkIcon,
  LocateFixed,
  Network,
  Plus,
  RefreshCw,
  Search,
  Tag,
} from "lucide-react"

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
import { SidebarSearch } from "./sidebar-search"
import { SidebarTags } from "./sidebar-tags"
import { NewItemModal } from "./new-item-modal"

export type Side = "left" | "right"

export type PanelId =
  | "files"
  | "search"
  | "tags"
  | "favorites"
  | "databases"
  | "archive"
  | "info"
  | "history"
  | "links"

export interface DocumentProperties {
  type: string
  status: string
  revisions: number
  backlinks: number
  created: string
  modified: string
  id: string
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
  onSelectLink?: (id: string) => void
}

/** Action button context — what actions can invoke. */
export interface ActionContext {
  openGraphTab: () => void
  refreshVault: () => void
}

export interface PanelDef {
  id: PanelId
  label: string
  icon: React.ComponentType<{ className?: string }>
  kind: "view"
  render: (props: PanelRenderProps) => React.ReactNode
}

export interface ActionDef {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  kind: "action"
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
  const {
    treeItems, selectedId, vault, onSelect, onOpenVault,
    onRename, onDelete, onNewFile, onNewFolder,
    onOpenInNewTab, onOpenInExplorer, onMoveItem, onSetIcon,
    triggerRenameId, favorites, onToggleFavorite, onAttachLayer, linkedLayersByDoc,
  } = props
  const [newItemModalOpen, setNewItemModalOpen] = React.useState(false)
  const [folderResetKey, setFolderResetKey] = React.useState(0)
  const [folderTargetOpen, setFolderTargetOpen] = React.useState(true)
  const [allOpen, setAllOpen] = React.useState(true)

  function handleNewButtonClick() {
    if (!vault) { onOpenVault(); return }
    setNewItemModalOpen(true)
  }

  function handleToggleFolders() {
    const next = !allOpen
    setAllOpen(next)
    setFolderTargetOpen(next)
    setFolderResetKey(k => k + 1)
  }

  function handleFindActive() {
    document
      .querySelector<HTMLElement>('[data-tree-selected="true"]')
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex h-9 shrink-0 items-center border-b border-zinc-800 px-1 gap-px">
        <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white" title="Создать заметку"
          onClick={() => { if (!vault) onOpenVault(); else onNewFile?.(null) }}>
          <FilePlus className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white" title="Создать папку"
          onClick={() => { if (!vault) onOpenVault(); else onNewFolder?.(null) }}>
          <FolderPlus className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white" title="Порядок сортировки">
          <ArrowDownUp className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white" title="Найти активный файл"
          onClick={handleFindActive}>
          <LocateFixed className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white"
          title={allOpen ? "Свернуть все папки" : "Развернуть все папки"}
          onClick={handleToggleFolders}>
          {allOpen ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
        </Button>
      </div>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex flex-1 min-h-0 flex-col">
            <ScrollArea className="flex-1 min-h-0">
              <div className="p-1.5">
                {treeItems.length === 0 ? (
                  <p className="px-2 py-3 text-[12px] text-zinc-600">
                    Нет файлов. Создай новый.
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
                  />
                )}
              </div>
            </ScrollArea>

            <div className="shrink-0 p-2">
              <Button
                className="w-full gap-2 bg-zinc-100 text-zinc-900 hover:bg-white"
                onClick={handleNewButtonClick}
              >
                <FilePlus className="size-4" />
                Создать
              </Button>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52 border-zinc-800 bg-black text-zinc-300">
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white"
            onSelect={() => { if (!vault) onOpenVault(); else onNewFile?.(null) }}
          >
            <FileText className="size-3.5 text-zinc-500" />
            Новая заметка
          </ContextMenuItem>
          <ContextMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white"
            onSelect={() => { if (!vault) onOpenVault(); else onNewFolder?.(null) }}
          >
            <FolderPlus className="size-3.5 text-zinc-500" />
            Новая папка
          </ContextMenuItem>
          <ContextMenuItem disabled className="flex items-center gap-2 text-[13px] text-zinc-600">
            <Database className="size-3.5" />
            База данных
            <span className="ml-auto text-[10px] text-zinc-700">Скоро</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <NewItemModal
        open={newItemModalOpen}
        onClose={() => setNewItemModalOpen(false)}
        onCreateNote={() => onNewFile?.(null)}
      />
    </div>
  )
}

function SearchPanel({ treeItems, onSelect, readFile }: PanelRenderProps) {
  return <SidebarSearch items={treeItems} onSelect={onSelect} readFile={readFile} />
}

function TagsPanel({ treeItems, onSelect, readFile }: PanelRenderProps) {
  return <SidebarTags items={treeItems} onSelect={onSelect} readFile={readFile} />
}

function FavoritesPanel({ treeItems, favorites, onSelect, onToggleFavorite }: PanelRenderProps) {
  const all = flattenTreeItems(treeItems)
  const favItems = all.filter(i => i.type === "file" && favorites?.has(i.id))

  if (favItems.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center px-4">
        <Bookmark className="size-8 text-zinc-700" />
        <p className="text-[12px] text-zinc-600">Нет избранных заметок</p>
        <p className="text-[11px] text-zinc-700">Нажмите правой кнопкой на заметку и выберите «Добавить в избранное»</p>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div className="flex flex-col gap-px p-1">
        {favItems.map(item => (
          <div
            key={item.id}
            className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-zinc-800 cursor-pointer"
            onClick={() => onSelect(item.id)}
          >
            <FileText className="size-3.5 shrink-0 text-zinc-500" />
            <span className="flex-1 truncate text-[13px] text-zinc-300">{item.name}</span>
            <button
              onClick={e => { e.stopPropagation(); onToggleFavorite?.(item.id) }}
              className="opacity-0 group-hover:opacity-100 transition-opacity"
              title="Убрать из избранного"
            >
              <BookmarkCheck className="size-3.5 text-amber-400" />
            </button>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}

function ComingSoonPanel({ label }: { label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <p className="text-[12px] text-zinc-600">{label}</p>
      <p className="text-[11px] text-zinc-700">Скоро</p>
    </div>
  )
}

function PropertyRow({
  icon: Icon, label, value, valueClassName,
}: {
  icon: React.ElementType
  label: string
  value: React.ReactNode
  valueClassName?: string
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <Icon className="size-3.5" />
        <span>{label}</span>
      </div>
      <div className={cn("text-xs text-zinc-300", valueClassName)}>{value}</div>
    </div>
  )
}

function InfoPanel({ properties }: PanelRenderProps) {
  const [query, setQuery] = React.useState("")
  if (!properties) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-500">
        No document selected
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-zinc-800 p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search properties"
            className="h-7 border-zinc-800 bg-zinc-900 pl-7 text-xs text-zinc-300 placeholder:text-zinc-600"
          />
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="px-3 py-2">
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Properties
          </div>
          <div className="divide-y divide-zinc-800">
            <PropertyRow icon={Circle} label="Type" value={properties.type} />
            <PropertyRow
              icon={Info}
              label="Status"
              value={
                <span className="rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-300">
                  {properties.status}
                </span>
              }
            />
            <PropertyRow icon={History} label="Revisions" value={properties.revisions} valueClassName="text-blue-400" />
            <PropertyRow icon={LinkIcon} label="Backlinks" value={`${properties.backlinks} incoming`} valueClassName="text-blue-400" />
            <PropertyRow icon={Calendar} label="Created" value={properties.created} valueClassName="text-blue-400" />
            <PropertyRow icon={Clock} label="Modified" value={properties.modified} />
            <PropertyRow
              icon={Hash}
              label="ID"
              value={<span className="font-mono text-[10px] text-zinc-500">{properties.id}</span>}
            />
          </div>
          <Button
            variant="ghost"
            className="mt-3 h-7 w-full justify-start gap-1.5 px-0 text-xs text-zinc-500 hover:text-white"
          >
            <Plus className="size-3.5" />
            Add a property
          </Button>
        </div>
      </ScrollArea>
    </div>
  )
}

function HistoryPanel() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      <History className="size-8 text-zinc-700" />
      <p className="text-[12px] text-zinc-600">История изменений скоро</p>
    </div>
  )
}

function LinksPanel({ linkGraph, currentDocId, onSelectLink }: PanelRenderProps) {
  const [query, setQuery] = React.useState("")
  const nodes = linkGraph?.nodes ?? []
  const edges = linkGraph?.edges ?? []
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const q = query.trim().toLocaleLowerCase()
  const outgoing = currentDocId ? edges.filter(e => e.source === currentDocId) : []
  const backlinks = currentDocId ? edges.filter(e => e.target === currentDocId) : []
  const allLinks = edges.filter(edge => {
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
        onClick={() => clickableNode && !clickableNode.unresolved && onSelectLink?.(clickableNode.id)}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-zinc-800 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <LinkIcon className={cn("size-3.5 shrink-0", edge.unresolved ? "text-zinc-700" : "text-sky-400")} />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-[12px]", edge.unresolved ? "text-zinc-600" : "text-zinc-300")}>
            {direction === "all" ? `${source?.label ?? edge.source} → ${target?.label ?? edge.label}` : clickableNode?.label ?? edge.label}
          </p>
          <p className="truncate text-[10px] text-zinc-600">
            {edge.unresolved ? "unresolved" : direction === "in" ? "backlink" : "wiki link"}
          </p>
        </div>
      </button>
    )
  }

  function Section({ title, list, direction }: { title: string; list: LinkGraphEdge[]; direction: "out" | "in" | "all" }) {
    return (
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between px-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">{title}</p>
          <span className="text-[10px] text-zinc-700">{list.length}</span>
        </div>
        {list.length ? list.map((edge, i) => (
          <LinkRow key={`${edge.source}-${edge.target}-${direction}-${i}`} edge={edge} direction={direction} />
        )) : (
          <p className="px-2 py-1 text-[11px] text-zinc-700">Нет ссылок</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-zinc-800 p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search links"
            className="h-7 border-zinc-800 bg-zinc-900 pl-7 text-xs text-zinc-300 placeholder:text-zinc-600"
          />
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="px-1 py-2">
          <Section title="Outgoing" list={outgoing} direction="out" />
          <Section title="Backlinks" list={backlinks} direction="in" />
          <Section title="All vault links" list={allLinks} direction="all" />
        </div>
      </ScrollArea>
    </div>
  )
}

// ── Registries ──────────────────────────────────────────────────────────

export const PANEL_DEFS: PanelDef[] = [
  { id: "files",     label: "Древо",       icon: FolderTree, kind: "view", render: p => <FilesPanel {...p} /> },
  { id: "search",    label: "Поиск",       icon: Search,     kind: "view", render: p => <SearchPanel {...p} /> },
  { id: "tags",      label: "Теги",        icon: Tag,        kind: "view", render: p => <TagsPanel {...p} /> },
  { id: "favorites", label: "Избранное",   icon: Bookmark,   kind: "view", render: p => <FavoritesPanel {...p} /> },
  { id: "databases", label: "Базы данных", icon: Database,   kind: "view", render: () => <ComingSoonPanel label="Базы данных" /> },
  { id: "archive",   label: "Архив",       icon: Archive,    kind: "view", render: () => <ComingSoonPanel label="Архив" /> },
  { id: "info",      label: "Info",        icon: Info,       kind: "view", render: p => <InfoPanel {...p} /> },
  { id: "history",   label: "History",     icon: History,    kind: "view", render: () => <HistoryPanel /> },
  { id: "links",     label: "Links",       icon: LinkIcon,   kind: "view", render: p => <LinksPanel {...p} /> },
]

export const ACTION_DEFS: ActionDef[] = [
  { id: "refresh", label: "Синхронизация", icon: RefreshCw, kind: "action", invoke: ctx => ctx.refreshVault() },
  { id: "network", label: "Граф связей",   icon: Network,   kind: "action", invoke: ctx => ctx.openGraphTab() },
]

export function findButtonDef(defId: string): ButtonDef | undefined {
  return (
    PANEL_DEFS.find(d => d.id === defId) ??
    ACTION_DEFS.find(d => d.id === defId)
  )
}

export const DEFAULT_BUTTONS: ActivityButton[] = [
  { defId: "files",     side: "left",  order: 0 },
  { defId: "search",    side: "left",  order: 1 },
  { defId: "tags",      side: "left",  order: 2 },
  { defId: "favorites", side: "left",  order: 3 },
  { defId: "databases", side: "left",  order: 4 },
  { defId: "archive",   side: "left",  order: 5 },
  { defId: "refresh",   side: "left",  order: 6 },
  { defId: "network",   side: "left",  order: 7 },
  { defId: "info",      side: "right", order: 0 },
  { defId: "history",   side: "right", order: 1 },
  { defId: "links",     side: "right", order: 2 },
]

const BUTTONS_KEY = "amby:panel-buttons:v1"
const ACTIVE_KEY = "amby:active-views:v1"

export function loadButtons(): ActivityButton[] | null {
  try {
    const raw = localStorage.getItem(BUTTONS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ActivityButton[]
    if (!Array.isArray(parsed)) return null
    return parsed.filter(b => findButtonDef(b.defId))
  } catch {
    return null
  }
}

export function saveButtons(buttons: ActivityButton[]) {
  try {
    localStorage.setItem(BUTTONS_KEY, JSON.stringify(buttons))
  } catch { /* localStorage unavailable */ }
}

export function loadActiveBySide(): Record<Side, PanelId | null> | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    return { left: parsed.left ?? null, right: parsed.right ?? null }
  } catch {
    return null
  }
}

export function saveActiveBySide(active: Record<Side, PanelId | null>) {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(active))
  } catch { /* localStorage unavailable */ }
}

export function buttonsForSide(buttons: ActivityButton[], side: Side): ActivityButton[] {
  return buttons
    .filter(b => b.side === side)
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
