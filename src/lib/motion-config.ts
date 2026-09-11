import type { Transition } from "motion/react"

export const motionTransitions = {
  instant: { duration: 0.01 },
  fast: { duration: 0.1, ease: "easeOut" },
  default: { duration: 0.15, ease: "easeOut" },
  enter: { duration: 0.18, ease: [0.16, 1, 0.3, 1] },
  panel: { duration: 0.32, ease: [0.16, 1, 0.3, 1] },
  slow: { duration: 0.3, ease: [0.16, 1, 0.3, 1] },
  reorder: { type: "spring", stiffness: 520, damping: 38, mass: 0.55 },
} satisfies Record<string, Transition>

export const floatingSurfaceInitial = {
  opacity: 0,
  scale: 0.96,
  y: -4,
}

export const floatingSurfaceAnimate = {
  opacity: 1,
  scale: 1,
  y: 0,
}

export function motionTransition(transition: Transition): Transition {
  if (typeof window === "undefined") return transition
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? motionTransitions.instant
    : transition
}
