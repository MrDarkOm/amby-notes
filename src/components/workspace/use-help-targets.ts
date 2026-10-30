import * as React from "react"
import { HELP_TARGETS, type HelpTarget } from "./help-targets"
import { visibleHelpRect, type HelpRect } from "./help-overlay-layout"
import { useTabsStore } from "./use-tabs-store"

export interface VisibleHelpTarget extends HelpTarget {
  rect: HelpRect
}

export function useHelpTargets(open: boolean) {
  const activePaneId = useTabsStore((state) => state.activePaneId)
  const [state, setState] = React.useState({
    width: 0,
    height: 0,
    targets: [] as VisibleHelpTarget[],
  })

  React.useLayoutEffect(() => {
    if (!open) return
    let frame = 0
    const measure = () => {
      const width = window.innerWidth
      const height = window.innerHeight
      const pane = Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]")).find(
        (element) => element.dataset.paneId === activePaneId,
      )
      const targets: VisibleHelpTarget[] = []
      for (const definition of HELP_TARGETS) {
        let found = false
        for (const selector of definition.selectors) {
          const root = (definition.page || definition.preferPane) && pane ? pane : document
          const scoped =
            root instanceof Element && root.matches(selector)
              ? [root]
              : Array.from(root.querySelectorAll(selector))
          const candidates =
            definition.preferPane && root !== document
              ? [...scoped, ...document.querySelectorAll(selector)]
              : scoped
          for (const element of candidates) {
            if (element.closest("[data-help-screen]")) continue
            const rect = visibleHelpRect(element, width, height)
            if (!rect) continue
            targets.push({ ...definition, rect })
            found = true
            break
          }
          if (found) break
        }
      }
      setState({ width, height, targets })
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    measure()
    const observer = new ResizeObserver(schedule)
    observer.observe(document.documentElement)
    for (const element of document.querySelectorAll("[data-help-area], [data-panel-side]"))
      observer.observe(element)
    window.addEventListener("resize", schedule)
    window.addEventListener("scroll", schedule, true)
    // Finish measuring dock/sidebar motion that may still be settling as Help opens.
    const settle = window.setTimeout(schedule, 350)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(settle)
      observer.disconnect()
      window.removeEventListener("resize", schedule)
      window.removeEventListener("scroll", schedule, true)
    }
  }, [open, activePaneId])

  return state
}
