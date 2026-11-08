import * as React from "react"

/** The gap between the edge of the dock and the stack or the toasts, in pixels: no button of the dock is covered. */
export const DOCK_GAP = 12

/**
 * Where the stack and the toasts stand: beside the bell of the dock, on the side where the dock is, with their
 * foot at the foot of the button, so they grow upwards from it. Without a dock (a test, a narrow window) they
 * keep to the left edge. Read when `active` becomes true and again when the window changes size.
 */
export function useBellAnchor(active: boolean): React.CSSProperties {
  const [anchor, setAnchor] = React.useState<React.CSSProperties>({
    left: 48 + DOCK_GAP,
    bottom: 8,
  })
  React.useLayoutEffect(() => {
    if (!active) return
    const measure = () => {
      const button = document.querySelector('[data-activity-button="notices"]')
      const rect = button?.getBoundingClientRect()
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        setAnchor({ left: 48 + DOCK_GAP, bottom: 8, maxHeight: window.innerHeight - 56 })
        return
      }
      // The gap is measured from the edge of the dock itself, not from the button inside it.
      const dock = button?.closest("[data-activity-bar]")?.getBoundingClientRect()
      const bottom = Math.max(8, window.innerHeight - rect.bottom)
      const maxHeight = Math.max(160, window.innerHeight - bottom - 48)
      setAnchor(
        rect.left > window.innerWidth / 2
          ? { right: window.innerWidth - (dock?.left ?? rect.left) + DOCK_GAP, bottom, maxHeight }
          : { left: (dock?.right ?? rect.right) + DOCK_GAP, bottom, maxHeight },
      )
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [active])
  return anchor
}
