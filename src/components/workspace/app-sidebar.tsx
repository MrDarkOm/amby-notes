"use client"

import * as React from "react"
import {
  Archive,
  ArrowDownUp,
  Bell,
  Bookmark,
  ChevronsDownUp,
  ChevronsUpDown,
  Database,
  FilePlus,
  FolderPlus,
  FolderTree,
  HelpCircle,
  LocateFixed,
  RefreshCw,
  Search,
  Settings,
  Tag,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SidebarTree, type TreeItem } from "./sidebar-tree"
import { SidebarSearch } from "./sidebar-search"
import { SidebarTags } from "./sidebar-tags"
import { NewItemModal } from "./new-item-modal"

type SidebarView = "files" | "search" | "tags" | "favorites" | "databases" | "archive"

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
  onOpenInNewTab?: (id: string) => void
  onMoveItem?: (sourceId: string, targetFolderId: string) => void
  onSetIcon?: (id: string, icon: string) => void
  triggerRenameId?: string | null
  isTreeOpen?: boolean
  readFile?: (path: string) => Promise<string>
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
  onOpenInNewTab,
  onMoveItem,
  onSetIcon,
  triggerRenameId,
  isTreeOpen = true,
  readFile,
}: AppSidebarProps) {
  const [activeView, setActiveView] = React.useState<SidebarView>("files")
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
      <div className={`flex h-full w-52 min-h-0 flex-col border-r border-zinc-800 bg-[#0A0A0A] ${isTreeOpen ? "" : "hidden"}`}>
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
          <>
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
                    onMoveItem={onMoveItem}
                    onSetIcon={onSetIcon}
                    triggerRenameId={triggerRenameId}
                    folderResetKey={folderResetKey}
                    folderTargetOpen={folderTargetOpen}
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
          </>
        ) : activeView === "search" ? (
          <SidebarSearch items={treeItems} onSelect={onSelect} readFile={readFile} />
        ) : activeView === "tags" ? (
          <SidebarTags items={treeItems} onSelect={onSelect} readFile={readFile} />
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
