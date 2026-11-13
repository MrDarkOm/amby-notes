import * as React from "react"

/** The gap between the edge of the dock and the stack or the toasts, in pixels: no button of the dock is covered. */
export const DOCK_GAP = 12

/** The width of the stack and of the toasts (`22rem`, narrower in a narrow window), to see what they would cover. */
const STACK_WIDTH = 352
/** The air between the stack and the workspace switcher it stands above, in pixels. */
const SWITCHER_GAP = 8

/**
 * The foot of the stack, lifted above the workspace switcher at the foot of the sidebar when the stack
 * would stand over it, so the switcher stays visible and clickable.
 */
function aboveSwitcher(bottom: number, left: number, right: number): number {
  const rect = document.querySelector("[data-workspace-switcher]")?.getBoundingClientRect()
  if (!rect || (rect.width === 0 && rect.height === 0)) return bottom
  const sideBySide = rect.right > left && rect.left < right
  const reachesIn = window.innerHeight - rect.top > bottom
  return sideBySide && reachesIn ? window.innerHeight - rect.top + SWITCHER_GAP : bottom
}

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
      const footOfBell = Math.max(8, window.innerHeight - rect.bottom)
      if (rect.left > window.innerWidth / 2) {
        const right = window.innerWidth - (dock?.left ?? rect.left) + DOCK_GAP
        const bottom = footOfBell
        setAnchor({ right, bottom, maxHeight: Math.max(160, window.innerHeight - bottom - 48) })
        return
      }
      const left = (dock?.right ?? rect.right) + DOCK_GAP
      const bottom = aboveSwitcher(footOfBell, left, left + STACK_WIDTH)
      setAnchor({ left, bottom, maxHeight: Math.max(160, window.innerHeight - bottom - 48) })
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [active])
  return anchor
}
