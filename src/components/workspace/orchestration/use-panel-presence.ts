import * as React from "react"
import { motionTransitions } from "@/lib/motion-config"

const PANEL_MS = Math.round(motionTransitions.panel.duration * 1000)

/** The CSS twin of `motionTransitions.panel`, for panels animated by a plain style. */
export function panelTransition(property: string): string {
  return `${property} ${PANEL_MS}ms cubic-bezier(${motionTransitions.panel.ease.join(", ")})`
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

export interface PanelPresence {
  /** The panel is in the DOM: while open and while it slides away. */
  mounted: boolean
  /** The panel is (moving to) its open position. */
  expanded: boolean
  /** Open and done moving: only now does the panel take its width from the content. */
  settled: boolean
}

/**
 * Drives a side panel that slides over the content instead of squeezing it frame by frame.
 * Opening mounts it off-screen, slides it in on the next frames and only then lets it take its
 * width, so the editor reflows once, under the panel. Closing gives the width back at once,
 * slides the panel out and unmounts it after the transition.
 */
export function usePanelPresence(open: boolean): PanelPresence {
  const [mounted, setMounted] = React.useState(open)
  const [expanded, setExpanded] = React.useState(open)
  const [settled, setSettled] = React.useState(open)

  React.useEffect(() => {
    const reduced = prefersReducedMotion()
    if (open) {
      setMounted(true)
      if (reduced) {
        setExpanded(true)
        setSettled(true)
        return
      }
      // Two frames: the off-screen position must be painted before it can transition.
      let second = 0
      let timer = 0
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => {
          setExpanded(true)
          timer = window.setTimeout(() => setSettled(true), PANEL_MS)
        })
      })
      return () => {
        cancelAnimationFrame(first)
        cancelAnimationFrame(second)
        window.clearTimeout(timer)
      }
    }
    setSettled(false)
    setExpanded(false)
    if (reduced) {
      setMounted(false)
      return
    }
    const timer = window.setTimeout(() => setMounted(false), PANEL_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  return { mounted, expanded, settled }
}
