import * as React from "react"
import type { RowDropPlacement } from "../row-order"

/** How far the pointer must move before a press becomes a drag; below it, it is a click. */
const DRAG_THRESHOLD = 5
/** Distance from the scroll area's top/bottom edge where dragging scrolls it. */
const EDGE = 48
const MAX_SCROLL_STEP = 18
/** Things inside a card that keep their own click and typing behaviour. */
const INTERACTIVE =
  "button, input, textarea, select, a, [role=option], [role=listbox], [data-no-drag]"

export interface RowDrag {
  rowId: string
  /** Pointer position, for the ghost that follows it. */
  x: number
  y: number
  /** Where inside the lifted element the pointer took hold. */
  offsetX: number
  offsetY: number
  width: number
  /** Where the press started, and how far the area has scrolled since: a lifted row follows both. */
  startY: number
  scrollDelta: number
  /** The row under the pointer and the side of it the dragged row would land on. */
  overId: string | null
  placement: RowDropPlacement
}

interface UseRowReorderOptions {
  /** The scrolling area, scrolled while a row is held near its top or bottom edge. */
  scrollRef: React.RefObject<HTMLElement | null>
  /** `list` rows stack vertically; `grid` cards sit side by side, so the side is picked by x. */
  axis: "list" | "grid"
  onDrop: (rowId: string, overId: string, placement: RowDropPlacement) => void
  /**
   * Decides the row under the pointer itself instead of reading the page. A layout that moves
   * its rows while one is dragged needs this: it answers from where the rows were.
   */
  hitTest?: (
    x: number,
    y: number,
    rowId: string,
  ) => { overId: string; placement: RowDropPlacement } | null
}

function rowAt(x: number, y: number): Element | null {
  for (const element of document.elementsFromPoint(x, y)) {
    const row = element.closest("[data-reorder-id]")
    if (row) return row
  }
  return null
}

interface BeginOptions {
  /** The lifted element; its size and the grip point place the ghost. */
  lift: HTMLElement
  /** Called when the press ends without a drag, so a grip can still act as a button. */
  onClick?: () => void
  /** Presses on interactive children of the lifted element keep their own behaviour. */
  skipInteractive?: boolean
}

/**
 * Reordering by pointer for rows and cards: press and move to lift, the row under the pointer
 * shows where the drop lands and the area scrolls near its edges; release drops, Escape puts it
 * back. Rows carry `data-reorder-id`. Plain pointer events, so a press that does not move is
 * still an ordinary click.
 */
export function useRowReorder({ scrollRef, axis, onDrop, hitTest }: UseRowReorderOptions) {
  const [drag, setDrag] = React.useState<RowDrag | null>(null)
  const suppressClick = React.useRef(false)
  const onDropRef = React.useRef(onDrop)
  onDropRef.current = onDrop
  const hitTestRef = React.useRef(hitTest)
  hitTestRef.current = hitTest
  const stopRef = React.useRef<(() => void) | null>(null)

  const begin = React.useCallback(
    (event: React.PointerEvent<HTMLElement>, rowId: string, options: BeginOptions) => {
      if (event.button !== 0 || !event.isPrimary) return
      if (options.skipInteractive) {
        const interactive = (event.target as HTMLElement).closest(INTERACTIVE)
        if (interactive && interactive !== options.lift) return
      }
      stopRef.current?.()
      const rect = options.lift.getBoundingClientRect()
      const start = { x: event.clientX, y: event.clientY }
      let pointer = start
      let active = false
      let last: RowDrag | null = null
      let frame = 0
      const scrollStart = scrollRef.current?.scrollTop ?? 0

      const update = () => {
        const custom = hitTestRef.current
        if (custom) {
          const hit = custom(pointer.x, pointer.y, rowId)
          last = {
            rowId,
            x: pointer.x,
            y: pointer.y,
            offsetX: start.x - rect.left,
            offsetY: start.y - rect.top,
            width: rect.width,
            startY: start.y,
            scrollDelta: (scrollRef.current?.scrollTop ?? 0) - scrollStart,
            overId: hit && hit.overId !== rowId ? hit.overId : null,
            placement: hit?.placement ?? "after",
          }
          setDrag(last)
          return
        }
        const over = rowAt(pointer.x, pointer.y)
        const overId = over?.getAttribute("data-reorder-id") ?? null
        const bounds = over?.getBoundingClientRect()
        const placement: RowDropPlacement =
          bounds && overId !== null
            ? (
                axis === "grid"
                  ? pointer.x < bounds.left + bounds.width / 2
                  : pointer.y < bounds.top + bounds.height / 2
              )
              ? "before"
              : "after"
            : (last?.placement ?? "after")
        last = {
          rowId,
          x: pointer.x,
          y: pointer.y,
          offsetX: start.x - rect.left,
          offsetY: start.y - rect.top,
          width: rect.width,
          startY: start.y,
          scrollDelta: (scrollRef.current?.scrollTop ?? 0) - scrollStart,
          // Over the row itself, or between rows: no marker, and a drop does nothing.
          overId: overId === rowId ? null : overId,
          placement,
        }
        setDrag(last)
      }
      const tick = () => {
        const area = scrollRef.current
        if (area) {
          const bounds = area.getBoundingClientRect()
          const before = area.scrollTop
          const fromTop = pointer.y - bounds.top
          const fromBottom = bounds.bottom - pointer.y
          if (fromTop < EDGE) {
            area.scrollTop -= Math.ceil((MAX_SCROLL_STEP * (EDGE - Math.max(fromTop, 0))) / EDGE)
          } else if (fromBottom < EDGE) {
            area.scrollTop += Math.ceil((MAX_SCROLL_STEP * (EDGE - Math.max(fromBottom, 0))) / EDGE)
          }
          // The row under a held pointer changes while the area scrolls.
          if (area.scrollTop !== before) update()
        }
        frame = requestAnimationFrame(tick)
      }
      const onMove = (moved: PointerEvent) => {
        pointer = { x: moved.clientX, y: moved.clientY }
        if (!active) {
          if (Math.hypot(pointer.x - start.x, pointer.y - start.y) < DRAG_THRESHOLD) return
          active = true
          document.body.style.cursor = "grabbing"
          frame = requestAnimationFrame(tick)
        }
        update()
      }
      const finish = (drop: boolean) => {
        stop()
        setDrag(null)
        if (!active) {
          if (drop) options.onClick?.()
          return
        }
        // The click that follows a drag must not open the row.
        suppressClick.current = true
        setTimeout(() => {
          suppressClick.current = false
        }, 0)
        if (drop && last?.overId) onDropRef.current(rowId, last.overId, last.placement)
      }
      const onUp = () => finish(true)
      const onCancel = () => finish(false)
      const onKey = (key: KeyboardEvent) => {
        if (key.key !== "Escape" || !active) return
        key.preventDefault()
        key.stopPropagation()
        finish(false)
      }
      const stop = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onCancel)
        window.removeEventListener("keydown", onKey, true)
        cancelAnimationFrame(frame)
        document.body.style.userSelect = ""
        document.body.style.setProperty("-webkit-user-select", "")
        document.body.style.cursor = ""
        stopRef.current = null
      }
      // Pressing a row must never start selecting text: the selection would grow over every
      // row the pointer crosses while it is dragged.
      document.body.style.userSelect = "none"
      document.body.style.setProperty("-webkit-user-select", "none")
      window.getSelection()?.removeAllRanges()
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onCancel)
      window.addEventListener("keydown", onKey, true)
      stopRef.current = stop
    },
    [axis, scrollRef],
  )

  React.useEffect(() => () => stopRef.current?.(), [])

  return { drag, begin, consumeClick: () => suppressClick.current }
}

/** Marks where the dragged row would land, as a line on the side of the row under it. */
export function dropMarkerClass(
  drag: RowDrag | null,
  rowId: string,
  axis: "list" | "grid",
): string | undefined {
  if (!drag || drag.overId !== rowId) return undefined
  if (axis === "grid") {
    return drag.placement === "before" ? "database-row-drop-left" : "database-row-drop-right"
  }
  return drag.placement === "before" ? "database-row-drop-before" : "database-row-drop-after"
}

/**
 * A press that moves while dragging is not allowed (a sort decides the order): tells the owner,
 * so it can offer to switch the sort off, instead of doing nothing.
 */
export function watchBlockedDrag(event: React.PointerEvent, onBlocked: () => void): void {
  if (event.button !== 0 || !event.isPrimary) return
  const start = { x: event.clientX, y: event.clientY }
  const stop = () => {
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", stop)
    window.removeEventListener("pointercancel", stop)
  }
  const move = (moved: PointerEvent) => {
    if (Math.hypot(moved.clientX - start.x, moved.clientY - start.y) < DRAG_THRESHOLD) return
    stop()
    onBlocked()
  }
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", stop)
  window.addEventListener("pointercancel", stop)
}
