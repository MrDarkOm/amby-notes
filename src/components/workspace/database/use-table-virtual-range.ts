import * as React from "react"
import { OVERSCAN } from "./table-columns"

/**
 * Windowing for the table: which rows are in the DOM for the current scroll offset. The viewport's
 * height is watched, and range updates are coalesced into one animation frame.
 */
export function useTableVirtualRange({
  rowCount,
  rowHeight,
}: {
  rowCount: number
  rowHeight: number
}) {
  const [viewportHeight, setViewportHeight] = React.useState(480)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const scrollTopRef = React.useRef(0)
  const rangeRafRef = React.useRef<number | null>(null)

  React.useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const update = () => setViewportHeight(element.clientHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const calculateRange = React.useCallback(
    (offset: number) => {
      const first = Math.min(rowCount, Math.max(0, Math.floor(offset / rowHeight) - OVERSCAN))
      return {
        first,
        last: Math.min(rowCount, first + Math.ceil(viewportHeight / rowHeight) + OVERSCAN * 2),
      }
    },
    [rowHeight, rowCount, viewportHeight],
  )
  const [visibleRange, setVisibleRange] = React.useState(() => calculateRange(0))
  const rangeRef = React.useRef(visibleRange)
  rangeRef.current = visibleRange
  const scheduleRangeUpdate = React.useCallback(() => {
    if (rangeRafRef.current !== null) return
    rangeRafRef.current = requestAnimationFrame(() => {
      rangeRafRef.current = null
      const next = calculateRange(scrollTopRef.current)
      const current = rangeRef.current
      if (next.first === current.first && next.last === current.last) return
      rangeRef.current = next
      setVisibleRange(next)
    })
  }, [calculateRange])
  React.useEffect(() => {
    scheduleRangeUpdate()
    return () => {
      if (rangeRafRef.current !== null) cancelAnimationFrame(rangeRafRef.current)
      rangeRafRef.current = null
    }
  }, [scheduleRangeUpdate])

  return { viewportRef, scrollTopRef, visibleRange, scheduleRangeUpdate }
}
