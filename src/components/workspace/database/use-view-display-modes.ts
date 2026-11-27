import * as React from "react"

interface UseViewDisplayModesParams {
  databaseId: string
}

export function useViewDisplayModes({ databaseId }: UseViewDisplayModesParams) {
  const [viewDisplayModes, setViewDisplayModes] = React.useState<
    Record<string, "both" | "icon" | "text">
  >(() => {
    try {
      const raw = localStorage.getItem("amby:db-view-display-modes")
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  })
  const setViewDisplayMode = React.useCallback(
    (targetViewId: string, mode: "both" | "icon" | "text") => {
      setViewDisplayModes((current) => {
        const key = `${databaseId}:${targetViewId}`
        const next = { ...current, [key]: mode }
        try {
          localStorage.setItem("amby:db-view-display-modes", JSON.stringify(next))
        } catch {
          // Ignore
        }
        return next
      })
    },
    [databaseId],
  )

  return { viewDisplayModes, setViewDisplayMode }
}
