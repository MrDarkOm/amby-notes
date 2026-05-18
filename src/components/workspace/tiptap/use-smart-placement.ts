import * as React from "react"

export interface AnchorRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/**
 * Position an absolutely-positioned panel below the anchor by default, but
 * flip above if there is not enough room. Clamps to viewport edges.
 *
 * Returns inline style for the panel; expects the panel ref to point to a
 * `position: fixed` element.
 */
export function useSmartPlacement(
  anchor: AnchorRect | null,
  panelRef: React.RefObject<HTMLElement | null>,
  options: { gap?: number; padding?: number } = {},
): React.CSSProperties {
  const { gap = 4, padding = 8 } = options
  const [style, setStyle] = React.useState<React.CSSProperties>(() =>
    anchor ? hiddenStyle(anchor.left, anchor.bottom + gap) : { position: "fixed" },
  )

  React.useLayoutEffect(() => {
    if (!anchor || !panelRef.current) return
    const measure = () => {
      const panel = panelRef.current
      if (!panel) return
      const rect = panel.getBoundingClientRect()
      const wh = window.innerHeight
      const ww = window.innerWidth

      let left = anchor.left
      let top = anchor.bottom + gap

      // Flip above if the panel would overflow the bottom.
      if (top + rect.height > wh - padding) {
        const aboveTop = anchor.top - rect.height - gap
        if (aboveTop >= padding) {
          top = aboveTop
        } else {
          // No room either way → clamp to bottom edge.
          top = Math.max(padding, wh - rect.height - padding)
        }
      }
      // Clamp horizontally.
      if (left + rect.width > ww - padding) {
        left = ww - rect.width - padding
      }
      if (left < padding) left = padding

      setStyle({ position: "fixed", left, top, visibility: "visible" })
    }

    measure()
    const onResize = () => measure()
    window.addEventListener("resize", onResize)
    window.addEventListener("scroll", onResize, true)
    return () => {
      window.removeEventListener("resize", onResize)
      window.removeEventListener("scroll", onResize, true)
    }
    // panelRef is stable; anchor is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor?.left, anchor?.top, anchor?.right, anchor?.bottom, gap, padding])

  return style
}

function hiddenStyle(left: number, top: number): React.CSSProperties {
  // Render at the would-be position but invisible so we can measure on first paint.
  return { position: "fixed", left, top, visibility: "hidden" }
}
