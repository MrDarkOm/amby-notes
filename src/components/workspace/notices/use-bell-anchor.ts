import * as React from "react"

/**
 * Where the stack and the toasts stand: beside the bell of the dock, on the side where the dock is, with their
 * foot at the foot of the button, so they grow upwards from it. Without a dock (a test, a narrow window) they
 * keep to the left edge. Read when `active` becomes true and again when the window changes size.
 */
export function useBellAnchor(active: boolean): React.CSSProperties {
  const [anchor, setAnchor] = React.useState<React.CSSProperties>({ left: 56, bottom: 8 })
  React.useLayoutEffect(() => {
    if (!active) return
    const measure = () => {
      const button = document.querySelector('[data-activity-button="notices"]')
      const rect = button?.getBoundingClientRect()
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        setAnchor({ left: 56, bottom: 8, maxHeight: window.innerHeight - 16 })
        return
      }
      const bottom = Math.max(8, window.innerHeight - rect.bottom)
      const maxHeight = Math.max(160, window.innerHeight - bottom - 8)
      setAnchor(
        rect.left > window.innerWidth / 2
          ? { right: window.innerWidth - rect.left + 8, bottom, maxHeight }
          : { left: rect.right + 8, bottom, maxHeight },
      )
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [active])
  return anchor
}
