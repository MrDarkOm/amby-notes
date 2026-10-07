import * as React from "react"
import { motion } from "motion/react"
import { motionTransition, motionTransitions } from "@/lib/motion-config"
import { cardEnter, liftVariants } from "../database-motion"

/** Handlers whose types differ between React and motion; cards use none of them. */
type Conflicting =
  "onClick" | "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart" | "onAnimationEnd"

interface CardSurfaceProps extends Omit<React.HTMLAttributes<HTMLDivElement>, Conflicting> {
  onOpen?: () => void
  disabled?: boolean
  /** Rises a little under the pointer. Off for dense rows. */
  lift?: boolean
  /** Place in the list: set it and the card enters with a fade and rise. */
  enterIndex?: number
  /** Where the card sits while a row of the list is dragged; set, it replaces the entrance. */
  shift?: { y: number; instant: boolean }
}

/**
 * A card that opens its record on click or Enter/Space. It is a `div`, not a
 * `button`, because cards hold editable property controls, and keys typed in
 * those controls must not open or move the card. Its `rest`/`hover` variants
 * reach children such as the pencil.
 */
export function CardSurface({
  onOpen,
  disabled,
  onKeyDown,
  children,
  lift = false,
  enterIndex,
  shift,
  ...rest
}: CardSurfaceProps) {
  const enter = cardEnter(enterIndex)
  return (
    <motion.div
      {...rest}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      variants={lift ? liftVariants : { rest: {}, hover: {} }}
      initial={enter.initial === false ? "rest" : { ...enter.initial }}
      animate={
        shift ? { y: shift.y, opacity: 1 } : enter.initial === false ? undefined : enter.animate
      }
      whileHover={disabled ? undefined : "hover"}
      whileTap={lift && !disabled ? { scale: 0.992 } : undefined}
      transition={
        shift
          ? motionTransition(shift.instant ? motionTransitions.instant : motionTransitions.reorder)
          : enter.initial === false
            ? motionTransition(motionTransitions.fast)
            : enter.transition
      }
      onClick={disabled ? undefined : onOpen}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented || disabled || event.target !== event.currentTarget) return
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onOpen?.()
        }
      }}
    >
      {children}
    </motion.div>
  )
}
