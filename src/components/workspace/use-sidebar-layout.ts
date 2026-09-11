import * as React from "react"
import { useActivityDnD } from "./use-activity-dnd"
import type { ActionContext, PanelId, Side } from "./panel-registry"
import type { ActivityButton } from "./panel-registry"
import { findButtonDef } from "./panel-definitions"
import { isTauri } from "@/lib/storage"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  DEFAULT_PANEL_WIDTH,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  type DockPreferences,
  type WindowPreferences,
} from "./app-config"

const COMPACT_LAYOUT_MAX_WIDTH = 960
const SIDEBAR_HIDE_DELAY_MS = 280

interface UseSidebarLayoutParams {
  activityButtons: ActivityButton[]
  setActivityButtons: React.Dispatch<React.SetStateAction<ActivityButton[]>>
  activeBySide: Record<Side, PanelId | null>
  setActiveBySide: React.Dispatch<React.SetStateAction<Record<Side, PanelId | null>>>
  /** Action handlers invoked when an activity-bar *action* button is clicked. */
  actionContext: ActionContext
  dockPrefs: DockPreferences
  onDockPrefsChange: (patch: Partial<DockPreferences>) => void
  windowPrefs: WindowPreferences
  onWindowPrefsChange: (patch: Partial<WindowPreferences>) => void
}

/**
 * Sidebar + activity-bar layout: open/closed state, panel widths, drag-resize,
 * focus mode, and the activity-bar button move/reorder/activate logic.
 *
 * Owns the panel layout state; the button *registry* (activityButtons /
 * activeBySide) lives in usePresets and is passed in so preset switching and
 * this hook stay in sync.
 */
export function useSidebarLayout({
  activityButtons,
  setActivityButtons,
  activeBySide,
  setActiveBySide,
  actionContext,
  dockPrefs,
  onDockPrefsChange,
  windowPrefs,
  onWindowPrefsChange,
}: UseSidebarLayoutParams) {
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = React.useState(true)
  const [isRightSidebarOpen, setIsRightSidebarOpen] = React.useState(true)
  // The panels have the same minimum/default width, but their current widths
  // and resize gestures are intentionally independent.
  const [leftWidth, setLeftWidth] = React.useState(windowPrefs.leftPanelWidth)
  const [rightWidth, setRightWidth] = React.useState(windowPrefs.rightPanelWidth)
  const [isLeftSidebarHover, setIsLeftSidebarHover] = React.useState(false)
  const [isRightSidebarHover, setIsRightSidebarHover] = React.useState(false)
  const [isFocusMode, setIsFocusMode] = React.useState(false)
  const [focusShowLeft, setFocusShowLeft] = React.useState(false)
  const [focusShowRight, setFocusShowRight] = React.useState(false)
  const [focusShowTop, setFocusShowTop] = React.useState(false)
  const [isCompactLayout, setIsCompactLayout] = React.useState(
    () => typeof window !== "undefined" && window.innerWidth < COMPACT_LAYOUT_MAX_WIDTH,
  )
  const preFocusSidebars = React.useRef<{ left: boolean; right: boolean } | null>(null)
  const wasCompactLayout = React.useRef(false)
  const hideTimersRef = React.useRef<Record<Side, ReturnType<typeof setTimeout> | null>>({
    left: null,
    right: null,
  })

  const clearHideTimer = React.useCallback((side: Side) => {
    const timer = hideTimersRef.current[side]
    if (timer) clearTimeout(timer)
    hideTimersRef.current[side] = null
  }, [])

  React.useEffect(
    () => () => {
      clearHideTimer("left")
      clearHideTimer("right")
    },
    [clearHideTimer],
  )

  // Resize drags update the CSS variables and the panel width state together.
  // The frame guard keeps updates aligned with the browser's paint loop while
  // Motion uses the state value for the panel's animated outer boundary.
  const setPanelWidthVariable = React.useCallback((side: "left" | "right", width: number) => {
    if (typeof document === "undefined") return
    document.documentElement.style.setProperty(`--amby-${side}-panel-width`, `${width}px`)
  }, [])

  React.useLayoutEffect(() => {
    setPanelWidthVariable("left", leftWidth)
  }, [leftWidth, setPanelWidthVariable])

  React.useLayoutEffect(() => {
    setPanelWidthVariable("right", rightWidth)
  }, [rightWidth, setPanelWidthVariable])

  React.useEffect(
    () => () => {
      if (typeof document === "undefined") return
      document.documentElement.style.removeProperty("--amby-left-panel-width")
      document.documentElement.style.removeProperty("--amby-right-panel-width")
    },
    [],
  )

  React.useEffect(() => {
    function updateLayoutMode() {
      const compact = window.innerWidth < COMPACT_LAYOUT_MAX_WIDTH
      setIsCompactLayout(compact)
      if (compact && !wasCompactLayout.current) {
        setIsLeftSidebarOpen(false)
        setIsRightSidebarOpen(false)
      }
      wasCompactLayout.current = compact
    }

    updateLayoutMode()
    window.addEventListener("resize", updateLayoutMode)
    return () => window.removeEventListener("resize", updateLayoutMode)
  }, [])

  function startResize(side: "left" | "right") {
    return (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = side === "left" ? leftWidth : rightWidth
      const setWidth = side === "left" ? setLeftWidth : setRightWidth
      const sign = side === "left" ? 1 : -1

      function nearEdge(x: number) {
        // 48px activity bar + 20px threshold inside the panel.
        return side === "left" ? x < 48 + 20 : x > window.innerWidth - 48 - 20
      }

      // Coalesce mousemove updates to one style write per animation frame so the
      // drag remains in sync with the browser's paint loop.
      let frame = 0
      let pendingW = startW

      function onMove(ev: MouseEvent) {
        if (nearEdge(ev.clientX)) return
        pendingW = Math.max(
          PANEL_WIDTH_MIN,
          Math.min(PANEL_WIDTH_MAX, startW + sign * (ev.clientX - startX)),
        )
        if (frame) return
        frame = requestAnimationFrame(() => {
          frame = 0
          setPanelWidthVariable(side, pendingW)
          setWidth(pendingW)
        })
      }

      function onUp(ev: MouseEvent) {
        if (frame) {
          cancelAnimationFrame(frame)
          frame = 0
        }
        if (nearEdge(ev.clientX)) {
          setPanelWidthVariable(side, DEFAULT_PANEL_WIDTH)
          setWidth(DEFAULT_PANEL_WIDTH)
          onWindowPrefsChange({
            [side === "left" ? "leftPanelWidth" : "rightPanelWidth"]: DEFAULT_PANEL_WIDTH,
          })
          if (side === "left") setIsLeftSidebarOpen(false)
          else setIsRightSidebarOpen(false)
        } else {
          setPanelWidthVariable(side, pendingW)
          setWidth(pendingW)
          onWindowPrefsChange({
            [side === "left" ? "leftPanelWidth" : "rightPanelWidth"]: pendingW,
          })
        }
        window.removeEventListener("mousemove", onMove)
        window.removeEventListener("mouseup", onUp)
      }

      window.addEventListener("mousemove", onMove)
      window.addEventListener("mouseup", onUp)
    }
  }

  const handleEnterFocusMode = React.useCallback(async () => {
    preFocusSidebars.current = { left: isLeftSidebarOpen, right: isRightSidebarOpen }
    setIsLeftSidebarOpen(false)
    setIsRightSidebarOpen(false)
    setFocusShowTop(false)
    setIsFocusMode(true)
    if (isTauri())
      await getCurrentWindow()
        .setFullscreen(true)
        .catch(() => {})
  }, [isLeftSidebarOpen, isRightSidebarOpen])

  const handleExitFocusMode = React.useCallback(async () => {
    setIsFocusMode(false)
    setFocusShowLeft(false)
    setFocusShowRight(false)
    setFocusShowTop(false)
    if (preFocusSidebars.current) {
      setIsLeftSidebarOpen(preFocusSidebars.current.left)
      setIsRightSidebarOpen(preFocusSidebars.current.right)
      preFocusSidebars.current = null
    }
    if (isTauri())
      await getCurrentWindow()
        .setFullscreen(false)
        .catch(() => {})
  }, [])

  // Move a button to the opposite side (appended to that side's end).
  function moveButtonToSide(defId: string, targetSide: Side) {
    setActivityButtons((prev) => {
      const button = prev.find((b) => b.defId === defId)
      if (!button) return prev
      if (button.side === targetSide) return prev
      const movingKind = findButtonDef(defId)?.kind
      const targetOrders = prev
        .filter(
          (candidate) =>
            candidate.side === targetSide && findButtonDef(candidate.defId)?.kind === movingKind,
        )
        .map((candidate) => candidate.order)
      const nextOrder = targetOrders.length ? Math.max(...targetOrders) + 1 : 0
      return prev.map((b) => (b.defId === defId ? { ...b, side: targetSide, order: nextOrder } : b))
    })
    setActiveBySide((prev) => {
      const next = { ...prev }
      // If this view was active on its old side, fall back.
      const def = findButtonDef(defId)
      if (def?.kind === "view") {
        const otherSide: Side = targetSide === "left" ? "right" : "left"
        if (prev[otherSide] === defId) {
          const remaining = activityButtons
            .filter((b) => b.side === otherSide && b.defId !== defId)
            .sort((a, b) => a.order - b.order)
          const firstView = remaining.find((b) => findButtonDef(b.defId)?.kind === "view")
          next[otherSide] = (firstView?.defId as PanelId | undefined) ?? null
        }
        // Optionally make the moved view active on its new side.
        next[targetSide] = def.id
      }
      return next
    })
  }

  // Drop handler: place defId on `targetSide` before `beforeDefId` (or at end).
  function reorderButton(defId: string, targetSide: Side, beforeDefId: string | "__end__") {
    setActivityButtons((prev) => {
      const moving = prev.find((b) => b.defId === defId)
      if (!moving) return prev
      const movingKind = findButtonDef(defId)?.kind
      // Build the target-side list without the moving button, sorted by current order.
      const others = prev
        .filter(
          (button) =>
            button.side === targetSide &&
            button.defId !== defId &&
            findButtonDef(button.defId)?.kind === movingKind,
        )
        .sort((a, b) => a.order - b.order)
      let insertAt = others.length
      if (beforeDefId !== "__end__") {
        const idx = others.findIndex((b) => b.defId === beforeDefId)
        if (idx >= 0) insertAt = idx
      }
      const reorderedTarget = [
        ...others.slice(0, insertAt),
        { ...moving, side: targetSide },
        ...others.slice(insertAt),
      ].map((b, i) => ({ ...b, order: i }))
      const untouched = prev.filter(
        (button) =>
          button.defId !== defId &&
          !(button.side === targetSide && findButtonDef(button.defId)?.kind === movingKind),
      )
      return [...untouched, ...reorderedTarget]
    })
    // Cross-side fallback for active view
    const movingDef = findButtonDef(defId)
    if (movingDef?.kind === "view") {
      const oldSide: Side = activityButtons.find((b) => b.defId === defId)?.side ?? targetSide
      if (oldSide !== targetSide) {
        setActiveBySide((prev) => {
          const next = { ...prev }
          if (prev[oldSide] === defId) {
            const remaining = activityButtons
              .filter((b) => b.side === oldSide && b.defId !== defId)
              .sort((a, b) => a.order - b.order)
            const firstView = remaining.find((b) => findButtonDef(b.defId)?.kind === "view")
            next[oldSide] = (firstView?.defId as PanelId | undefined) ?? null
          }
          next[targetSide] = movingDef.id as PanelId
          return next
        })
      }
    }
  }

  const zoneForButton = React.useCallback(
    (defId: string): "view" | "action" => findButtonDef(defId)?.kind ?? "view",
    [],
  )
  const dnd = useActivityDnD({ onDrop: reorderButton, zoneForButton })
  const setSidebarHover = React.useCallback(
    (side: Side, hovering: boolean) => {
      clearHideTimer(side)
      if (hovering) {
        if (side === "left") setIsLeftSidebarHover(true)
        else setIsRightSidebarHover(true)
        return
      }
      hideTimersRef.current[side] = setTimeout(() => {
        hideTimersRef.current[side] = null
        if (side === "left") setIsLeftSidebarHover(false)
        else setIsRightSidebarHover(false)
      }, SIDEBAR_HIDE_DELAY_MS)
    },
    [clearHideTimer],
  )

  const hideSidebarHoverNow = React.useCallback(
    (side: Side) => {
      clearHideTimer(side)
      if (side === "left") setIsLeftSidebarHover(false)
      else setIsRightSidebarHover(false)
    },
    [clearHideTimer],
  )

  function handleActivate(defId: string) {
    const def = findButtonDef(defId)
    if (!def) return
    if (def.kind === "action") {
      def.invoke?.(actionContext)
      return
    }
    const button = activityButtons.find((b) => b.defId === defId)
    if (!button) return
    const side = button.side
    const isOpen = side === "left" ? isLeftSidebarOpen : isRightSidebarOpen
    const setOpen = side === "left" ? setIsLeftSidebarOpen : setIsRightSidebarOpen
    const isVisible =
      side === "left"
        ? isOpen && (dockPrefs.leftPinned || isLeftSidebarHover)
        : isOpen && (dockPrefs.rightPinned || isRightSidebarHover)
    // Click on already-active view collapses the panel.
    if (isVisible && activeBySide[side] === def.id) {
      setOpen(false)
      hideSidebarHoverNow(side)
      return
    }
    setActiveBySide((prev) => ({ ...prev, [side]: def.id }))
    setOpen(true)
    if (!dockPrefs[side === "left" ? "leftPinned" : "rightPinned"]) {
      setSidebarHover(side, true)
    }
  }

  function activatePanelAnywhere(panelId: PanelId) {
    const button = activityButtons.find((b) => b.defId === panelId)
    if (!button) return
    if (button.side === "left") setIsLeftSidebarOpen(true)
    else setIsRightSidebarOpen(true)
    if (!dockPrefs[button.side === "left" ? "leftPinned" : "rightPinned"])
      setSidebarHover(button.side, true)
    setActiveBySide((prev) => ({ ...prev, [button.side]: panelId }))
  }

  const isDockPinned = React.useCallback(
    (side: Side) => dockPrefs[side === "left" ? "leftPinned" : "rightPinned"],
    [dockPrefs],
  )

  const setDockPinned = React.useCallback(
    (side: Side, pinned: boolean) => {
      onDockPrefsChange({ [side === "left" ? "leftPinned" : "rightPinned"]: pinned })
      if (!pinned) {
        hideSidebarHoverNow(side)
      }
    },
    [hideSidebarHoverNow, onDockPrefsChange],
  )

  // An unpinned panel is edge-triggered even after the user explicitly hid it
  // from the context menu. `isSidebarOpen` remains the manual/header state,
  // while hover is the source of truth for the temporary overlay visibility.
  const isLeftSidebarVisible = isDockPinned("left") ? isLeftSidebarOpen : isLeftSidebarHover
  const isRightSidebarVisible = isDockPinned("right") ? isRightSidebarOpen : isRightSidebarHover

  const toggleSidebar = React.useCallback(
    (side: Side) => {
      const open = side === "left" ? isLeftSidebarOpen : isRightSidebarOpen
      const visible = side === "left" ? isLeftSidebarVisible : isRightSidebarVisible
      const pinned = isDockPinned(side)
      const setOpen = side === "left" ? setIsLeftSidebarOpen : setIsRightSidebarOpen
      if (!open || (!pinned && !visible)) {
        setOpen(true)
        if (!pinned) setSidebarHover(side, true)
        return
      }
      setOpen(false)
      hideSidebarHoverNow(side)
    },
    [
      isDockPinned,
      isLeftSidebarOpen,
      isLeftSidebarVisible,
      isRightSidebarOpen,
      isRightSidebarVisible,
      hideSidebarHoverNow,
      setSidebarHover,
    ],
  )

  return {
    isLeftSidebarOpen,
    setIsLeftSidebarOpen,
    isRightSidebarOpen,
    setIsRightSidebarOpen,
    isLeftSidebarVisible,
    isRightSidebarVisible,
    setSidebarHover,
    toggleSidebar,
    leftWidth,
    rightWidth,
    startResize,
    isFocusMode,
    isCompactLayout,
    focusShowLeft,
    setFocusShowLeft,
    focusShowRight,
    setFocusShowRight,
    focusShowTop,
    setFocusShowTop,
    handleEnterFocusMode,
    handleExitFocusMode,
    moveButtonToSide,
    dnd,
    handleActivate,
    activatePanelAnywhere,
    isDockPinned,
    setDockPinned,
  }
}
