"use client"

import * as React from "react"
import { clearTreeDragPayload, getTreeDragPayload } from "@/lib/canvas-dnd"
import { detectPaneDropZone, type PaneDropZone, type SplitDirection } from "./split-tree"

export interface TabDragPayload {
  tabKey: string
  title: string
  sourcePaneId: string
  startX: number
  startY: number
}

export interface ActivePaneHoverTarget {
  paneId: string
  zone: PaneDropZone | "tabbar"
  tabIndex?: number
}

export interface ActiveTabDragState extends TabDragPayload {
  ghostX: number
  ghostY: number
  active: boolean
}

let pendingTabDrag: TabDragPayload | null = null
const listeners = new Set<() => void>()

export function beginTabPointerDown(payload: TabDragPayload): void {
  pendingTabDrag = payload
  for (const listener of listeners) listener()
}

export function subscribeTabDragStart(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getPendingTabDrag(): TabDragPayload | null {
  return pendingTabDrag
}

export function clearPendingTabDrag(): void {
  pendingTabDrag = null
}

function resolveHoverTarget(clientX: number, clientY: number): ActivePaneHoverTarget | null {
  const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null
  if (!el) return null

  const tabBarEl = el.closest("[data-pane-tab-bar]") as HTMLElement | null
  if (tabBarEl) {
    const paneId = tabBarEl.getAttribute("data-pane-tab-bar")
    if (paneId) {
      const tabEls = Array.from(tabBarEl.querySelectorAll<HTMLElement>("[data-tab-item-key]"))
      let tabIndex = tabEls.length
      for (let i = 0; i < tabEls.length; i += 1) {
        const rect = tabEls[i].getBoundingClientRect()
        if (clientX < rect.left + rect.width / 2) {
          tabIndex = i
          break
        }
      }
      return { paneId, zone: "tabbar", tabIndex }
    }
  }

  const paneEl = el.closest("[data-pane-id]") as HTMLElement | null
  if (!paneEl) return null
  const paneId = paneEl.getAttribute("data-pane-id")
  if (!paneId) return null

  const rect = paneEl.getBoundingClientRect()
  const zone = detectPaneDropZone(clientX, clientY, {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  })
  return { paneId, zone }
}

export function zoneToSplitParams(zone: Exclude<PaneDropZone, "center">): {
  direction: SplitDirection
  placement: "before" | "after"
} {
  switch (zone) {
    case "left":
      return { direction: "horizontal", placement: "before" }
    case "right":
      return { direction: "horizontal", placement: "after" }
    case "top":
      return { direction: "vertical", placement: "before" }
    case "bottom":
      return { direction: "vertical", placement: "after" }
  }
}

export function usePaneDnd({
  onDropTab,
  onDropTreeItem,
}: {
  onDropTab: (tabKey: string, sourcePaneId: string, target: ActivePaneHoverTarget) => void
  onDropTreeItem: (itemId: string, target: ActivePaneHoverTarget) => void
}) {
  const [tabDrag, setTabDrag] = React.useState<ActiveTabDragState | null>(null)
  const [hoverTarget, setHoverTarget] = React.useState<ActivePaneHoverTarget | null>(null)
  const tabDragRef = React.useRef<ActiveTabDragState | null>(null)
  const hoverTargetRef = React.useRef<ActivePaneHoverTarget | null>(null)
  const onDropTabRef = React.useRef(onDropTab)
  const onDropTreeItemRef = React.useRef(onDropTreeItem)

  React.useEffect(() => {
    tabDragRef.current = tabDrag
  }, [tabDrag])

  React.useEffect(() => {
    hoverTargetRef.current = hoverTarget
  }, [hoverTarget])

  React.useEffect(() => {
    onDropTabRef.current = onDropTab
  }, [onDropTab])

  React.useEffect(() => {
    onDropTreeItemRef.current = onDropTreeItem
  }, [onDropTreeItem])

  React.useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      const pending = getPendingTabDrag()
      const currentTabDrag = tabDragRef.current
      const treePayload = getTreeDragPayload()

      if (!currentTabDrag && pending) {
        const dx = Math.abs(e.clientX - pending.startX)
        const dy = Math.abs(e.clientY - pending.startY)
        if (dx > 6 || dy > 6) {
          clearPendingTabDrag()
          const suppressClick = (ev: MouseEvent) => {
            ev.stopPropagation()
            ev.preventDefault()
            document.removeEventListener("click", suppressClick, true)
          }
          document.addEventListener("click", suppressClick, true)
          const started: ActiveTabDragState = {
            ...pending,
            ghostX: e.clientX,
            ghostY: e.clientY,
            active: true,
          }
          tabDragRef.current = started
          setTabDrag(started)
          const target = resolveHoverTarget(e.clientX, e.clientY)
          hoverTargetRef.current = target
          setHoverTarget(target)
        }
        return
      }

      if (currentTabDrag) {
        setTabDrag((prev) => (prev ? { ...prev, ghostX: e.clientX, ghostY: e.clientY } : null))
        const target = resolveHoverTarget(e.clientX, e.clientY)
        hoverTargetRef.current = target
        setHoverTarget(target)
        return
      }

      if (treePayload) {
        const target = resolveHoverTarget(e.clientX, e.clientY)
        if (
          target?.paneId !== hoverTargetRef.current?.paneId ||
          target?.zone !== hoverTargetRef.current?.zone ||
          target?.tabIndex !== hoverTargetRef.current?.tabIndex
        ) {
          hoverTargetRef.current = target
          setHoverTarget(target)
        }
      } else if (hoverTargetRef.current !== null) {
        hoverTargetRef.current = null
        setHoverTarget(null)
      }
    }

    function onPointerUp(e: PointerEvent) {
      clearPendingTabDrag()
      const currentTabDrag = tabDragRef.current
      const treePayload = getTreeDragPayload()
      const target = resolveHoverTarget(e.clientX, e.clientY) ?? hoverTargetRef.current

      if (currentTabDrag) {
        tabDragRef.current = null
        hoverTargetRef.current = null
        setTabDrag(null)
        setHoverTarget(null)
        if (target) {
          onDropTabRef.current(currentTabDrag.tabKey, currentTabDrag.sourcePaneId, target)
        }
        return
      }

      if (treePayload && target) {
        clearTreeDragPayload()
        hoverTargetRef.current = null
        setHoverTarget(null)
        onDropTreeItemRef.current(treePayload.id, target)
        return
      }

      if (hoverTargetRef.current) {
        hoverTargetRef.current = null
        setHoverTarget(null)
      }
    }

    document.addEventListener("pointermove", onPointerMove)
    document.addEventListener("pointerup", onPointerUp)
    return () => {
      document.removeEventListener("pointermove", onPointerMove)
      document.removeEventListener("pointerup", onPointerUp)
    }
  }, [])

  return {
    tabDrag,
    hoverTarget,
  }
}
