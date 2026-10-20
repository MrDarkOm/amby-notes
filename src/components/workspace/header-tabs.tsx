"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { AnimatePresence, motion } from "motion/react"
import {
  Columns2,
  Rows2,
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
  type LucideIcon,
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
import { KNOWN_ICONS } from "./tree/tree-types"
import { beginTabPointerDown } from "./pane-dnd"
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
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

export interface HeaderTab {
  key: string
  fileId: string
  title: string
  icon?: string
  /** A vector icon shown instead of `icon`; set when the tab has no emoji of its own. */
  Icon?: LucideIcon
}

export function tabEmoji(icon?: string) {
  return Boolean(icon && (isRichIconValue(icon) || !KNOWN_ICONS.has(icon)))
}

function hasTabIcon(tab: HeaderTab) {
  return Boolean(tab.Icon) || tabEmoji(tab.icon)
}

function TabIcon({ tab }: { tab: HeaderTab }) {
  return tab.Icon ? (
    <tab.Icon className="size-4" />
  ) : (
    <IconValue value={tab.icon} className="size-4" />
  )
}

export interface TabsMenuProps {
  trigger: React.ReactNode
  tabs: HeaderTab[]
  activeTabKey: string
  activeFileId?: string
  favorites?: Set<string>
  onTabChange: (key: string) => void
  onToggleFavorite?: (id: string) => void
  onCloseAllTabs?: () => void
  onCloseOtherTabs?: () => void
  onSplitRight?: () => void
  onSplitDown?: () => void
  onClosePane?: () => void
  onUnsplitAll?: () => void
  align?: "start" | "center" | "end"
}

/** Shared tabs menu used by both the normal header, split panes, and focus mode. */
export function TabsMenu({
  trigger,
  tabs,
  activeTabKey,
  activeFileId,
  favorites,
  onTabChange,
  onToggleFavorite,
  onCloseAllTabs,
  onCloseOtherTabs,
  onSplitRight,
  onSplitDown,
  onClosePane,
  onUnsplitAll,
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
        {(onSplitRight || onSplitDown) && (
          <>
            <DropdownMenuSeparator className="bg-accent" />
            {onSplitRight && (
              <DropdownMenuItem
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={onSplitRight}
              >
                <Columns2 className="size-3.5 text-muted-foreground" />
                {t("tabs.splitRight")}
              </DropdownMenuItem>
            )}
            {onSplitDown && (
              <DropdownMenuItem
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={onSplitDown}
              >
                <Rows2 className="size-3.5 text-muted-foreground" />
                {t("tabs.splitDown")}
              </DropdownMenuItem>
            )}
            {onUnsplitAll && (
              <DropdownMenuItem
                className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
                onSelect={onUnsplitAll}
              >
                <X className="size-3.5 text-muted-foreground" />
                {t("tabs.unsplitAll")}
              </DropdownMenuItem>
            )}
          </>
        )}
        <DropdownMenuSeparator className="bg-accent" />
        {onCloseOtherTabs && tabs.length > 1 && (
          <DropdownMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={onCloseOtherTabs}
          >
            <X className="size-3.5 text-muted-foreground" />
            {t("tabs.closeOthers")}
          </DropdownMenuItem>
        )}
        {onClosePane && (
          <DropdownMenuItem
            className="flex items-center gap-2 text-[13px] focus:bg-accent focus:text-white"
            onSelect={onClosePane}
          >
            <X className="size-3.5 text-muted-foreground" />
            {t("tabs.closePane")}
          </DropdownMenuItem>
        )}
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
                {hasTabIcon(tab) && (
                  <span className="flex size-4 items-center justify-center" aria-hidden="true">
                    <TabIcon tab={tab} />
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
  /** False removes the right toggle and the space kept for the right dock. */
  rightPanelEnabled?: boolean
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
  onManageVaults: () => void
  onCloseAllTabs?: () => void
  leftTreeWidth?: number
  rightPanelWidth?: number
  activeFileId?: string
  favorites?: Set<string>
  onToggleFavorite?: (id: string) => void
  showWorkspacePicker?: boolean
  onToggleSplit?: () => void
  isSplit?: boolean
  paneId?: string
  onSplitRight?: (tabKey?: string) => void
  onSplitDown?: (tabKey?: string) => void
  onCloseOtherTabs?: (tabKey: string) => void
  onUnsplitAll?: () => void
  /** When true and `isSplit` is active, each pane renders its own tab bar and HeaderTabs hides the center strip. */
  hideCenterTabsWhenSplit?: boolean
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
export const HEADER_ICON_BTN =
  "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"

export function handleDragStart(e: React.MouseEvent) {
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

export interface TabItemProps {
  tab: HeaderTab
  paneId?: string
  layoutGroupId?: string
  isSelected: boolean
  isPaneFocused?: boolean
  isUnsaved?: boolean
  showDivider?: boolean
  totalTabsInPane?: number
  onTabChange: (key: string) => void
  onTabClose: (key: string) => void
  onCloseOtherTabs?: (key: string) => void
  onCloseAllTabs?: () => void
  onSplitRight?: (key: string) => void
  onSplitDown?: (key: string) => void
  onClosePane?: () => void
}

export function TabItem({
  tab,
  paneId = "pane-root",
  layoutGroupId = "activeHeaderTabPill",
  isSelected,
  isPaneFocused = true,
  isUnsaved,
  showDivider,
  totalTabsInPane = 1,
  onTabChange,
  onTabClose,
  onCloseOtherTabs,
  onCloseAllTabs,
  onSplitRight,
  onSplitDown,
  onClosePane,
}: TabItemProps) {
  const { t } = useTranslation()
  const [isHovered, setIsHovered] = React.useState(false)

  return (
    <motion.div
      key={tab.key}
      data-tab-item-key={tab.key}
      layout="position"
      initial={{ opacity: 0, scale: 0.9, y: -2 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      // A closing tab folds its width away in the normal flow, so its neighbours slide over at
      // once and stay in the flow; nothing is lifted out with absolute positioning.
      exit={{
        opacity: 0,
        width: 0,
        minWidth: 0,
        paddingLeft: 0,
        paddingRight: 0,
        marginRight: -4,
        transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] },
      }}
      transition={motionTransitions.reorder}
      onClick={() => onTabChange(tab.key)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onPointerDown={(e) => {
        if (e.button === 0 && !(e.target as HTMLElement).closest("button")) {
          beginTabPointerDown({
            tabKey: tab.key,
            title: tab.title,
            sourcePaneId: paneId,
            startX: e.clientX,
            startY: e.clientY,
          })
        }
      }}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          onTabClose(tab.key)
        }
      }}
      title={tab.title}
      className={cn(
        "group relative flex w-48 shrink min-w-10 cursor-pointer items-center justify-between self-center rounded-lg border px-2.5 text-sm select-none",
        isSelected
          ? "h-9 text-foreground border-transparent"
          : "h-8 text-muted-foreground border-transparent hover:bg-accent/40 hover:text-foreground",
      )}
    >
      {isSelected && (
        <motion.div
          layoutId={layoutGroupId}
          className={cn(
            "absolute inset-0 rounded-lg bg-[var(--note-surface)] shadow-xs border",
            isPaneFocused ? "border-border/80" : "border-border/50 opacity-85",
          )}
          transition={{ type: "spring", stiffness: 500, damping: 38 }}
        />
      )}
      {showDivider && !isHovered && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-[2.5px] inset-y-0 my-auto h-3.5 w-px bg-border/60 rounded-full"
        />
      )}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="relative z-10 flex min-w-0 flex-1 items-center justify-between gap-1">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden pr-1">
              {isUnsaved && <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />}
              {hasTabIcon(tab) && (
                <span
                  className="flex size-4 shrink-0 items-center justify-center"
                  aria-hidden="true"
                >
                  <TabIcon tab={tab} />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
            </div>
            <motion.button
              type="button"
              title={t("tabs.closeTab")}
              aria-label={t("tabs.closeTab")}
              onClick={(e) => {
                e.stopPropagation()
                onTabClose(tab.key)
              }}
              className="relative z-10 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              whileHover={{ scale: 1.15 }}
              whileTap={{ scale: 0.9 }}
              animate={{
                opacity: isSelected ? 1 : isHovered ? 1 : 0,
                scale: isSelected ? 1 : isHovered ? 1 : 0.8,
              }}
              transition={motionTransitions.fast}
              style={{
                pointerEvents: isSelected || isHovered ? "auto" : "none",
              }}
            >
              <X className="size-3.5" />
            </motion.button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52 border-border bg-popover text-foreground">
          {onSplitRight && (
            <ContextMenuItem onSelect={() => onSplitRight(tab.key)}>
              <Columns2 className="size-3.5 text-muted-foreground" />
              {t("tabs.splitRight")}
            </ContextMenuItem>
          )}
          {onSplitDown && (
            <ContextMenuItem onSelect={() => onSplitDown(tab.key)}>
              <Rows2 className="size-3.5 text-muted-foreground" />
              {t("tabs.splitDown")}
            </ContextMenuItem>
          )}
          {(onSplitRight || onSplitDown) && <ContextMenuSeparator />}
          <ContextMenuItem onSelect={() => onTabClose(tab.key)}>
            <X className="size-3.5 text-muted-foreground" />
            {t("tabs.closeTab")}
          </ContextMenuItem>
          {onCloseOtherTabs && totalTabsInPane > 1 && (
            <ContextMenuItem onSelect={() => onCloseOtherTabs(tab.key)}>
              <X className="size-3.5 text-muted-foreground" />
              {t("tabs.closeOthers")}
            </ContextMenuItem>
          )}
          {onClosePane && (
            <ContextMenuItem onSelect={onClosePane}>
              <X className="size-3.5 text-muted-foreground" />
              {t("tabs.closePane")}
            </ContextMenuItem>
          )}
          {onCloseAllTabs && (
            <ContextMenuItem onSelect={onCloseAllTabs}>
              <X className="size-3.5 text-muted-foreground" />
              {t("tabs.closeAll")}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </motion.div>
  )
}

export function HeaderTabs({
  tabs,
  activeTabKey,
  unsavedFileIds,
  onTabChange,
  onTabClose,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  rightPanelEnabled = true,
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
  onManageVaults,
  onCloseAllTabs,
  leftTreeWidth = 300,
  rightPanelWidth = 300,
  activeFileId,
  favorites,
  onToggleFavorite,
  showWorkspacePicker = true,
  onToggleSplit,
  isSplit = false,
  paneId = "pane-root",
  onSplitRight,
  onSplitDown,
  onCloseOtherTabs,
  onUnsplitAll,
  hideCenterTabsWhenSplit = false,
}: HeaderTabsProps) {
  const { t } = useTranslation()
  const hideCenterStrip = isSplit && hideCenterTabsWhenSplit
  // The left header dock ends on the same divider as the left body panel.
  // On macOS the 80px traffic-light region already consumes 36px more than the
  // 44px activity rail, so subtract that difference from the panel header.
  const rightDockWidth = rightPanelEnabled && isRightDockPinned ? ACTIVITY_BAR_WIDTH : 0
  // When the right panel is hidden, edge controls still occupy the end of the
  // header: the system window controls on Windows/Linux or the right-sidebar
  // toggle on macOS. Keep the view controls to their left.
  const leftPanelHeaderCssWidth = isMac
    ? `max(0px, calc(var(--amby-left-panel-width, ${leftTreeWidth}px) - ${80 - ACTIVITY_BAR_WIDTH}px))`
    : `var(--amby-left-panel-width, ${leftTreeWidth}px)`
  const rightHeaderInsetCss =
    rightPanelEnabled && isRightSidebarOpen && isRightDockPinned
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
    <motion.button
      type="button"
      onClick={onToggleLeftSidebar}
      onMouseDown={(e) => e.stopPropagation()}
      title={isLeftSidebarOpen ? t("tabs.closeLeftSidebar") : t("tabs.openLeftSidebar")}
      className={HEADER_ICON_BTN}
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.92 }}
      transition={motionTransitions.fast}
    >
      {isLeftSidebarOpen ? (
        <PanelLeftClose className="size-4" />
      ) : (
        <PanelLeftOpen className="size-4 text-foreground" />
      )}
    </motion.button>,
    "left",
    isLeftSidebarOpen,
    isLeftDockPinned,
    onToggleLeftSidebar,
    onSetLeftDockPinned,
  )

  const rightSidebarToggle = withVisibilityMenu(
    <motion.button
      type="button"
      onClick={onToggleRightSidebar}
      onMouseDown={(e) => e.stopPropagation()}
      title={isRightSidebarOpen ? t("tabs.closeRightSidebar") : t("tabs.openRightSidebar")}
      className={HEADER_ICON_BTN}
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.92 }}
      transition={motionTransitions.fast}
    >
      {isRightSidebarOpen ? (
        <PanelRightClose className="size-4" />
      ) : (
        <PanelRightOpen className="size-4 text-foreground" />
      )}
    </motion.button>,
    "right",
    isRightSidebarOpen,
    isRightDockPinned,
    onToggleRightSidebar,
    onSetRightDockPinned,
  )

  const viewControls = hideCenterStrip ? null : (
    <div
      className="absolute top-1.5 z-10 flex items-center gap-1"
      style={{ right: rightHeaderInsetCss }}
    >
      {onToggleSplit && (
        <motion.button
          type="button"
          title={t("tabs.splitEditor")}
          aria-label={t("tabs.splitEditor")}
          aria-pressed={isSplit}
          onClick={onToggleSplit}
          className={cn(HEADER_ICON_BTN, isSplit && "bg-accent text-foreground")}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          transition={motionTransitions.fast}
        >
          <Columns2 className="size-4" />
        </motion.button>
      )}
      <TabsMenu
        trigger={
          <motion.button
            type="button"
            title={t("tabs.tabMenu")}
            className={HEADER_ICON_BTN}
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.92 }}
            transition={motionTransitions.fast}
          >
            <ChevronDown className="size-4" />
          </motion.button>
        }
        tabs={tabs}
        activeTabKey={activeTabKey}
        activeFileId={activeFileId}
        favorites={favorites}
        onTabChange={onTabChange}
        onToggleFavorite={onToggleFavorite}
        onCloseAllTabs={onCloseAllTabs}
        onCloseOtherTabs={
          onCloseOtherTabs && activeTabKey ? () => onCloseOtherTabs(activeTabKey) : undefined
        }
        onSplitRight={onSplitRight ? () => onSplitRight(activeTabKey) : undefined}
        onSplitDown={onSplitDown ? () => onSplitDown(activeTabKey) : undefined}
        onUnsplitAll={isSplit ? onUnsplitAll : undefined}
      />
    </div>
  )

  return (
    <header
      className={cn(
        "relative z-50 flex h-11 select-none items-stretch",
        hideCenterStrip ? "pointer-events-none bg-transparent" : "bg-background",
      )}
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
        <div
          className="pointer-events-auto w-[80px] shrink-0 bg-background"
          onMouseDown={handleDragStart}
        />
      ) : (
        /* Windows: the left toggle is aligned with the left activity rail. */
        <div
          className="pointer-events-auto flex w-12 shrink-0 items-center justify-center bg-background"
          onMouseDown={handleDragStart}
        >
          {leftSidebarToggle}
        </div>
      )}

      {/* Workspace switcher (left panel header column, only when panel open) */}
      {isLeftSidebarOpen && (
        <div
          className="pointer-events-auto flex shrink-0 items-center bg-background"
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
                onManage={onManageVaults}
              >
                <motion.button
                  type="button"
                  title={t("vaultPicker.vaults")}
                  className="flex min-w-0 items-center gap-2 rounded px-2 py-1 text-left outline-none hover:bg-accent"
                  onMouseDown={(e) => e.stopPropagation()}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  transition={motionTransitions.fast}
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
                </motion.button>
              </WorkspacePicker>
            )}
          </div>
        </div>
      )}

      {/* Editor area (flex-1). Tabs share the width and shrink with the window;
          the strip ends right where the view-controls cluster begins. */}
      {hideCenterStrip ? (
        <div className="pointer-events-none flex min-w-0 flex-1" />
      ) : (
        <div
          data-pane-tab-bar={paneId}
          className={cn(
            "pointer-events-auto flex min-w-0 flex-1 items-center gap-1 overflow-hidden pr-1",
            isMac
              ? isLeftSidebarOpen && isLeftDockPinned
                ? "pl-0"
                : "pl-9"
              : isLeftSidebarOpen
                ? "pl-0"
                : "pl-0",
          )}
        >
          <div className="flex h-full min-w-0 max-w-full items-center gap-1 overflow-hidden shrink">
            <AnimatePresence initial={false}>
              {tabs.map((tab, index) => {
                const isSelected = activeTabKey === tab.key
                const nextTab = tabs[index + 1]
                const isNextSelected = nextTab && activeTabKey === nextTab.key
                const showDivider = !isSelected && index < tabs.length - 1 && !isNextSelected

                return (
                  <TabItem
                    key={tab.key}
                    tab={tab}
                    paneId={paneId}
                    isSelected={isSelected}
                    isUnsaved={unsavedFileIds?.has(tab.fileId)}
                    showDivider={showDivider}
                    totalTabsInPane={tabs.length}
                    onTabChange={onTabChange}
                    onTabClose={onTabClose}
                    onCloseOtherTabs={onCloseOtherTabs}
                    onCloseAllTabs={onCloseAllTabs}
                    onSplitRight={onSplitRight}
                    onSplitDown={onSplitDown}
                  />
                )
              })}
            </AnimatePresence>
          </div>

          <motion.button
            type="button"
            title={t("tabs.newTab")}
            data-spotlight-origin="new-tab"
            onClick={onOpenPlusModal}
            className={HEADER_ICON_BTN}
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.92 }}
            transition={motionTransitions.fast}
          >
            <Plus className="size-4" />
          </motion.button>

          <div className="h-full flex-1 cursor-default" onMouseDown={handleEmptySpaceMouseDown} />
        </div>
      )}

      {/* View controls cluster — kept in the flex flow, so the editor strip
          (tabs + plus) ends exactly at its left edge. It still lands on the
          panel divider because the window controls below are absolutely
          positioned and don't consume flow width. */}
      {viewControls}

      {/* Sidebar toggles are window-edge controls: unlike panel content they
          never move when a sidebar opens, closes, or is resized. */}
      {isMac && (
        <div className="pointer-events-auto absolute left-[80px] top-1.5 z-20">
          {leftSidebarToggle}
        </div>
      )}
      {/* Match the exact body dock width. This keeps the right toggle attached
          to the panel divider and prevents the large jump when it is closed. */}
      <div
        style={{
          width:
            rightPanelEnabled && isRightSidebarOpen && isRightDockPinned
              ? `calc(var(--amby-right-panel-width, ${rightPanelWidth}px) + ${rightDockWidth}px)`
              : isMac
                ? 0
                : rightDockWidth,
        }}
        className="pointer-events-auto shrink-0 bg-background"
        onMouseDown={handleDragStart}
      />

      {/* macOS: right panel toggle in the former logo position */}
      {isMac && rightPanelEnabled && (
        <div
          className="pointer-events-auto flex w-11 shrink-0 items-center justify-center bg-background"
          onMouseDown={handleDragStart}
        >
          {rightSidebarToggle}
        </div>
      )}

      {/* Windows: the right toggle stays immediately before the native-style
          controls instead of jumping to the opposite side of the header. */}
      {!isMac && (
        <div className="amby-window-controls pointer-events-auto absolute right-0 top-0 flex h-11 w-48 items-center justify-end bg-background">
          {rightPanelEnabled && (
            <div className="flex h-11 w-12 shrink-0 items-center justify-center">
              {rightSidebarToggle}
            </div>
          )}
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
