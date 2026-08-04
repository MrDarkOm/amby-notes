"use client"

import * as React from "react"

export interface DnDState {
  draggingId: string | null
}

export interface DropTarget {
  defId: string | "__end__"
  side: "left" | "right"
  zone: "view" | "action"
}

interface UseActivityDnDOptions {
  /** Move a button to (side, beforeDefId | "__end__"). */
  onDrop: (defId: string, side: "left" | "right", beforeDefId: string | "__end__") => void
  zoneForButton: (defId: string) => "view" | "action"
}

const DRAG_THRESHOLD = 4

/** Pointer-based DnD for activity bar buttons. Buttons must carry data-activity-button="<defId>"
 * and live inside an element with data-activity-bar="left|right". */
export function useActivityDnD({ onDrop, zoneForButton }: UseActivityDnDOptions) {
  const [draggingId, setDraggingId] = React.useState<string | null>(null)
  const ghostRef = React.useRef<HTMLDivElement | null>(null)

  const clearTargets = React.useCallback(() => {
    document.querySelectorAll<HTMLElement>("[data-drop-target='true']").forEach((el) => {
      el.removeAttribute("data-drop-target")
    })
  }, [])

  const startDrag = React.useCallback(
    (defId: string, fromEl: HTMLElement, startX: number, startY: number) => {
      let started = false
      let lastDrop: DropTarget | null = null
      const movingZone = zoneForButton(defId)

      function ensureGhost() {
        if (ghostRef.current) return ghostRef.current
        const ghost = fromEl.cloneNode(true) as HTMLDivElement
        ghost.classList.add("amby-activity-ghost")
        ghost.style.position = "fixed"
        ghost.style.left = "0"
        ghost.style.top = "0"
        ghost.style.pointerEvents = "none"
        ghost.style.zIndex = "9999"
        document.body.appendChild(ghost)
        ghostRef.current = ghost
        return ghost
      }

      function positionGhost(x: number, y: number) {
        const ghost = ghostRef.current
        if (!ghost) return
        ghost.style.transform = `translate(${x - 16}px, ${y - 16}px)`
      }

      function findDropTarget(x: number, y: number): DropTarget | null {
        const el = document.elementFromPoint(x, y)
        if (!el) return null
        const btn = el.closest<HTMLElement>("[data-activity-button]")
        if (btn) {
          const id = btn.getAttribute("data-activity-button") ?? ""
          const sideEl = btn.closest<HTMLElement>("[data-activity-bar]")
          const side = (sideEl?.getAttribute("data-activity-bar") ?? "left") as "left" | "right"
          const targetZone = btn.getAttribute("data-activity-zone")
          return targetZone === movingZone
            ? { defId: id, side, zone: movingZone }
            : { defId: "__end__", side, zone: movingZone }
        }
        const zone = el.closest<HTMLElement>("[data-activity-zone]")
        if (zone) {
          const bar = zone.closest<HTMLElement>("[data-activity-bar]")
          const side = (bar?.getAttribute("data-activity-bar") ?? "left") as "left" | "right"
          return { defId: "__end__", side, zone: movingZone }
        }
        const bar = el.closest<HTMLElement>("[data-activity-bar]")
        if (bar) {
          const side = (bar.getAttribute("data-activity-bar") ?? "left") as "left" | "right"
          return { defId: "__end__", side, zone: movingZone }
        }
        return null
      }

      function applyHighlight(target: DropTarget | null) {
        clearTargets()
        if (!target) return
        if (target.defId === "__end__") {
          const zone = document.querySelector<HTMLElement>(
            `[data-activity-bar='${target.side}'] [data-activity-zone='${target.zone}']`,
          )
          zone?.setAttribute("data-drop-target", "true")
          return
        }
        const btn = document.querySelector<HTMLElement>(`[data-activity-button='${target.defId}']`)
        btn?.setAttribute("data-drop-target", "true")
      }

      function onMove(ev: PointerEvent) {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (!started) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
          started = true
          ensureGhost()
          setDraggingId(defId)
          fromEl.setAttribute("data-dragging", "true")
        }
        positionGhost(ev.clientX, ev.clientY)
        lastDrop = findDropTarget(ev.clientX, ev.clientY)
        applyHighlight(lastDrop)
      }

      function onUp() {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        if (started && lastDrop && lastDrop.defId !== defId) {
          onDrop(defId, lastDrop.side, lastDrop.defId)
        }
        cleanup()
      }

      function cleanup() {
        const ghost = ghostRef.current
        if (ghost) {
          ghost.remove()
          ghostRef.current = null
        }
        fromEl.removeAttribute("data-dragging")
        clearTargets()
        setDraggingId(null)
      }

      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
    },
    [clearTargets, onDrop, zoneForButton],
  )

  const onPointerDown = React.useCallback(
    (defId: string) => (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      const el = e.currentTarget
      // Don't preventDefault here — let click fire when no drag occurred.
      startDrag(defId, el, e.clientX, e.clientY)
    },
    [startDrag],
  )

  return { draggingId, onPointerDown }
}
