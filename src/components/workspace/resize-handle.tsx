import * as React from "react"

/** Drag target attached to the outer edge of a sidebar panel with a subtle hover indicator. */
export function ResizeHandle({
  onMouseDown,
  side,
  active = false,
}: {
  onMouseDown: (e: React.MouseEvent) => void
  side: "left" | "right"
  active?: boolean
}) {
  return (
    <div
      data-resizing={active ? "true" : undefined}
      className={`amby-resize-handle absolute inset-y-0 z-20 flex w-2 cursor-col-resize items-center justify-center pb-2 ${
        side === "left" ? "left-0" : "right-0"
      }`}
      onMouseDown={onMouseDown}
    >
      <div className="amby-resize-handle-line h-full w-0.5" />
    </div>
  )
}
