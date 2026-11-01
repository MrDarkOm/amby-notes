import { animate } from "motion/react"
import { motionTransition, motionTransitions } from "@/lib/motion-config"

/** Visual-only lift: never move the real node or add its controls to the preview. */
export function imageDragFeedback(source: HTMLElement, start: { x: number; y: number }) {
  const image = source.querySelector("img")
  if (!image) return null
  const rect = image.getBoundingClientRect()
  const scale = Math.min(1, 360 / Math.max(1, rect.width), 260 / Math.max(1, rect.height))
  const width = rect.width * scale
  const offset = { x: (start.x - rect.left) * scale, y: (start.y - rect.top) * scale }
  const ghost = document.createElement("div")
  ghost.className = "amby-image-drag-preview"
  ghost.setAttribute("aria-hidden", "true")
  const copy = image.cloneNode(false) as HTMLImageElement
  copy.removeAttribute("id")
  copy.removeAttribute("class")
  copy.removeAttribute("style")
  copy.draggable = false
  copy.style.width = `${width}px`
  copy.style.height = `${rect.height * scale}px`
  ghost.append(copy)
  document.body.append(ghost)
  source.classList.add("amby-image-drag-source")
  const previousCursor = document.body.style.cursor
  document.body.classList.add("amby-image-dragging")
  document.body.style.cursor = "grabbing"
  const position = (x: number, y: number) => {
    ghost.style.transform = `translate3d(${x - offset.x}px, ${y - offset.y}px, 0)`
  }
  position(start.x, start.y)
  try {
    animate(
      copy,
      { opacity: [0.55, 0.9], scale: [0.96, 1] },
      motionTransition(motionTransitions.fast),
    )
  } catch {
    /* Feedback must never prevent placement. */
  }
  let finished = false
  return {
    position,
    finish(destination?: DOMRect) {
      if (finished) return
      finished = true
      source.classList.remove("amby-image-drag-source")
      document.body.classList.remove("amby-image-dragging")
      document.body.style.cursor = previousCursor
      // Settle at the actual destination (or return to the source on cancel).
      const target = destination ?? (source.isConnected ? image.getBoundingClientRect() : null)
      try {
        if (target)
          animate(
            ghost,
            { transform: `translate3d(${target.left}px, ${target.top}px, 0)` },
            motionTransition(motionTransitions.default),
          )
        const controls = animate(
          copy,
          { opacity: 0, scale: target ? target.width / Math.max(1, width) : 0.96 },
          motionTransition(motionTransitions.default),
        )
        void controls.then(() => ghost.remove())
      } catch {
        ghost.remove()
      }
    },
  }
}

export function imageDragScrollContainer(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (
      /(auto|scroll)/u.test(getComputedStyle(parent).overflowY) &&
      parent.scrollHeight > parent.clientHeight
    )
      return parent
  }
  return null
}
