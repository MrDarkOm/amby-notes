import type { DatabaseSummary } from "@/lib/storage"
import * as React from "react"

interface UseToolbarLayoutParams {
  database: DatabaseSummary | undefined
  viewDisplayModes: Record<string, "both" | "icon" | "text">
}

export function useToolbarLayout({ database, viewDisplayModes }: UseToolbarLayoutParams) {
  const toolbarContainerRef = React.useRef<HTMLDivElement>(null)
  const viewsMeasureRef = React.useRef<HTMLDivElement>(null)
  const actionsRef = React.useRef<HTMLDivElement>(null)
  const expandedActionsWidthRef = React.useRef<number>(320)
  const [isCompactToolbar, setIsCompactToolbar] = React.useState(false)
  const isCompactToolbarRef = React.useRef(isCompactToolbar)
  isCompactToolbarRef.current = isCompactToolbar

  const updateToolbarLayout = React.useCallback(() => {
    const container = toolbarContainerRef.current
    if (!container) return

    if (!isCompactToolbarRef.current && actionsRef.current) {
      const currentWidth = actionsRef.current.offsetWidth
      if (currentWidth > 160) {
        expandedActionsWidthRef.current = currentWidth
      }
    }

    const containerWidth = container.clientWidth
    const measuredViewsWidth = viewsMeasureRef.current?.offsetWidth
    const viewsCount = database?.views.length ?? 0
    const viewsNaturalWidth =
      measuredViewsWidth && measuredViewsWidth > 0 ? measuredViewsWidth + 36 : viewsCount * 90 + 36
    const gap = 16
    const neededWidth = viewsNaturalWidth + expandedActionsWidthRef.current + gap

    setIsCompactToolbar((prev) => {
      if (!prev && containerWidth < neededWidth) {
        return true
      }
      if (prev && containerWidth >= neededWidth + 24) {
        return false
      }
      return prev
    })
  }, [database?.views.length])

  React.useEffect(() => {
    const container = toolbarContainerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      updateToolbarLayout()
    })
    observer.observe(container)
    if (viewsMeasureRef.current) {
      observer.observe(viewsMeasureRef.current)
    }

    updateToolbarLayout()

    return () => observer.disconnect()
  }, [database?.views.length, viewDisplayModes, updateToolbarLayout])

  return { toolbarContainerRef, viewsMeasureRef, actionsRef, isCompactToolbar }
}
