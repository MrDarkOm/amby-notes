import * as React from "react"
import type { DatabaseRow } from "@/lib/storage"

/** The rows ticked with the checkbox in the gutter. Rows that leave the list leave the selection. */
export function useRowSelection(rows: DatabaseRow[]) {
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set())

  React.useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current
      const present = new Set(rows.map((row) => row.noteId))
      const kept = [...current].filter((id) => present.has(id))
      return kept.length === current.size ? current : new Set(kept)
    })
  }, [rows])

  const toggle = React.useCallback((noteId: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (!next.delete(noteId)) next.add(noteId)
      return next
    })
  }, [])
  const clear = React.useCallback(() => setSelected(new Set()), [])
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.noteId))
  const toggleAll = React.useCallback(
    () => setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.noteId))),
    [allSelected, rows],
  )
  return { selected, toggle, clear, toggleAll, allSelected }
}
