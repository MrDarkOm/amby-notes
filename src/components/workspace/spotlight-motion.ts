/** Controls the Spotlight window grows out of. */
export const SPOTLIGHT_ORIGIN = {
  dockSearch: '[data-activity-button="search"]',
  newTab: '[data-spotlight-origin="new-tab"]',
} as const

/** Matches the `w-[640px]` class on the window. */
const SPOTLIGHT_WIDTH = 640
/** Matches the `top-[14%]` class on the window. */
const SPOTLIGHT_TOP_RATIO = 0.14

export const spotlightTransition = {
  default: { duration: 0.28, ease: [0.16, 1, 0.3, 1] },
  opacity: { duration: 0.12, ease: "easeOut" },
} as const

/**
 * The point inside the window that lines up with the control it was opened from, so the window
 * grows out of it. Null when the control is not on screen (a shortcut with the dock hidden).
 */
export function spotlightOriginFrom(selector: string | undefined): string | null {
  if (!selector || typeof document === "undefined") return null
  const button = document.querySelector<HTMLElement>(selector)
  const rect = button?.getBoundingClientRect()
  if (!rect || rect.width === 0 || rect.height === 0) return null
  const width = Math.min(SPOTLIGHT_WIDTH, window.innerWidth - 32)
  const left = (window.innerWidth - width) / 2
  const top = window.innerHeight * SPOTLIGHT_TOP_RATIO
  return `${rect.left + rect.width / 2 - left}px ${rect.top + rect.height / 2 - top}px`
}

/** How the window follows the height of its results. */
export const spotlightResizeTransition = { duration: 0.22, ease: [0.16, 1, 0.3, 1] } as const
