"use client"

import * as React from "react"
import { animate, type AnimationPlaybackControls } from "motion/react"

import { motionTransition, motionTransitions } from "@/lib/motion-config"

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
  const placeholderRef = React.useRef<HTMLDivElement | null>(null)

  const clearTargets = React.useCallback(() => {
    document.querySelectorAll<HTMLElement>("[data-drop-target='true']").forEach((el) => {
      el.removeAttribute("data-drop-target")
    })
  }, [])

  const startDrag = React.useCallback(
    (defId: string, fromEl: HTMLElement, startX: number, startY: number) => {
      let started = false
      let dragEnded = false
      let lastDrop: DropTarget | null = null
      const movingZone = zoneForButton(defId)
      const originalDisplay = fromEl.style.display
      const sourceWrapper = fromEl.parentElement
      const originalWrapperDisplay = sourceWrapper?.style.display ?? ""
      const originalBodyUserSelect = document.body.style.userSelect
      const originalBodyCursor = document.body.style.cursor
      const originalButtonStyles = new Map<HTMLElement, { transform: string }>()
      const neighbourAnimations = new Map<HTMLElement, AnimationPlaybackControls>()
      let pointerFrame = 0
      let pendingPointer: { x: number; y: number } | null = null

      function activityButtons() {
        return Array.from(document.querySelectorAll<HTMLElement>("[data-activity-button]")).filter(
          (button) => !button.classList.contains("amby-activity-ghost"),
        )
      }

      function activityItems() {
        return activityButtons().map((button) => button.parentElement ?? button)
      }

      function rememberButtonStyles() {
        for (const item of activityItems()) {
          originalButtonStyles.set(item, {
            transform: item.style.transform,
          })
        }
      }

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

      function createPlaceholder() {
        if (placeholderRef.current) return placeholderRef.current
        const placeholder = document.createElement("div")
        placeholder.className = "amby-activity-drop-placeholder"
        placeholder.setAttribute("data-activity-drop-placeholder", "true")
        placeholder.style.pointerEvents = "none"
        placeholder.setAttribute("aria-hidden", "true")
        placeholderRef.current = placeholder

        // Remove the dragged button from the flex flow. The placeholder takes
        // its slot and can then move between buttons while the neighbours
        // animate into their new positions.
        const sourceZone = sourceWrapper?.closest<HTMLElement>("[data-activity-zone]")
        if (sourceWrapper) sourceWrapper.style.display = "none"
        sourceZone?.insertBefore(placeholder, sourceWrapper ?? null)
        return placeholder
      }

      function zoneForTarget(target: DropTarget) {
        return document.querySelector<HTMLElement>(
          `[data-activity-bar='${target.side}'] [data-activity-zone='${target.zone}']`,
        )
      }

      function visibleActivityZones() {
        return Array.from(document.querySelectorAll<HTMLElement>("[data-activity-zone]"))
          .map((zone) => {
            const bar = zone.closest<HTMLElement>("[data-activity-bar]")
            const side = bar?.getAttribute("data-activity-bar")
            const name = zone.getAttribute("data-activity-zone")
            const rect = zone.getBoundingClientRect()
            return side && name && rect.width > 0 && rect.height > 0
              ? { zone, side: side as "left" | "right", name, rect }
              : null
          })
          .filter(
            (
              entry,
            ): entry is {
              zone: HTMLElement
              side: "left" | "right"
              name: "view" | "action"
              rect: DOMRect
            } => entry !== null,
          )
      }

      function animateNeighbourShift(before: Map<HTMLElement, DOMRect>) {
        const items = activityItems()
        for (const item of items) {
          neighbourAnimations.get(item)?.stop()
          neighbourAnimations.delete(item)
          const original = originalButtonStyles.get(item)
          if (!original) continue
          item.style.transform = original.transform
        }

        // Force the browser to commit the marker's new position before the
        // inverted transforms are applied.
        const after = new Map(items.map((item) => [item, item.getBoundingClientRect()]))
        for (const item of items) {
          const oldRect = before.get(item)
          const newRect = after.get(item)
          const original = originalButtonStyles.get(item)
          if (!oldRect || !newRect || !original) continue
          const dx = oldRect.left - newRect.left
          const dy = oldRect.top - newRect.top
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
          const controls = animate(
            item,
            {
              transform: [
                `translate(${dx}px, ${dy}px)`,
                original.transform.length ? original.transform : "none",
              ],
            },
            motionTransition(motionTransitions.enter),
          )
          neighbourAnimations.set(item, controls)
          void controls.then(() => {
            if (neighbourAnimations.get(item) !== controls) return
            neighbourAnimations.delete(item)
            if (!dragEnded) item.style.transform = original.transform
          })
        }
      }

      function movePlaceholder(target: DropTarget | null) {
        const placeholder = placeholderRef.current
        if (!placeholder) return
        if (!target) {
          placeholder.style.visibility = "hidden"
          return
        }
        const targetZone = zoneForTarget(target)
        if (!targetZone) {
          placeholder.style.visibility = "hidden"
          return
        }
        placeholder.style.visibility = "visible"
        const targetButton =
          target.defId === "__end__"
            ? null
            : Array.from(targetZone.querySelectorAll<HTMLElement>("[data-activity-button]")).find(
                (button) => button.getAttribute("data-activity-button") === target.defId,
              )
        const targetWrapper = targetButton?.parentElement ?? null
        const isAlreadyAtTarget =
          placeholder.parentElement === targetZone &&
          (targetWrapper
            ? placeholder.nextElementSibling === targetWrapper
            : !placeholder.nextElementSibling)
        if (isAlreadyAtTarget) return

        const before = new Map(activityItems().map((item) => [item, item.getBoundingClientRect()]))
        targetZone.insertBefore(placeholder, targetWrapper)
        animateNeighbourShift(before)
      }

      function findDropTarget(x: number, y: number): DropTarget | null {
        const zones = visibleActivityZones()
        if (!zones.length) return null

        // Resolve the bar under the pointer from geometry, not from the DOM
        // hit-test. The placeholder is intentionally pointer-events:none and
        // must not steal the current target while it is moving.
        const hoveredZone = zones.find(
          ({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
        )
        const side =
          hoveredZone?.side ?? zones.find(({ rect }) => x >= rect.left && x <= rect.right)?.side
        if (!side) return null
        const zone =
          hoveredZone?.name === movingZone
            ? hoveredZone.zone
            : zones.find((entry) => entry.side === side && entry.name === movingZone)?.zone
        if (!zone) return null

        const buttons = Array.from(
          zone.querySelectorAll<HTMLElement>("[data-activity-button]"),
        ).filter((button) => button !== fromEl && button.getClientRects().length > 0)
        for (const button of buttons) {
          const rect = button.getBoundingClientRect()
          if (y < rect.top + rect.height / 2) {
            return {
              defId: button.getAttribute("data-activity-button") ?? "__end__",
              side,
              zone: movingZone,
            }
          }
        }
        return { defId: "__end__", side, zone: movingZone }
      }

      function applyHighlight(target: DropTarget | null) {
        clearTargets()
        if (!target) return
        placeholderRef.current?.setAttribute("data-drop-target", "true")
        if (target.defId === "__end__") {
          const zone = document.querySelector<HTMLElement>(
            `[data-activity-bar='${target.side}'] [data-activity-zone='${target.zone}']`,
          )
          zone?.setAttribute("data-drop-target", "true")
          return
        }
      }

      function processPointer(x: number, y: number) {
        positionGhost(x, y)
        lastDrop = findDropTarget(x, y)
        movePlaceholder(lastDrop)
        applyHighlight(lastDrop)
      }

      function flushPointer(x: number, y: number) {
        if (pointerFrame) cancelAnimationFrame(pointerFrame)
        pointerFrame = 0
        pendingPointer = null
        processPointer(x, y)
      }

      function onMove(ev: PointerEvent) {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (!started) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
          started = true
          ensureGhost()
          rememberButtonStyles()
          createPlaceholder()
          setDraggingId(defId)
          fromEl.setAttribute("data-dragging", "true")
          document.body.style.userSelect = "none"
          document.body.style.cursor = "grabbing"
        }
        pendingPointer = { x: ev.clientX, y: ev.clientY }
        if (!pointerFrame) {
          pointerFrame = requestAnimationFrame(() => {
            pointerFrame = 0
            const pointer = pendingPointer
            pendingPointer = null
            if (pointer) processPointer(pointer.x, pointer.y)
          })
        }
      }

      function onUp(ev: PointerEvent) {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onCancel)
        if (started) {
          flushPointer(ev.clientX, ev.clientY)
          // The placeholder moves the buttons while dragging. Re-resolving
          // pointerup coordinates could therefore hit the placeholder itself
          // instead of the target that was just shown. Keep the latest valid
          // target; only resolve on release when no target was found yet.
          if (!lastDrop) lastDrop = findDropTarget(ev.clientX, ev.clientY)
          if (lastDrop && lastDrop.defId !== defId) {
            onDrop(defId, lastDrop.side, lastDrop.defId)
          }
          // Native click follows pointerup. Keep it from activating the
          // dragged view after the reorder has completed.
          fromEl.setAttribute("data-suppress-click", "true")
          window.setTimeout(() => fromEl.removeAttribute("data-suppress-click"), 0)
        }
        cleanup()
      }

      function onCancel() {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onCancel)
        if (pointerFrame) cancelAnimationFrame(pointerFrame)
        pointerFrame = 0
        pendingPointer = null
        cleanup()
      }

      function cleanup() {
        dragEnded = true
        if (pointerFrame) cancelAnimationFrame(pointerFrame)
        pointerFrame = 0
        pendingPointer = null
        for (const controls of neighbourAnimations.values()) controls.stop()
        neighbourAnimations.clear()
        const ghost = ghostRef.current
        if (ghost) {
          ghost.remove()
          ghostRef.current = null
        }
        const placeholder = placeholderRef.current
        if (placeholder) {
          placeholder.remove()
          placeholderRef.current = null
        }
        fromEl.style.display = originalDisplay
        if (sourceWrapper) sourceWrapper.style.display = originalWrapperDisplay
        document.body.style.userSelect = originalBodyUserSelect
        document.body.style.cursor = originalBodyCursor
        for (const [item, original] of originalButtonStyles) {
          item.style.transform = original.transform
        }
        originalButtonStyles.clear()
        fromEl.removeAttribute("data-dragging")
        clearTargets()
        setDraggingId(null)
      }

      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onCancel)
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
