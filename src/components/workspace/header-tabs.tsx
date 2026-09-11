"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import {
  Columns2,
  ChevronDown,
  FolderOpen,
  Maximize2,
  Minimize2,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Star,
  X,
} from "lucide-react"

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
import { cn } from "@/lib/utils"
import { motionTransitions } from "@/lib/motion-config"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isTauri } from "@/lib/storage"
import { adoptAsyncDisposer } from "@/lib/async-disposable"
import { WorkspacePicker, type VaultRecord } from "./workspace-picker"
import { IconValue } from "./icon-value"
import { isRichIconValue } from "./icon-values"
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
  icon?: string
}

function tabEmoji(icon?: string) {
  return Boolean(
    icon &&
    (isRichIconValue(icon) ||
      !/^(folder|file|supernote|page|workspace|canvas|draft|brain)$/u.test(icon)),
  )
}

interface TabsMenuProps {
  trigger: React.ReactNode
  tabs: HeaderTab[]
  activeTabKey: string
  activeFileId?: string
  favorites?: Set<string>
  onTabChange: (key: string) => void
  onToggleFavorite?: (id: string) => void
  onCloseAllTabs?: () => void
  align?: "start" | "center" | "end"
}

/** Shared tabs menu used by both the normal header and focus mode. */
export function TabsMenu({
  trigger,
  tabs,
  activeTabKey,
  activeFileId,
  favorites,
  onTabChange,
  onToggleFavorite,
  onCloseAllTabs,
  align = "end",
}: TabsMenuProps) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-56 border-border bg-popover text-foreground">
        <DropdownMenuItem
          disabled={!activeFileId}
          className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
          onSelect={() => activeFileId && onToggleFavorite?.(activeFileId)}
        >
          {activeFileId && favorites?.has(activeFileId) ? (
            <>
              <Star className="size-3.5 fill-current text-primary" />
              {t("tabs.removeBookmark")}
            </>
          ) : (
            <>
              <Star className="size-3.5 text-muted-foreground" />
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
                  activeTabKey === tab.key && "bg-accent text-foreground",
                )}
                onSelect={() => onTabChange(tab.key)}
              >
                {tabEmoji(tab.icon) && (
                  <span className="flex size-4 items-center justify-center" aria-hidden="true">
                    <IconValue value={tab.icon} className="size-4" />
                  </span>
                )}
                <span className="truncate">{tab.title}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
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
  isLeftDockPinned?: boolean
  isRightDockPinned?: boolean
  onSetLeftDockPinned?: (pinned: boolean) => void
  onSetRightDockPinned?: (pinned: boolean) => void
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
  onToggleSplit?: () => void
  isSplit?: boolean
}

// Keep the title-bar controls aligned with the real `w-12` activity rails.
// Using an approximate width here makes the sidebar toggles jump when a panel
// opens or closes.
const ACTIVITY_BAR_WIDTH = 48
// Windows keeps the right-sidebar toggle beside the three native-style
// window controls, so the full edge-control cluster is four 48px slots.
const WINDOW_CONTROLS_WIDTH = 192
const MACOS_SIDEBAR_TOGGLE_WIDTH = 44

// Shared style for header toolbar icon buttons (sidebar toggles, dropdown,
// plus) — keeps a uniform 32×32 hit area, rounding and hover highlight.
const HEADER_ICON_BTN =
  "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"

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
  isLeftDockPinned = true,
  isRightDockPinned = true,
  onSetLeftDockPinned,
  onSetRightDockPinned,
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
  leftTreeWidth = 300,
  rightPanelWidth = 300,
  activeFileId,
  favorites,
  onToggleFavorite,
  showWorkspacePicker = true,
  onToggleSplit,
  isSplit = false,
}: HeaderTabsProps) {
  const { t } = useTranslation()
  // The left header dock ends on the same divider as the left body panel.
  // On macOS the 80px traffic-light region already consumes 36px more than the
  // 44px activity rail, so subtract that difference from the panel header.
  const rightDockWidth = isRightDockPinned ? ACTIVITY_BAR_WIDTH : 0
  // When the right panel is hidden, edge controls still occupy the end of the
  // header: the system window controls on Windows/Linux or the right-sidebar
  // toggle on macOS. Keep the view controls to their left.
  const leftPanelHeaderCssWidth = isMac
    ? `max(0px, calc(var(--amby-left-panel-width, ${leftTreeWidth}px) - ${80 - ACTIVITY_BAR_WIDTH}px))`
    : `var(--amby-left-panel-width, ${leftTreeWidth}px)`
  const rightHeaderInsetCss =
    isRightSidebarOpen && isRightDockPinned
      ? `max(${isMac ? MACOS_SIDEBAR_TOGGLE_WIDTH : WINDOW_CONTROLS_WIDTH}px, calc(var(--amby-right-panel-width, ${rightPanelWidth}px) + ${rightDockWidth}px))`
      : `${isMac ? MACOS_SIDEBAR_TOGGLE_WIDTH : WINDOW_CONTROLS_WIDTH}px`
  const [isMaximized, setIsMaximized] = React.useState(false)
  const lastClickTimeRef = React.useRef(0)

  React.useEffect(() => {
    if (!isTauri()) return
    const win = getCurrentWindow()
    win
      .isMaximized()
      .then(setIsMaximized)
      .catch(() => {})
    return adoptAsyncDisposer(
      win.onResized(() => {
        win
          .isMaximized()
          .then(setIsMaximized)
          .catch(() => {})
      }),
    )
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
    side: "left" | "right",
    sidebarOpen: boolean,
    dockPinned: boolean,
    onToggleSidebar?: () => void,
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
            {t(side === "left" ? "dock.pinLeft" : "dock.pinRight")}
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
    "left",
    isLeftSidebarOpen,
    isLeftDockPinned,
    onToggleLeftSidebar,
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
    "right",
    isRightSidebarOpen,
    isRightDockPinned,
    onToggleRightSidebar,
    onSetRightDockPinned,
  )

  const viewControls = (
    <div
      className="absolute top-1.5 z-10 flex items-center gap-1"
      style={{ right: rightHeaderInsetCss }}
    >
      {onToggleSplit && (
        <button
          type="button"
          title={t("tabs.splitEditor")}
          aria-label={t("tabs.splitEditor")}
          aria-pressed={isSplit}
          onClick={onToggleSplit}
          className={cn(HEADER_ICON_BTN, isSplit && "bg-accent text-foreground")}
        >
          <Columns2 className="size-4" />
        </button>
      )}
      <TabsMenu
        trigger={
          <button title={t("tabs.tabMenu")} className={HEADER_ICON_BTN}>
            <ChevronDown className="size-4" />
          </button>
        }
        tabs={tabs}
        activeTabKey={activeTabKey}
        activeFileId={activeFileId}
        favorites={favorites}
        onTabChange={onTabChange}
        onToggleFavorite={onToggleFavorite}
        onCloseAllTabs={onCloseAllTabs}
      />
    </div>
  )

  return (
    <header
      className="relative z-50 flex h-11 select-none items-stretch bg-background"
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("button, a, input, select, [role='button']"))
          return
        if (isTauri())
          getCurrentWindow()
            .toggleMaximize()
            .catch(() => {})
      }}
    >
      {/* macOS traffic light spacer — native buttons live here */}
      {isMac ? (
        <div className="w-[80px] shrink-0" onMouseDown={handleDragStart} />
      ) : (
        /* Windows: the left toggle is aligned with the left activity rail. */
        <div
          className="flex w-12 shrink-0 items-center justify-center"
          onMouseDown={handleDragStart}
        >
          {leftSidebarToggle}
        </div>
      )}

      {/* Workspace switcher (left panel header column, only when panel open) */}
      {isLeftSidebarOpen && isLeftDockPinned && (
        <div
          className="flex shrink-0 items-center"
          style={{ width: leftPanelHeaderCssWidth }}
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
                  className="flex min-w-0 items-center gap-2 rounded px-2 py-1 text-left outline-none hover:bg-accent"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block whitespace-nowrap text-[8px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                      {t("vaultPicker.workspaceLabel")}
                    </span>
                    <span className="block truncate text-sm font-medium text-foreground">
                      {vaultName ?? t("workspace.name")}
                    </span>
                  </span>
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
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
          isMac
            ? isLeftSidebarOpen && isLeftDockPinned
              ? "pl-0"
              : "pl-9"
            : isLeftSidebarOpen
              ? "pl-0"
              : "pl-0",
        )}
      >
        <div className="flex h-full min-w-0 items-center gap-1 overflow-hidden">
          {tabs.map((tab) => (
            <motion.div
              key={tab.key}
              initial={false}
              animate={activeTabKey === tab.key ? "selected" : "rest"}
              whileHover="hover"
              transition={motionTransitions.reorder}
              onClick={() => onTabChange(tab.key)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  onTabClose(tab.key)
                }
              }}
              className={cn(
                "group relative flex h-8 min-w-0 max-w-52 cursor-pointer items-center gap-2 self-center rounded-lg border border-border/80 px-3 text-sm",
                activeTabKey === tab.key
                  ? "bg-[var(--note-surface)] text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {unsavedFileIds?.has(tab.fileId) && (
                <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
              )}
              {tabEmoji(tab.icon) && (
                <span className="flex size-4 items-center justify-center" aria-hidden="true">
                  <IconValue value={tab.icon} className="size-4" />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              <motion.button
                onClick={(e) => {
                  e.stopPropagation()
                  onTabClose(tab.key)
                }}
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
                variants={{ rest: { opacity: 0 }, hover: { opacity: 1 }, selected: { opacity: 1 } }}
                transition={motionTransitions.fast}
              >
                <X className="size-3.5" />
              </motion.button>
            </motion.div>
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
      {isMac && <div className="absolute left-[80px] top-1.5 z-20">{leftSidebarToggle}</div>}
      {/* Match the exact body dock width. This keeps the right toggle attached
          to the panel divider and prevents the large jump when it is closed. */}
      <div
        style={{
          width:
            isRightSidebarOpen && isRightDockPinned
              ? `calc(var(--amby-right-panel-width, ${rightPanelWidth}px) + ${rightDockWidth}px)`
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

      {/* Windows: the right toggle stays immediately before the native-style
          controls instead of jumping to the opposite side of the header. */}
      {!isMac && (
        <div className="amby-window-controls absolute right-0 top-0 flex h-11 w-48 items-center justify-end">
          <div className="flex h-11 w-12 shrink-0 items-center justify-center">
            {rightSidebarToggle}
          </div>
          <button
            type="button"
            aria-label={t("settings.window.minimize")}
            onClick={() => isTauri() && getCurrentWindow().minimize()}
            className="amby-window-control"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={isMaximized ? t("settings.window.restore") : t("settings.window.maximize")}
            onClick={() => isTauri() && getCurrentWindow().toggleMaximize()}
            className="amby-window-control"
          >
            {isMaximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
          <button
            type="button"
            aria-label={t("settings.window.close")}
            onClick={() => isTauri() && getCurrentWindow().close()}
            className="amby-window-control amby-window-control--close"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </header>
  )
}
