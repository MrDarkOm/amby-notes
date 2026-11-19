import * as React from "react"
import {
  animate,
  type MotionValue,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react"

import { motionTransitions } from "@/lib/motion-config"

/**
 * A length that goes from `closed` to `open` as the progress of a panel goes from 0 to 1. Motion
 * moves the progress; every width and offset that follows a panel (the panel, its overlay, the
 * header columns) is a `calc()` of it, written by Motion onto that element alone, so they move
 * together and nothing is animated by CSS. `closed` and `open` may change between renders (a
 * resize, a pin): the length is recomputed with them.
 */
export function usePanelLength(
  progress: MotionValue<number>,
  closed: string,
  open: string,
): MotionValue<string> {
  return useTransform(progress, (value) => panelLength(value, closed, open))
}

export function panelLength(value: number, closed: string, open: string): string {
  return `calc(${closed} + ${value} * (${open} - ${closed}))`
}

/** The progress given by the layout, or one that jumps with `open` when there is none. */
export function useEdgeProgress(
  given: MotionValue<number> | undefined,
  open: boolean,
): MotionValue<number> {
  const fallback = useMotionValue(open ? 1 : 0)
  React.useEffect(() => fallback.set(open ? 1 : 0), [fallback, open])
  return given ?? fallback
}

export interface PanelPresence {
  /** The panel is in the DOM: while open and while it slides away. */
  mounted: boolean
  /** Open and done moving: overflow clipping can be lifted for resize handles. */
  settled: boolean
  /** How far the panel is open, 0 to 1, moved by Motion. */
  progress: MotionValue<number>
}

/**
 * Drives a side panel's mount lifecycle and Motion progress (0 to 1) so the panel,
 * central stage, and header columns animate in lockstep.
 */
export function usePanelPresence(open: boolean): PanelPresence {
  const reduced = useReducedMotion()
  const progress = useMotionValue(open ? 1 : 0)
  const [mounted, setMounted] = React.useState(open)
  const [settled, setSettled] = React.useState(open)

  React.useEffect(() => {
    const target = open ? 1 : 0
    if (progress.get() === target) {
      setMounted(open)
      setSettled(open)
      return
    }
    if (open) setMounted(true)
    setSettled(false)
    let live = true
    const controls = animate(progress, target, reduced ? { duration: 0 } : motionTransitions.panel)
    void controls.then(() => {
      if (!live) return
      if (open) setSettled(true)
      else setMounted(false)
    })
    return () => {
      live = false
      controls.stop()
    }
  }, [open, progress, reduced])

  return { mounted, settled, progress }
}
