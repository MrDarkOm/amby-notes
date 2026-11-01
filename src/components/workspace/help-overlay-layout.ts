export interface HelpRect {
  left: number
  top: number
  width: number
  height: number
}

export function helpOverlayLayout(width: number, height: number) {
  return width >= 1180 && height >= 680 ? "spacious" : "compact"
}

/** Clip to the viewport and every scrolling/clipping ancestor, not only CSS visibility. */
export function visibleHelpRect(element: Element, width: number, height: number): HelpRect | null {
  const rect = element.getBoundingClientRect()
  let left = Math.max(0, rect.left)
  let top = Math.max(0, rect.top)
  let right = Math.min(width, rect.right)
  let bottom = Math.min(height, rect.bottom)
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)
      return null
    // Radix hides the application from assistive tools while the modal is open. Do not
    // use aria-hidden to decide visibility; cached panels are hidden through CSS too.
    if (ancestor !== element) {
      const clip = ancestor.getBoundingClientRect()
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) {
        left = Math.max(left, clip.left)
        right = Math.min(right, clip.right)
      }
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) {
        top = Math.max(top, clip.top)
        bottom = Math.min(bottom, clip.bottom)
      }
    }
  }
  if (right - left < 12 || bottom - top < 12) return null
  return { left, top, width: right - left, height: bottom - top }
}

/** A short leader between the nearest edges, with no arrow drawn through a callout. */
export function helpConnector(card: HelpRect, target: HelpRect) {
  const cardRight = card.left + card.width
  const cardBottom = card.top + card.height
  const targetRight = target.left + target.width
  const targetBottom = target.top + target.height
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  let startX: number
  let startY: number
  let endX: number
  let endY: number
  if (targetRight <= card.left || target.left >= cardRight) {
    const towardRight = target.left >= cardRight
    startX = towardRight ? cardRight + 5 : card.left - 5
    startY = clamp(target.top + target.height / 2, card.top + 18, cardBottom - 18)
    endX = towardRight ? target.left - 5 : targetRight + 5
    endY = clamp(startY, target.top + 6, targetBottom - 6)
    const midX = (startX + endX) / 2
    return `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`
  }
  if (targetBottom <= card.top || target.top >= cardBottom) {
    const towardBottom = target.top >= cardBottom
    startX = clamp(target.left + target.width / 2, card.left + 18, cardRight - 18)
    startY = towardBottom ? cardBottom + 5 : card.top - 5
    endX = clamp(startX, target.left + 6, targetRight - 6)
    endY = towardBottom ? target.top - 5 : targetBottom + 5
    const midY = (startY + endY) / 2
    return `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`
  }
  // A target covered by the help surface cannot be connected honestly.
  return null
}
