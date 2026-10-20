import * as React from "react"

/**
 * The width of an element in pixels, kept up to date as it changes (a side panel opening narrows
 * it, the window resizing widens it). The desk's columns follow its own width, not the window's.
 * `0` until it is measured, or where there is nothing to measure with.
 */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T | null>(null)
  const [width, setWidth] = React.useState(0)
  React.useEffect(() => {
    const element = ref.current
    if (!element) return undefined
    setWidth(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === "undefined") return undefined
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width
      if (next !== undefined) setWidth(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}
