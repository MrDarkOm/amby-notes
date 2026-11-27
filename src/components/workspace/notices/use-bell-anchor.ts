import * as React from "react"

/** Offset from the outer edge of the dock, in pixels: 0 aligns flush with the side-panel edge. */
export const DOCK_GAP = 0

/** Bottom inset from the window edge, matching the 8px (`mb-2`) foot of the workspace cards. */
export const BOTTOM_INSET = 8

/**
 * Where the stack and the toasts stand: beside the bell of the dock, on the side where the dock is,
 * anchored cleanly near the bottom edge of the window so they grow upwards from it. Without a dock
 * (a test, a narrow window) they keep to the left edge. Read when `active` becomes true and again
 * when the window changes size.
 */
export function useBellAnchor(active: boolean): React.CSSProperties {
  const [anchor, setAnchor] = React.useState<React.CSSProperties>({
    left: 48 + DOCK_GAP,
    bottom: BOTTOM_INSET,
  })
  React.useLayoutEffect(() => {
    if (!active) return
    const measure = () => {
      const button = document.querySelector('[data-activity-button="notices"]')
      const rect = button?.getBoundingClientRect()
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        setAnchor({
          left: 48 + DOCK_GAP,
          bottom: BOTTOM_INSET,
          maxHeight: window.innerHeight - BOTTOM_INSET - 48,
        })
        return
      }
      // The gap is measured from the edge of the dock itself, not from the button inside it.
      const dock = button?.closest("[data-activity-bar]")?.getBoundingClientRect()
      const bottom = BOTTOM_INSET
      const maxHeight = Math.max(160, window.innerHeight - bottom - 48)
      if (rect.left > window.innerWidth / 2) {
        const right = window.innerWidth - (dock?.left ?? rect.left) + DOCK_GAP
        setAnchor({ right, bottom, maxHeight })
        return
      }
      const left = (dock?.right ?? rect.right) + DOCK_GAP
      setAnchor({ left, bottom, maxHeight })
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [active])
  return anchor
}
