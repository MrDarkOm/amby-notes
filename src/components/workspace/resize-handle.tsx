import * as React from "react"

/** Invisible drag target attached to the outer edge of a sidebar panel. */
export function ResizeHandle({
  onMouseDown,
  side,
}: {
  onMouseDown: (e: React.MouseEvent) => void
  side: "left" | "right"
}) {
  return (
    <div
      className={`absolute inset-y-0 z-20 w-2 cursor-col-resize ${side === "left" ? "-left-1" : "-right-1"}`}
      onMouseDown={onMouseDown}
    />
  )
}
