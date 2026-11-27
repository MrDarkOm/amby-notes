import * as React from "react"

const TRACK_SIZE = 4

/** Short grid tracks let the next widget use the space below a shorter card. */
export function useDeskGrid(columns: number, layout: readonly unknown[]) {
  const grid = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    const element = grid.current
    if (!element || columns === 1 || typeof ResizeObserver === "undefined") return
    const cards = Array.from(element.children) as HTMLElement[]
    if (cards.length === 0) return

    const pack = () => {
      const heights = cards.map((card) => card.getBoundingClientRect().height)
      if (heights.some((height) => height === 0)) return
      const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0
      cards.forEach((card, index) => {
        const span = `span ${Math.ceil((heights[index] + gap) / TRACK_SIZE)}`
        if (card.style.gridRowEnd !== span) card.style.gridRowEnd = span
      })
      element.classList.add("amby-desk-packed")
    }
    pack()
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(pack)
    })
    cards.forEach((card) => observer.observe(card))
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      element.classList.remove("amby-desk-packed")
      cards.forEach((card) => {
        card.style.gridRowEnd = ""
      })
    }
  }, [columns, layout])
  return grid
}
