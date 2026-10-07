import * as React from "react"
import { PopoverAnchor } from "@/components/ui/popover"
import type { DatabaseRow } from "@/lib/storage"
import { closeFloatingMenus } from "./close-floating-menus"
import { RowMenuPopover, type RowMenuModel } from "./row-menu"

/**
 * The same menu on a right click anywhere on a row. Render `element` once; call `open` from the
 * rows' `onContextMenu`. Fields that edit text keep the browser's own menu.
 */
export function useRowContextMenu({
  rows,
  rowMenu,
}: {
  rows: DatabaseRow[]
  rowMenu?: (row: DatabaseRow) => RowMenuModel
}) {
  const [target, setTarget] = React.useState<{ noteId: string; x: number; y: number } | null>(null)
  const point = React.useRef({ x: 0, y: 0 })
  const virtualRef = React.useRef({
    getBoundingClientRect: () => new DOMRect(point.current.x, point.current.y, 0, 0),
  })
  const open = React.useCallback(
    (event: React.MouseEvent, row: DatabaseRow) => {
      if (!rowMenu) return
      const field = (event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")
      if (field) return
      event.preventDefault()
      event.stopPropagation()
      closeFloatingMenus()
      point.current = { x: event.clientX, y: event.clientY }
      setTarget({ noteId: row.noteId, x: event.clientX, y: event.clientY })
    },
    [rowMenu],
  )
  const row = target ? rows.find((candidate) => candidate.noteId === target.noteId) : undefined
  const element =
    rowMenu && target && row ? (
      <RowMenuPopover
        key={`${target.noteId}:${target.x}:${target.y}`}
        open
        onOpenChange={(next) => {
          if (!next) setTarget(null)
        }}
        row={row}
        menu={rowMenu(row)}
        anchor={<PopoverAnchor virtualRef={virtualRef} />}
      />
    ) : null
  return { open, element }
}
