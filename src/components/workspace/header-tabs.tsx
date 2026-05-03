"use client"

import {
  ChevronDown,
  Minus,
  Square,
  PanelLeft,
  PanelRight,
  Plus,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"

interface Tab {
  id: string
  title: string
}

interface HeaderTabsProps {
  tabs: Tab[]
  activeTabId: string
  onTabChange: (tabId: string) => void
  onTabClose: (tabId: string) => void
  onToggleLeftSidebar?: () => void
  onToggleRightSidebar?: () => void
  isLeftSidebarOpen?: boolean
  isRightSidebarOpen?: boolean
}

// Custom brain/monster logo icon
function LogoIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18" />
      <path d="M12 7c2.5 0 5 2 5 5s-2.5 5-5 5" />
    </svg>
  )
}

export function HeaderTabs({
  tabs,
  activeTabId,
  onTabChange,
  onTabClose,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  isLeftSidebarOpen = true,
  isRightSidebarOpen = true,
}: HeaderTabsProps) {
  return (
    <header 
      className="grid h-10 border-b border-zinc-800 bg-[#0A0A0A]"
      style={{ 
        gridTemplateColumns: isLeftSidebarOpen && isRightSidebarOpen
          ? "2.75rem 13rem 1fr 16rem"
          : isLeftSidebarOpen
          ? "2.75rem 13rem 1fr"
          : isRightSidebarOpen
          ? "1fr 16rem"
          : "1fr"
      }}
    >
      {/* Column 1: Logo Icon (Activity Bar width) */}
      {isLeftSidebarOpen && (
        <div className="flex items-center justify-center border-r border-zinc-800">
          <LogoIcon className="size-5 text-zinc-300" />
        </div>
      )}

      {/* Column 2: Workspace Switcher (Sidebar width) */}
      {isLeftSidebarOpen && (
        <div className="flex items-center border-r border-zinc-800 px-3">
          <button className="flex items-center gap-2 rounded px-2 py-1 text-sm transition-colors hover:bg-zinc-800">
            <div className="flex size-5 items-center justify-center rounded bg-zinc-700">
              <LogoIcon className="size-3 text-zinc-300" />
            </div>
            <span className="font-medium text-zinc-200">Workspace</span>
            <ChevronDown className="size-3 text-zinc-500" />
          </button>
        </div>
      )}

      {/* Column 3: Main Editor Header (flex-1) */}
      <div className="flex items-center justify-between px-1">
        {/* Left side: Panel toggle + Tabs + Plus */}
        <div className="flex h-full items-center">
          {/* Left Panel Toggle */}
          <button
            onClick={onToggleLeftSidebar}
            className={cn(
              "flex size-8 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white",
              !isLeftSidebarOpen && "text-zinc-300"
            )}
          >
            <PanelLeft className="size-4" />
          </button>

          {/* Tabs */}
          <div className="flex h-full items-center">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                className={cn(
                  "group relative flex h-full cursor-pointer items-center gap-2 px-3 text-sm transition-colors",
                  activeTabId === tab.id
                    ? "bg-zinc-900 text-white"
                    : "text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300"
                )}
              >
                <span className="max-w-32 truncate">{tab.title}</span>
                {activeTabId === tab.id && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onTabClose(tab.id)
                    }}
                    className="flex size-4 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-700 hover:text-white"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Plus button */}
          <button className="flex size-8 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white">
            <Plus className="size-4" />
          </button>
        </div>

        {/* Right side: ChevronDown + Panel toggle */}
        <div className="flex items-center">
          <button className="flex size-8 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white">
            <ChevronDown className="size-4" />
          </button>
          <button
            onClick={onToggleRightSidebar}
            className={cn(
              "flex size-8 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white",
              !isRightSidebarOpen && "text-zinc-300"
            )}
          >
            <PanelRight className="size-4" />
          </button>
        </div>
      </div>

      {/* Column 4: Window Controls (Right Panel width) */}
      {isRightSidebarOpen && (
        <div className="flex items-center justify-end border-l border-zinc-800">
          <button className="flex size-10 items-center justify-center text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white">
            <Minus className="size-4" />
          </button>
          <button className="flex size-10 items-center justify-center text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white">
            <Square className="size-3.5" />
          </button>
          <button className="flex size-10 items-center justify-center text-zinc-500 transition-colors hover:bg-red-500/20 hover:text-red-400">
            <X className="size-4" />
          </button>
        </div>
      )}
    </header>
  )
}
