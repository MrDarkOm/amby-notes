import * as React from "react"
import { Reorder, useDragControls } from "motion/react"
import type { DatabaseViewSummary } from "@/lib/storage"

/** What a view tab needs to take part in dragging. */
export interface ViewTabDrag {
  /** Call on pointer down: a press that then moves a little lifts the tab. */
  startWatch: (event: React.PointerEvent) => void
  /** True for the click that ends a drag, which must not select or open the tab. */
  consumeClick: () => boolean
}

const DRAG_THRESHOLD = 5

/**
 * A tab of the view strip that can be dragged to a new place. Dragging starts only after the
 * pointer has moved a little, so pressing the tab still selects it (or opens its menu).
 */
export function ViewTabItem({
  value,
  disabled,
  onDropped,
  children,
}: {
  value: DatabaseViewSummary
  disabled?: boolean
  /** The tab was let go: the strip's order may have changed. */
  onDropped: () => void
  children: (drag: ViewTabDrag) => React.ReactNode
}) {
  const controls = useDragControls()
  const dragged = React.useRef(false)

  const startWatch = (event: React.PointerEvent) => {
    if (disabled || event.button !== 0) return
    const startX = event.clientX
    const startY = event.clientY
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
    }
    const move = (moved: PointerEvent) => {
      if (Math.hypot(moved.clientX - startX, moved.clientY - startY) < DRAG_THRESHOLD) return
      stop()
      dragged.current = true
      // The click that follows letting go must not select the tab.
      window.addEventListener("pointerup", () => setTimeout(() => (dragged.current = false), 0), {
        once: true,
      })
      controls.start(moved)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
  }

  return (
    <Reorder.Item
      as="div"
      value={value}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDropped}
      // The dragged tab rides above the others; it moves along the strip only.
      whileDrag={{ zIndex: 20 }}
      className="relative shrink-0 cursor-grab active:cursor-grabbing"
    >
      {children({ startWatch, consumeClick: () => dragged.current })}
    </Reorder.Item>
  )
}
