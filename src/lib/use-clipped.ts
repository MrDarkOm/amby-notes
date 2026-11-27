import * as React from "react"

/**
 * Whether the text of an element is cut off (`truncate`): the answer for a tooltip that should
 * appear only when the full text does not fit. Re-measured when the element is resized.
 */
export function useClipped<T extends HTMLElement>(
  text: string | null | undefined,
): [React.RefObject<T | null>, boolean] {
  const ref = React.useRef<T>(null)
  const [clipped, setClipped] = React.useState(false)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setClipped(element.scrollWidth > element.clientWidth + 1)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])
  return [ref, clipped]
}
