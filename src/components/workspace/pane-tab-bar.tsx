"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { AnimatePresence, motion } from "motion/react"
import { ChevronDown, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { motionTransitions } from "@/lib/motion-config"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isTauri } from "@/lib/storage"
import { HEADER_ICON_BTN, TabItem, TabsMenu, type HeaderTab } from "./header-tabs"
import type { ActivePaneHoverTarget, ActiveTabDragState } from "./pane-dnd"
import type { LayoutLeafItem, LayoutSplitDivider, PaneEdgeFlags } from "./split-tree"

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)

export interface PaneTabBarProps {
  paneId: string
  tabs: HeaderTab[]
  activeTabKey: string
  activeFileId?: string
  isPaneFocused: boolean
  unsavedFileIds?: Set<string>
  favorites?: Set<string>
  edges: PaneEdgeFlags
  isLeftSidebarOpen: boolean
  isLeftDockPinned: boolean
  isRightSidebarOpen: boolean
  isRightDockPinned: boolean
  rightPanelEnabled: boolean
  onFocusPane: () => void
  onTabChange: (tabKey: string) => void
  onTabClose: (tabKey: string) => void
  onCloseOtherTabs: (tabKey: string) => void
  onCloseAllTabs: () => void
  onClosePane: () => void
  onSplitRight: (tabKey?: string) => void
  onSplitDown: (tabKey?: string) => void
  onUnsplitAll: () => void
  onOpenPlusModal: () => void
  onToggleFavorite?: (fileId: string) => void
}

export function PaneTabBar({
  paneId,
  tabs,
  activeTabKey,
  activeFileId,
  isPaneFocused,
  unsavedFileIds,
  favorites,
  edges,
  isLeftSidebarOpen,
  isLeftDockPinned,
  isRightSidebarOpen,
  isRightDockPinned,
  rightPanelEnabled,
  onFocusPane,
  onTabChange,
  onTabClose,
  onCloseOtherTabs,
  onCloseAllTabs,
  onClosePane,
  onSplitRight,
  onSplitDown,
  onUnsplitAll,
  onOpenPlusModal,
  onToggleFavorite,
}: PaneTabBarProps) {
  const { t } = useTranslation()
  const lastClickTimeRef = React.useRef(0)

  function handleEmptySpaceMouseDown(e: React.MouseEvent) {
    onFocusPane()
    if (!edges.top || e.button !== 0 || !isTauri()) return
    if ((e.target as HTMLElement).closest("button, a, input, select, [role='button']")) return
    e.preventDefault()
    const now = Date.now()
    const since = now - lastClickTimeRef.current
    lastClickTimeRef.current = now
    if (since < 300) {
      lastClickTimeRef.current = 0
      getCurrentWindow()
        .toggleMaximize()
        .catch(() => {})
    } else {
      getCurrentWindow()
        .startDragging()
        .catch(() => {})
    }
  }

  // Top-left and top-right panes share the top 44px row with the window's sidebar toggles / native controls
  const leftInsetClass =
    edges.top && edges.left
      ? isMac
        ? isLeftSidebarOpen && isLeftDockPinned
          ? ""
          : isLeftDockPinned
            ? "pl-[72px]"
            : "pl-28"
        : !isLeftDockPinned
          ? "pl-12"
          : ""
      : ""
  const rightInsetClass =
    edges.top && edges.right
      ? isMac
        ? rightPanelEnabled && !isRightDockPinned
          ? "pr-11"
          : ""
        : !(rightPanelEnabled && isRightSidebarOpen && isRightDockPinned)
          ? "pr-48"
          : ""
      : ""

  return (
    <div
      data-pane-tab-bar={paneId}
      data-pane-edge-aligned={!leftInsetClass || undefined}
      onPointerDown={onFocusPane}
      className={cn(
        "relative flex h-11 shrink-0 select-none items-center gap-1 overflow-hidden px-0",
        leftInsetClass,
        rightInsetClass,
      )}
    >
      <div className="flex h-full min-w-0 max-w-full shrink items-center gap-1 overflow-hidden">
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
                layoutGroupId={`activePaneTabPill-${paneId}`}
                isSelected={isSelected}
                isPaneFocused={isPaneFocused}
                isUnsaved={unsavedFileIds?.has(tab.fileId)}
                showDivider={showDivider}
                totalTabsInPane={tabs.length}
                onTabChange={onTabChange}
                onTabClose={onTabClose}
                onCloseOtherTabs={onCloseOtherTabs}
                onCloseAllTabs={onCloseAllTabs}
                onClosePane={onClosePane}
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
        data-spotlight-origin={isPaneFocused ? "new-tab" : undefined}
        onClick={(e) => {
          e.stopPropagation()
          onFocusPane()
          onOpenPlusModal()
        }}
        className={HEADER_ICON_BTN}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.92 }}
        transition={motionTransitions.fast}
      >
        <Plus className="size-4" />
      </motion.button>

      <div className="h-full flex-1 cursor-default" onMouseDown={handleEmptySpaceMouseDown} />

      <div className="flex shrink-0 items-center gap-0.5">
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
          onCloseOtherTabs={activeTabKey ? () => onCloseOtherTabs(activeTabKey) : undefined}
          onClosePane={onClosePane}
          onCloseAllTabs={onCloseAllTabs}
          onSplitRight={() => onSplitRight(activeTabKey)}
          onSplitDown={() => onSplitDown(activeTabKey)}
          onUnsplitAll={onUnsplitAll}
        />
      </div>
    </div>
  )
}

export function SplitResizeHandle({
  divider,
  containerRef,
  onResize,
}: {
  divider: LayoutSplitDivider
  containerRef: React.RefObject<HTMLElement | null>
  onResize: (splitId: string, ratio: number) => void
}) {
  const [resizing, setResizing] = React.useState(false)
  const isHorizontal = divider.direction === "horizontal"
  const topInsetPx = isHorizontal && divider.crossStart <= 0.01 ? 44 : 0
  const bottomInsetPx = isHorizontal && divider.crossStart + divider.crossLength >= 99.9 ? 8 : 0

  function handlePointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    setResizing(true)

    const onMove = (moveEvent: PointerEvent) => {
      if (isHorizontal) {
        const boundsLeft = rect.left + (divider.parentRect.x / 100) * rect.width
        const boundsWidth = (divider.parentRect.w / 100) * rect.width
        if (boundsWidth <= 0) return
        const ratio = (moveEvent.clientX - boundsLeft) / boundsWidth
        onResize(divider.splitId, ratio)
      } else {
        const boundsTop = rect.top + (divider.parentRect.y / 100) * rect.height
        const boundsHeight = (divider.parentRect.h / 100) * rect.height
        if (boundsHeight <= 0) return
        const ratio = (moveEvent.clientY - boundsTop) / boundsHeight
        onResize(divider.splitId, ratio)
      }
    }

    const onUp = () => {
      setResizing(false)
      document.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerup", onUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }

    document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize"
    document.body.style.userSelect = "none"
    document.addEventListener("pointermove", onMove)
    document.addEventListener("pointerup", onUp)
  }

  return (
    <div
      role="separator"
      aria-orientation={isHorizontal ? "vertical" : "horizontal"}
      data-resizing={resizing ? "true" : undefined}
      onPointerDown={handlePointerDown}
      onDoubleClick={() => onResize(divider.splitId, 0.5)}
      style={
        isHorizontal
          ? {
              left: `${divider.position}%`,
              top: topInsetPx
                ? `calc(${divider.crossStart}% + ${topInsetPx}px)`
                : `${divider.crossStart}%`,
              height:
                topInsetPx + bottomInsetPx > 0
                  ? `calc(${divider.crossLength}% - ${topInsetPx + bottomInsetPx}px)`
                  : `${divider.crossLength}%`,
              width: "8px",
              transform: "translateX(-50%)",
            }
          : {
              left: `${divider.crossStart}%`,
              top: `calc(${divider.position}% - 4px)`,
              width: `${divider.crossLength}%`,
              height: "8px",
              transform: "translateY(-50%)",
            }
      }
      className={cn(
        "amby-resize-handle absolute z-30 flex items-center justify-center",
        isHorizontal ? "cursor-col-resize" : "cursor-row-resize",
      )}
    >
      <div
        className={cn("amby-resize-handle-line", isHorizontal ? "h-full w-0.5" : "h-0.5 w-full")}
      />
    </div>
  )
}

/**
 * Where the insertion line goes while a tab is dragged over a tab strip: in the gap before the
 * tab at `tabIndex` (after the last one when the index is past the end). Null when the drop
 * would leave the dragged tab where it is, so the line only shows for a real move.
 */
function tabSlotLine(
  target: ActivePaneHoverTarget,
  drag: ActiveTabDragState,
): { left: number; top: number; height: number } | null {
  const bar = document.querySelector<HTMLElement>(
    `[data-pane-tab-bar="${CSS.escape(target.paneId)}"]`,
  )
  if (!bar) return null
  const tabEls = Array.from(bar.querySelectorAll<HTMLElement>("[data-tab-item-key]"))
  if (tabEls.length === 0) return null
  const slot = Math.max(0, Math.min(tabEls.length, target.tabIndex ?? tabEls.length))
  const from = tabEls.findIndex((el) => el.dataset.tabItemKey === drag.tabKey)
  if (from !== -1 && (slot === from || slot === from + 1)) return null

  const before = tabEls[slot]?.getBoundingClientRect()
  const last = tabEls[tabEls.length - 1].getBoundingClientRect()
  const left = before ? before.left - 3 : last.right + 1
  const rect = before ?? last
  return { left, top: rect.top + 4, height: rect.height - 8 }
}

export function PaneDropOverlay({
  hoverTarget,
  leaves,
  tabDrag,
}: {
  hoverTarget: ActivePaneHoverTarget | null
  leaves: LayoutLeafItem[]
  tabDrag: ActiveTabDragState | null
}) {
  const targetLeaf = hoverTarget ? leaves.find((l) => l.leaf.id === hoverTarget.paneId) : null

  let previewRect: { left: string; top: string; width: string; height: string } | null = null
  if (targetLeaf && hoverTarget) {
    const { x, y, w, h } = targetLeaf.rect
    switch (hoverTarget.zone) {
      case "left":
        previewRect = { left: `${x}%`, top: `${y}%`, width: `${w / 2}%`, height: `${h}%` }
        break
      case "right":
        previewRect = {
          left: `${x + w / 2}%`,
          top: `${y}%`,
          width: `${w / 2}%`,
          height: `${h}%`,
        }
        break
      case "top":
        previewRect = { left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h / 2}%` }
        break
      case "bottom":
        previewRect = {
          left: `${x}%`,
          top: `${y + h / 2}%`,
          width: `${w}%`,
          height: `${h / 2}%`,
        }
        break
      case "center":
        previewRect = { left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` }
        break
      case "tabbar":
        // Dropping on the tab strip is a reorder: a line marks the slot instead (below).
        break
    }
  }

  const slotLine =
    tabDrag?.active && hoverTarget?.zone === "tabbar" ? tabSlotLine(hoverTarget, tabDrag) : null

  return (
    <>
      {previewRect && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, ...previewRect }}
          transition={motionTransitions.fast}
          style={previewRect}
          className="pointer-events-none absolute z-40 p-1.5"
        >
          <div className="h-full w-full rounded-xl border-2 border-primary/60 bg-primary/15 backdrop-blur-[1px]" />
        </motion.div>
      )}
      {slotLine && (
        <div
          aria-hidden="true"
          style={slotLine}
          className="pointer-events-none fixed z-[100] w-0.5 rounded-full bg-primary"
        />
      )}
      {tabDrag?.active && (
        <div
          style={{
            left: tabDrag.ghostX + 12,
            top: tabDrag.ghostY + 12,
          }}
          className="pointer-events-none fixed z-[100] flex max-w-52 items-center gap-1.5 rounded-lg border border-border bg-popover/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-xl backdrop-blur-sm"
        >
          <span className="truncate">{tabDrag.title}</span>
        </div>
      )}
    </>
  )
}
