import * as React from "react"
import type { DatabaseRow } from "@/lib/storage"

/** How far the pointer must move before a press becomes a drag; below it, it is a click. */
const DRAG_THRESHOLD = 5
/** Distance from the board's left/right edge where dragging scrolls it. */
const EDGE = 56
const SCROLL_STEP = 14
/** Things inside a card that keep their own click and typing behaviour. */
const INTERACTIVE =
  "button, input, textarea, select, a, [role=option], [role=listbox], [data-no-drag]"

export interface BoardDrag {
  row: DatabaseRow
  sourceLane: string
  /** Pointer position, for the card that follows it. */
  x: number
  y: number
  /** Where inside the card the pointer took hold. */
  offsetX: number
  offsetY: number
  width: number
  /** The lane under the pointer, if any. */
  overLane: string | null
}

interface UseBoardDragOptions {
  /** The horizontally scrolling board, scrolled while a card is held near its edge. */
  scrollRef: React.RefObject<HTMLElement | null>
  onDrop: (row: DatabaseRow, laneKey: string) => void
}

function laneAt(x: number, y: number): string | null {
  for (const element of document.elementsFromPoint(x, y)) {
    const lane = element.closest("[data-lane-drop]")
    if (lane) return lane.getAttribute("data-lane-drop")
  }
  return null
}

/**
 * Kanban-style dragging for board cards: press and move a card to lift it, a
 * copy follows the pointer, the lane under it lights up and the board scrolls
 * near its edges; release drops it, Escape puts it back. Plain pointer events,
 * so the card keeps its ordinary click and its editable controls.
 */
export function useBoardDrag({ scrollRef, onDrop }: UseBoardDragOptions) {
  const [drag, setDrag] = React.useState<BoardDrag | null>(null)
  const suppressClick = React.useRef(false)
  const onDropRef = React.useRef(onDrop)
  onDropRef.current = onDrop
  const stopRef = React.useRef<(() => void) | null>(null)

  const begin = React.useCallback(
    (event: React.PointerEvent<HTMLElement>, row: DatabaseRow, sourceLane: string) => {
      if (event.button !== 0 || !event.isPrimary) return
      const card = event.currentTarget
      const interactive = (event.target as HTMLElement).closest(INTERACTIVE)
      if (interactive && interactive !== card) return
      stopRef.current?.()
      const rect = card.getBoundingClientRect()
      const start = { x: event.clientX, y: event.clientY }
      let pointer = start
      let active = false
      let last: BoardDrag | null = null
      let frame = 0

      const update = () => {
        last = {
          row,
          sourceLane,
          x: pointer.x,
          y: pointer.y,
          offsetX: start.x - rect.left,
          offsetY: start.y - rect.top,
          width: rect.width,
          overLane: laneAt(pointer.x, pointer.y),
        }
        setDrag(last)
      }
      const tick = () => {
        const board = scrollRef.current
        if (board) {
          const bounds = board.getBoundingClientRect()
          const before = board.scrollLeft
          if (pointer.x < bounds.left + EDGE) board.scrollLeft -= SCROLL_STEP
          else if (pointer.x > bounds.right - EDGE) board.scrollLeft += SCROLL_STEP
          // The lane under a held pointer changes while the board scrolls.
          if (board.scrollLeft !== before) update()
        }
        frame = requestAnimationFrame(tick)
      }
      const onMove = (moved: PointerEvent) => {
        pointer = { x: moved.clientX, y: moved.clientY }
        if (!active) {
          if (Math.hypot(pointer.x - start.x, pointer.y - start.y) < DRAG_THRESHOLD) return
          active = true
          frame = requestAnimationFrame(tick)
        }
        update()
      }
      const finish = (drop: boolean) => {
        stop()
        setDrag(null)
        if (!active) return
        // The click that follows a drag must not open the card.
        suppressClick.current = true
        setTimeout(() => {
          suppressClick.current = false
        }, 0)
        if (drop && last?.overLane && last.overLane !== sourceLane) {
          onDropRef.current(row, last.overLane)
        }
      }
      const onUp = () => finish(true)
      const onCancel = () => finish(false)
      const onKey = (key: KeyboardEvent) => {
        if (key.key !== "Escape" || !active) return
        key.preventDefault()
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
        stopRef.current = null
      }
      // Pressing a card must never start selecting text: the selection would grow
      // over every card the pointer crosses while it is dragged.
      document.body.style.userSelect = "none"
      document.body.style.setProperty("-webkit-user-select", "none")
      window.getSelection()?.removeAllRanges()
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onCancel)
      window.addEventListener("keydown", onKey, true)
      stopRef.current = stop
    },
    [scrollRef],
  )

  React.useEffect(() => () => stopRef.current?.(), [])

  return { drag, begin, consumeClick: () => suppressClick.current }
}
