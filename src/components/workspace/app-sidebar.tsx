"use client"

import {
  ArrowDownUp,
  Bell,
  Bookmark,
  FolderOpen,
  HelpCircle,
  LayoutGrid,
  MessageSquare,
  PenLine,
  Search,
  Settings,
  Tag,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SidebarTree, type TreeItem } from "./sidebar-tree"

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
}

const navItems = [
  { icon: Search, label: "Search" },
  { icon: FolderOpen, label: "Files" },
  { icon: Tag, label: "Tags" },
  { icon: Bookmark, label: "Bookmarks" },
  { icon: LayoutGrid, label: "Canvas" },
  { icon: MessageSquare, label: "Chat" },
]

const bottomNavItems = [
  { icon: Bell, label: "Notifications" },
  { icon: Settings, label: "Settings" },
  { icon: HelpCircle, label: "Help" },
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
}: AppSidebarProps) {
  function handleNewFile() {
    if (!vault) { onOpenVault(); return }
    onNewFile?.(null)
  }

  return (
    <div className="flex h-full">
      {/* Icon Navigation Rail */}
      <div className="flex w-11 flex-col items-center border-r border-zinc-800 bg-[#0A0A0A] py-2">
        <nav className="flex flex-1 flex-col items-center gap-0.5">
          {navItems.map((item, index) => (
            <Button
              key={item.label}
              variant="ghost"
              size="icon"
              className={`size-8 text-zinc-500 hover:bg-zinc-800 hover:text-white ${index === 0 ? "mt-1" : ""}`}
              title={item.label}
            >
              <item.icon className="size-4" />
            </Button>
          ))}
        </nav>

        <nav className="flex flex-col items-center gap-0.5">
          {bottomNavItems.map((item) => (
            <Button
              key={item.label}
              variant="ghost"
              size="icon"
              className="size-8 text-zinc-500 hover:bg-zinc-800 hover:text-white"
              title={item.label}
            >
              <item.icon className="size-4" />
            </Button>
          ))}
          <div className="mt-1.5 size-7 rounded-full bg-gradient-to-br from-amber-500 to-orange-600" />
        </nav>
      </div>

      {/* Tree Sidebar */}
      <div className="flex w-52 flex-col border-r border-zinc-800 bg-[#0A0A0A]">
        <div className="flex h-9 items-center justify-between border-b border-zinc-800 px-2">
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white"
              title="Sort"
            >
              <ArrowDownUp className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white"
              title="Open Vault"
              onClick={onOpenVault}
            >
              <FolderOpen className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white"
              title="Settings"
            >
              <Settings className="size-3.5" />
            </Button>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-1.5">
            {treeItems.length === 0 ? (
              <p className="px-2 py-3 text-[12px] text-zinc-600">
                No files yet. Create one below.
              </p>
            ) : (
              <SidebarTree
                items={treeItems}
                selectedId={selectedId}
                onSelect={onSelect}
                onRename={onRename}
                onDelete={onDelete}
                onNewFile={onNewFile}
              />
            )}
          </div>
        </ScrollArea>

        <div className="p-2">
          <Button
            className="w-full gap-2 bg-zinc-100 text-zinc-900 hover:bg-white"
            onClick={handleNewFile}
          >
            <PenLine className="size-4" />
            New
          </Button>
        </div>
      </div>
    </div>
  )
}
