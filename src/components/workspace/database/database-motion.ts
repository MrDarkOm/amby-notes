import type { Transition } from "motion/react"
import { motionTransition, motionTransitions } from "@/lib/motion-config"

/** Cards that appear one after another only for the first few; later ones just fade. */
const STAGGER_LIMIT = 10
const STAGGER_STEP = 0.028

/** A soft spring for things that follow the pointer or land in a new place. */
export const cardSpring: Transition = {
  type: "spring",
  stiffness: 460,
  damping: 34,
  mass: 0.7,
}

export const cardRest = { opacity: 1, y: 0, scale: 1 }

/**
 * How a card enters: it rises and fades in, with a short stagger for the first
 * ones. `index` is the card's place in its list; a card that appears later (a
 * dropped card, a scrolled-in row) uses a plain quick fade.
 */
export function cardEnter(index: number | undefined): {
  initial: { opacity: number; y?: number; scale?: number } | false
  animate: typeof cardRest
  transition: Transition
} {
  if (index === undefined)
    return { initial: false, animate: cardRest, transition: motionTransitions.fast }
  const staggered = index < STAGGER_LIMIT
  return {
    initial: staggered ? { opacity: 0, y: 8 } : { opacity: 0, scale: 0.97 },
    animate: cardRest,
    transition: motionTransition(
      staggered
        ? { ...motionTransitions.enter, delay: index * STAGGER_STEP }
        : motionTransitions.default,
    ),
  }
}

/** The pencil on a card: hidden until the card is hovered or the pencil has focus. */
export const pencilVariants = {
  rest: { opacity: 0, scale: 0.8 },
  hover: { opacity: 1, scale: 1 },
}

/** A card lifts a little under the pointer. */
export const liftVariants = {
  rest: { y: 0 },
  hover: { y: -2 },
}
