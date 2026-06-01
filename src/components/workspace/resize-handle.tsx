import * as React from "react"

/** A 1px draggable column-resize divider. */
export function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      className="relative z-10 w-px shrink-0 cursor-col-resize bg-accent transition-colors hover:bg-muted-foreground"
      onMouseDown={onMouseDown}
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  )
}
