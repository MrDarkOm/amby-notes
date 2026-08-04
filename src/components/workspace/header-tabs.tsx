"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  Columns2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  X,
} from "lucide-react"

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
import { cn } from "@/lib/utils"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isTauri } from "@/lib/storage"
import { WorkspacePicker, type VaultRecord } from "./workspace-picker"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

export interface HeaderTab {
  key: string
  fileId: string
  title: string
}
interface HeaderTabsProps {
  tabs: HeaderTab[]
  activeTabKey: string
  unsavedFileIds?: Set<string>
  onTabChange: (key: string) => void
  onTabClose: (key: string) => void
  onToggleLeftSidebar?: () => void
  onToggleRightSidebar?: () => void
  isLeftSidebarOpen?: boolean
  isRightSidebarOpen?: boolean
  isLeftDockVisible?: boolean
  isRightDockVisible?: boolean
  isLeftDockPinned?: boolean
  isRightDockPinned?: boolean
  onSetLeftDockVisible?: (visible: boolean) => void
  onSetRightDockVisible?: (visible: boolean) => void
  onSetLeftDockPinned?: (pinned: boolean) => void
  onSetRightDockPinned?: (pinned: boolean) => void
  onToggleSplit?: () => void
  isSplit?: boolean
  onOpenPlusModal?: () => void
  vaultName?: string
  vaults: VaultRecord[]
  currentVaultPath: string | null
  onSwitchVault: (path: string) => void
  onAddVault: () => void
  onRenameVault: (id: string, name: string) => void
  onDeleteVault: (id: string) => void
  onMoveVault: (id: string) => void
  onOpenVaultInExplorer: (path: string) => void
  onCloseAllTabs?: () => void
  leftTreeWidth?: number
  rightPanelWidth?: number
  activeFileId?: string
  favorites?: Set<string>
  onToggleFavorite?: (id: string) => void
  showWorkspacePicker?: boolean
}

// Keep the title-bar controls aligned with the real `w-12` activity rails.
// Using an approximate width here makes the sidebar toggles jump when a panel
// opens or closes.
const ACTIVITY_BAR_WIDTH = 48
const WINDOW_CONTROLS_WIDTH = 144
const MACOS_SIDEBAR_TOGGLE_WIDTH = 44

// Shared style for header toolbar icon buttons (sidebar toggles, dropdown,
// split, plus) — keeps a uniform 32×32 hit area, rounding and hover highlight.
const HEADER_ICON_BTN =
  "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"

function handleDragStart(e: React.MouseEvent) {
  if (e.button !== 0) return
  // Skip drag when the click originated on an interactive element.
  // Without this guard the mousedown bubbles from e.g. a sidebar-toggle button
  // up to the drag-region div, startDragging() captures the mouse pointer, and
  // the button's click event never fires.
  if ((e.target as HTMLElement).closest("button, a, input, select, [role='button']")) return
  if (isTauri()) {
    e.preventDefault()
    getCurrentWindow()
      .startDragging()
      .catch(() => {})
  }
}

export function HeaderTabs({
  tabs,
  activeTabKey,
  unsavedFileIds,
  onTabChange,
  onTabClose,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  isLeftSidebarOpen = true,
  isRightSidebarOpen = true,
  isLeftDockVisible = true,
  isRightDockVisible = true,
  isLeftDockPinned = true,
  isRightDockPinned = true,
  onSetLeftDockVisible,
  onSetRightDockVisible,
  onSetLeftDockPinned,
  onSetRightDockPinned,
  onToggleSplit,
  isSplit = false,
  onOpenPlusModal,
  vaultName,
  vaults,
  currentVaultPath,
  onSwitchVault,
  onAddVault,
  onRenameVault,
  onDeleteVault,
  onMoveVault,
  onOpenVaultInExplorer,
  onCloseAllTabs,
  leftTreeWidth = 200,
  rightPanelWidth = 256,
  activeFileId,
  favorites,
  onToggleFavorite,
  showWorkspacePicker = true,
}: HeaderTabsProps) {
  const { t } = useTranslation()
  // The left header dock ends on the same divider as the left body panel.
  // On macOS the 80px traffic-light region already consumes 36px more than the
  // 44px activity rail, so subtract that difference from the panel header.
  const leftPanelHeaderWidth = Math.max(
    0,
    isMac ? leftTreeWidth - (80 - ACTIVITY_BAR_WIDTH) : leftTreeWidth,
  )
  const rightDockWidth = isRightDockVisible ? (isRightDockPinned ? ACTIVITY_BAR_WIDTH : 4) : 0
  // When the right panel is hidden, edge controls still occupy the end of the
  // header: the system window controls on Windows/Linux or the right-sidebar
  // toggle on macOS. Keep the view controls to their left.
  const rightHeaderInset = Math.max(
    (isRightSidebarOpen ? rightPanelWidth : 0) + rightDockWidth,
    isMac ? MACOS_SIDEBAR_TOGGLE_WIDTH : WINDOW_CONTROLS_WIDTH,
  )
  const [isMaximized, setIsMaximized] = React.useState(false)
  const lastClickTimeRef = React.useRef(0)

  React.useEffect(() => {
    if (!isTauri()) return
    const win = getCurrentWindow()
    win
      .isMaximized()
      .then(setIsMaximized)
      .catch(() => {})
    let unlisten: (() => void) | undefined
    win
      .onResized(() => {
        win
          .isMaximized()
          .then(setIsMaximized)
          .catch(() => {})
      })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})
    return () => {
      unlisten?.()
    }
  }, [])

  function handleEmptySpaceMouseDown(e: React.MouseEvent) {
    if (e.button !== 0 || !isTauri()) return
    if ((e.target as HTMLElement).closest("button, a, input, select, [role='button']")) return
    e.preventDefault()
    const now = Date.now()
    const since = now - lastClickTimeRef.current
    lastClickTimeRef.current = now
    if (since < 300) {
      lastClickTimeRef.current = 0
      getCurrentWindow().toggleMaximize()
    } else {
      getCurrentWindow()
        .startDragging()
        .catch(() => {})
    }
  }

  function withVisibilityMenu(
    trigger: React.ReactNode,
    sidebarOpen: boolean,
    dockVisible: boolean,
    dockPinned: boolean,
    onToggleSidebar?: () => void,
    onSetDockVisible?: (visible: boolean) => void,
    onSetDockPinned?: (pinned: boolean) => void,
  ) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
        <ContextMenuContent className="w-56 border-border bg-popover text-foreground">
          <ContextMenuCheckboxItem
            checked={sidebarOpen}
            indicatorPosition="right"
            onCheckedChange={(visible) => {
              if (visible !== sidebarOpen) onToggleSidebar?.()
            }}
          >
            {t("tabs.showSidebar")}
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={dockPinned}
            indicatorPosition="right"
            onCheckedChange={onSetDockPinned}
          >
            {t("dock.pin")}
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={!dockVisible}
            indicatorPosition="right"
            onCheckedChange={(hidden) => onSetDockVisible?.(!hidden)}
          >
            {t("dock.hide")}
          </ContextMenuCheckboxItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  const leftSidebarToggle = withVisibilityMenu(
    <button
      onClick={onToggleLeftSidebar}
      onMouseDown={(e) => e.stopPropagation()}
      title={isLeftSidebarOpen ? t("tabs.closeLeftSidebar") : t("tabs.openLeftSidebar")}
      className={HEADER_ICON_BTN}
    >
      {isLeftSidebarOpen ? (
        <PanelLeftClose className="size-4" />
      ) : (
        <PanelLeftOpen className="size-4 text-foreground" />
      )}
    </button>,
    isLeftSidebarOpen,
    isLeftDockVisible,
    isLeftDockPinned,
    onToggleLeftSidebar,
    onSetLeftDockVisible,
    onSetLeftDockPinned,
  )

  const rightSidebarToggle = withVisibilityMenu(
    <button
      onClick={onToggleRightSidebar}
      onMouseDown={(e) => e.stopPropagation()}
      title={isRightSidebarOpen ? t("tabs.closeRightSidebar") : t("tabs.openRightSidebar")}
      className={HEADER_ICON_BTN}
    >
      {isRightSidebarOpen ? (
        <PanelRightClose className="size-4" />
      ) : (
        <PanelRightOpen className="size-4 text-foreground" />
      )}
    </button>,
    isRightSidebarOpen,
    isRightDockVisible,
    isRightDockPinned,
    onToggleRightSidebar,
    onSetRightDockVisible,
    onSetRightDockPinned,
  )

  const viewControls = (
    <div
      className="absolute top-1.5 z-10 flex items-center gap-1"
      style={{ right: rightHeaderInset }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button title={t("tabs.tabMenu")} className={HEADER_ICON_BTN}>
            <ChevronDown className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 border-border bg-popover text-foreground">
          <DropdownMenuItem
            disabled={!activeFileId}
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => activeFileId && onToggleFavorite?.(activeFileId)}
          >
            {activeFileId && favorites?.has(activeFileId) ? (
              <>
                <BookmarkCheck className="size-3.5 text-amber-400" />
                {t("tabs.removeBookmark")}
              </>
            ) : (
              <>
                <Bookmark className="size-3.5 text-muted-foreground" />
                {t("tabs.addBookmark")}
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={onCloseAllTabs}
          >
            <X className="size-3.5 text-muted-foreground" />
            {t("tabs.closeAll")}
          </DropdownMenuItem>
          {tabs.length > 0 && (
            <>
              <DropdownMenuSeparator className="bg-accent" />
              {tabs.map((tab) => (
                <DropdownMenuItem
                  key={tab.key}
                  className={cn(
                    "flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white",
                    activeTabKey === tab.key && "text-white",
                  )}
                  onSelect={() => onTabChange(tab.key)}
                >
                  <span className="truncate">{tab.title}</span>
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {onToggleSplit && (
        <button
          onClick={onToggleSplit}
          title={t("tabs.splitEditor")}
          className={cn(HEADER_ICON_BTN, isSplit && "text-primary")}
        >
          <Columns2 className="size-4" />
        </button>
      )}
    </div>
  )

  return (
    <header className="relative z-50 flex h-11 select-none items-stretch bg-background">
      {/* macOS traffic light spacer — native buttons live here */}
      {isMac ? (
        <div className="w-[80px] shrink-0" onMouseDown={handleDragStart} />
      ) : (
        /* Non-mac: right panel toggle in the former logo position */
        <div
          className="flex w-11 shrink-0 items-center justify-center"
          onMouseDown={handleDragStart}
        >
          {rightSidebarToggle}
        </div>
      )}

      {/* Workspace switcher (left panel header column, only when panel open) */}
      {isLeftSidebarOpen && (
        <div
          className="flex shrink-0 items-center"
          style={{ width: leftPanelHeaderWidth }}
          onMouseDown={handleDragStart}
        >
          <div className="flex min-w-0 flex-1 items-center px-3">
            {showWorkspacePicker && (
              <WorkspacePicker
                vaults={vaults}
                currentPath={currentVaultPath}
                onSelect={onSwitchVault}
                onAdd={onAddVault}
                onRename={onRenameVault}
                onDelete={onDeleteVault}
                onMove={onMoveVault}
                onOpenInExplorer={onOpenVaultInExplorer}
              >
                <button
                  title={t("vaultPicker.vaults")}
                  className="flex min-w-0 items-center gap-1.5 rounded px-2 py-1 text-sm transition-colors hover:bg-accent"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <span className="truncate font-medium text-foreground">
                    {vaultName ?? t("workspace.name")}
                  </span>
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                </button>
              </WorkspacePicker>
            )}
          </div>
        </div>
      )}

      {/* Editor area (flex-1). Tabs share the width and shrink with the window;
          the strip ends right where the view-controls cluster begins. */}
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 overflow-hidden pr-1",
          isLeftSidebarOpen ? "pl-1" : "pl-10",
        )}
      >
        <div className="flex h-full min-w-0 items-center gap-1 overflow-hidden">
          {tabs.map((tab) => (
            <div
              key={tab.key}
              onClick={() => onTabChange(tab.key)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  onTabClose(tab.key)
                }
              }}
              className={cn(
                "group relative flex h-8 min-w-0 max-w-52 cursor-pointer items-center gap-2 self-center rounded-lg border border-border/80 px-3 text-sm transition-colors",
                activeTabKey === tab.key
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {unsavedFileIds?.has(tab.fileId) && (
                <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onTabClose(tab.key)
                }}
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                  activeTabKey === tab.key ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>

        <button title={t("tabs.newTab")} onClick={onOpenPlusModal} className={HEADER_ICON_BTN}>
          <Plus className="size-4" />
        </button>

        <div className="h-full flex-1 cursor-default" onMouseDown={handleEmptySpaceMouseDown} />
      </div>

      {/* View controls cluster — kept in the flex flow, so the editor strip
          (tabs + plus) ends exactly at its left edge. It still lands on the
          panel divider because the window controls below are absolutely
          positioned and don't consume flow width. */}
      {viewControls}

      {/* Sidebar toggles are window-edge controls: unlike panel content they
          never move when a sidebar opens, closes, or is resized. */}
      <div className={cn("absolute top-1.5 z-20", isMac ? "left-[80px]" : "left-11")}>
        {leftSidebarToggle}
      </div>
      {/* Match the exact body dock width. This keeps the right toggle attached
          to the panel divider and prevents the large jump when it is closed. */}
      <div
        style={{
          width: isRightSidebarOpen
            ? rightPanelWidth + (isMac ? 0 : rightDockWidth)
            : isMac
              ? 0
              : rightDockWidth,
        }}
        className="shrink-0"
        onMouseDown={handleDragStart}
      />

      {/* macOS: right panel toggle in the former logo position */}
      {isMac && (
        <div
          className="flex w-11 shrink-0 items-center justify-center"
          onMouseDown={handleDragStart}
        >
          {rightSidebarToggle}
        </div>
      )}

      {/* Non-mac window controls — absolutely positioned so they don't consume
          flex width (the body has no window controls on this side, so the
          editor's view controls line up with the panel divider). */}
      {!isMac && (
        <div className="absolute right-0 top-0 flex h-11 items-center border-b border-border bg-background">
          <button
            onClick={() => isTauri() && getCurrentWindow().minimize()}
            className="flex h-11 w-12 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
          <button
            onClick={() => isTauri() && getCurrentWindow().toggleMaximize()}
            className="flex h-11 w-12 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            {isMaximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
                <path d="M2.5 2.5V0.5h7v7H7.5" stroke="currentColor" strokeWidth="1" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
              </svg>
            )}
          </button>
          <button
            onClick={() => isTauri() && getCurrentWindow().close()}
            className="flex h-11 w-12 items-center justify-center text-muted-foreground transition-colors hover:bg-red-600 hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </header>
  )
}
