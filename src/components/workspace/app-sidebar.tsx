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
import { SidebarTree, TreeItem } from "./sidebar-tree"

interface AppSidebarProps {
  selectedId: string | null
  onSelect: (id: string) => void
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

const treeData: TreeItem[] = [
  {
    id: "main",
    name: "Main",
    type: "folder",
    icon: "workspace",
    children: [
      {
        id: "projects",
        name: "Projects",
        type: "folder",
        icon: "workspace",
        children: [
          { id: "project-beta", name: "Project Beta", type: "file", icon: "file" },
          { id: "project-alpha", name: "Project Alpha", type: "file", icon: "brain" },
        ],
      },
      { id: "notes-1", name: "Notes", type: "file", icon: "file" },
      { id: "notes-2", name: "Notes", type: "file", icon: "file" },
    ],
  },
  {
    id: "projects-root",
    name: "Projects",
    type: "folder",
    icon: "folder",
    children: [],
  },
  {
    id: "journal",
    name: "Journal",
    type: "folder",
    icon: "folder",
    children: [],
  },
  {
    id: "drafts",
    name: "Drafts",
    type: "folder",
    icon: "draft",
    children: [
      { id: "draft-notes-1", name: "Notes", type: "file", icon: "file" },
      { id: "draft-notes-2", name: "Notes", type: "file", icon: "file" },
    ],
  },
  { id: "notes-root", name: "Notes", type: "file", icon: "file" },
  { id: "canvas", name: "Canvas", type: "canvas", icon: "canvas" },
]

export function AppSidebar({ selectedId, onSelect }: AppSidebarProps) {
  return (
    <div className="flex h-full">
      {/* Icon Navigation Rail - w-11 (2.75rem = 44px) to match header Column 1 */}
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

      {/* Tree Sidebar - w-52 (13rem = 208px) to match header Column 2 */}
      <div className="flex w-52 flex-col border-r border-zinc-800 bg-[#0A0A0A]">
        {/* Header with controls */}
        <div className="flex h-9 items-center justify-between border-b border-zinc-800 px-2">
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white">
              <ArrowDownUp className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white">
              <FolderOpen className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white">
              <Settings className="size-3.5" />
            </Button>
          </div>
        </div>

        {/* Tree */}
        <ScrollArea className="flex-1">
          <div className="p-1.5">
            <SidebarTree items={treeData} selectedId={selectedId} onSelect={onSelect} />
          </div>
        </ScrollArea>

        {/* New Button - High contrast white */}
        <div className="p-2">
          <Button className="w-full gap-2 bg-zinc-100 text-zinc-900 hover:bg-white">
            <PenLine className="size-4" />
            New
          </Button>
        </div>
      </div>
    </div>
  )
}
