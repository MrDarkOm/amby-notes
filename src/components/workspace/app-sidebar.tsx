"use client"

import * as React from "react"
import {
  Archive,
  ArrowDownUp,
  Bell,
  Bookmark,
  BookmarkCheck,
  ChevronsDownUp,
  ChevronsUpDown,
  Database,
  FileText,
  FilePlus,
  FolderPlus,
  FolderTree,
  HelpCircle,
  LocateFixed,
  Network,
  RefreshCw,
  Search,
  Settings,
  Tag,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
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

type SidebarView = "files" | "search" | "tags" | "favorites" | "databases" | "archive" | "graph"

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

interface LinkGraphNode {
  id: string
  label: string
  unresolved?: boolean
}

interface LinkGraphEdge {
  source: string
  target: string
  label: string
  unresolved?: boolean
}

interface LinkGraph {
  nodes: LinkGraphNode[]
  edges: LinkGraphEdge[]
}

function FavoritesView({
  treeItems, favorites, onSelect, onToggleFavorite,
}: {
  treeItems: TreeItem[]
  favorites: Set<string>
  onSelect: (id: string) => void
  onToggleFavorite?: (id: string) => void
}) {
  const all = flattenTreeItems(treeItems)
  const favItems = all.filter(i => i.type === "file" && favorites.has(i.id))

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

function LinkGraphView({
  graph, selectedId, onSelect,
}: {
  graph?: LinkGraph
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const nodes = graph?.nodes ?? []
  const edges = graph?.edges ?? []
  const positions = React.useMemo(() => {
    const map = new Map<string, { x: number; y: number }>()
    const cx = 160
    const cy = 150
    const radius = Math.max(70, Math.min(118, nodes.length * 12))
    nodes.forEach((node, i) => {
      if (node.id === selectedId) { map.set(node.id, { x: cx, y: cy }); return }
      const angle = (Math.PI * 2 * i) / Math.max(nodes.length, 1) - Math.PI / 2
      map.set(node.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius })
    })
    return map
  }, [nodes, selectedId])

  if (nodes.length === 0 || edges.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <Network className="size-8 text-zinc-700" />
        <p className="text-[12px] text-zinc-600">Нет связей</p>
        <p className="text-[11px] text-zinc-700">Добавь ссылки вида [[Заметка]]</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-800 px-3 py-2">
        <p className="text-[12px] font-medium text-zinc-300">Граф связей</p>
        <p className="text-[11px] text-zinc-600">{nodes.length} узлов · {edges.length} ссылок</p>
      </div>
      <div className="flex-1 overflow-hidden p-2">
        <svg viewBox="0 0 320 300" className="h-full min-h-64 w-full rounded-lg border border-zinc-800 bg-zinc-950/60">
          {edges.map((edge, i) => {
            const from = positions.get(edge.source)
            const to = positions.get(edge.target)
            if (!from || !to) return null
            return (
              <line
                key={`${edge.source}-${edge.target}-${i}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className={edge.unresolved ? "stroke-zinc-700" : "stroke-sky-500/45"}
                strokeWidth="1.2"
              />
            )
          })}
          {nodes.map(node => {
            const pos = positions.get(node.id)
            if (!pos) return null
            const selected = node.id === selectedId
            return (
              <g
                key={node.id}
                className={node.unresolved ? "cursor-default" : "cursor-pointer"}
                onClick={() => { if (!node.unresolved) onSelect(node.id) }}
              >
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={selected ? 10 : 7}
                  className={selected ? "fill-sky-400" : node.unresolved ? "fill-zinc-700" : "fill-zinc-300"}
                />
                <text
                  x={pos.x}
                  y={pos.y + 20}
                  textAnchor="middle"
                  className={selected ? "fill-sky-300 text-[10px]" : "fill-zinc-500 text-[9px]"}
                >
                  {node.label.slice(0, 18)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

interface AppSidebarProps {
  treeItems: TreeItem[]
  selectedId: string | null
  vault: string | null
  onSelect: (id: string) => void
  onOpenVault: () => void
  onTreeChange: (items: TreeItem[]) => void
  onRename?: (id: string, newName: string) => void
  onDelete?: (id: string) => void
  onNewFile?: (parentId: string | null) => void
  onNewFolder?: (parentId: string | null) => void
  activeView?: SidebarView
  onActiveViewChange?: (view: SidebarView) => void
  onOpenInNewTab?: (id: string) => void
  onOpenInExplorer?: (id: string) => void
  onMoveItem?: (sourceId: string, targetFolderId: string) => void
  onSetIcon?: (id: string, icon: string) => void
  triggerRenameId?: string | null
  isTreeOpen?: boolean
  treeWidth?: number
  readFile?: (path: string) => Promise<string>
  favorites?: Set<string>
  onToggleFavorite?: (id: string) => void
  linkGraph?: LinkGraph
}

const treeMenuItems: { id: SidebarView; icon: React.ElementType; label: string }[] = [
  { id: "search",    icon: Search,    label: "Поиск" },
  { id: "files",     icon: FolderTree, label: "Древо" },
  { id: "tags",      icon: Tag,       label: "Теги" },
  { id: "favorites", icon: Bookmark,  label: "Избранное" },
  { id: "databases", icon: Database,  label: "Базы данных" },
  { id: "archive",   icon: Archive,   label: "Архив" },
]

export function AppSidebar({
  treeItems,
  selectedId,
  vault,
  onSelect,
  onOpenVault,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder,
  activeView: controlledView,
  onActiveViewChange,
  onOpenInNewTab,
  onOpenInExplorer,
  onMoveItem,
  onSetIcon,
  triggerRenameId,
  isTreeOpen = true,
  treeWidth = 208,
  readFile,
  favorites,
  onToggleFavorite,
  linkGraph,
}: AppSidebarProps) {
  const [internalView, setInternalView] = React.useState<SidebarView>("files")
  const activeView = controlledView ?? internalView
  function setActiveView(v: SidebarView) {
    setInternalView(v)
    onActiveViewChange?.(v)
  }
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
    document.querySelector<HTMLElement>('[data-tree-selected="true"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  return (
    <div className="flex h-full">
      {/* Activity Bar */}
      <div className="flex w-11 shrink-0 flex-col border-r border-zinc-800 bg-[#0A0A0A]">

        {/* Zone 1: Tree menu */}
        <div className="flex flex-col items-center gap-0.5 py-2">
          {treeMenuItems.map(item => (
            <button
              key={item.id}
              title={item.label}
              onClick={() => setActiveView(item.id)}
              className={cn(
                "flex size-8 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white",
                activeView === item.id && "bg-zinc-800 text-white"
              )}
            >
              <item.icon className="size-4" />
            </button>
          ))}
        </div>

        {/* Divider */}
        <div className="mx-2 h-px bg-zinc-800" />

        {/* Zone 2: Function buttons */}
        <div className="flex flex-col items-center gap-0.5 py-2">
          <button
            title="Синхронизация"
            className="flex size-8 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white"
          >
            <RefreshCw className="size-4" />
          </button>
          <button
            title={`Граф связей (${linkGraph?.edges.length ?? 0})`}
            onClick={() => setActiveView("graph")}
            className={cn(
              "flex size-8 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white",
              activeView === "graph" && "bg-zinc-800 text-white"
            )}
          >
            <Network className="size-4" />
          </button>
        </div>

        {/* Divider */}
        <div className="mx-2 h-px bg-zinc-800" />

        {/* Zone 3: Additional — pushed to bottom */}
        <div className="flex flex-1 flex-col items-center justify-end gap-0.5 py-2">
          <button title="Уведомления" className="flex size-8 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white">
            <Bell className="size-4" />
          </button>
          <button title="Настройки" className="flex size-8 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white">
            <Settings className="size-4" />
          </button>
          <button title="Справка" className="flex size-8 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white">
            <HelpCircle className="size-4" />
          </button>
          <div className="mt-1 size-7 rounded-full bg-gradient-to-br from-amber-500 to-orange-600" title="Аккаунт" />
        </div>
      </div>

      {/* Tree Sidebar */}
      <div className={`flex h-full min-h-0 flex-col border-r border-zinc-800 bg-[#0A0A0A] ${isTreeOpen ? "" : "hidden"}`} style={{ width: treeWidth }}>
        {/* Toolbar — only shown in files view */}
        {activeView === "files" && (
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
        )}

        {/* Content area */}
        {activeView === "files" ? (
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
        ) : activeView === "search" ? (
          <SidebarSearch items={treeItems} onSelect={onSelect} readFile={readFile} />
        ) : activeView === "tags" ? (
          <SidebarTags items={treeItems} onSelect={onSelect} readFile={readFile} />
        ) : activeView === "favorites" ? (
          <FavoritesView
            treeItems={treeItems}
            favorites={favorites ?? new Set()}
            onSelect={onSelect}
            onToggleFavorite={onToggleFavorite}
          />
        ) : activeView === "graph" ? (
          <LinkGraphView graph={linkGraph} selectedId={selectedId} onSelect={onSelect} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <p className="text-[12px] text-zinc-600">
              {treeMenuItems.find(i => i.id === activeView)?.label}
            </p>
            <p className="text-[11px] text-zinc-700">Скоро</p>
          </div>
        )}
      </div>

      <NewItemModal
        open={newItemModalOpen}
        onClose={() => setNewItemModalOpen(false)}
        onCreateNote={() => onNewFile?.(null)}
      />
    </div>
  )
}
