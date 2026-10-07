import { createPortal } from "react-dom"
import { PageIcon } from "../page-icon"
import type { RowDrag } from "./use-row-reorder"

/** The row or card that follows the pointer while it is dragged. */
export function RowDragGhost({ drag, title }: { drag: RowDrag | null; title: string }) {
  if (!drag) return null
  return createPortal(
    <div
      aria-hidden="true"
      className="database-row-drag-ghost pointer-events-none fixed z-[100] flex h-9 items-center gap-2 rounded-lg border border-border bg-popover px-3 text-sm font-medium text-popover-foreground opacity-90"
      style={{
        left: drag.x - drag.offsetX,
        top: drag.y - Math.min(drag.offsetY, 18),
        width: Math.min(drag.width, 360),
      }}
    >
      <PageIcon noteId={drag.rowId} />
      <span className="truncate">{title}</span>
    </div>,
    document.body,
  )
}
