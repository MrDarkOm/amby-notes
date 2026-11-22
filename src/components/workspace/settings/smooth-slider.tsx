import * as React from "react"
import { motion } from "motion/react"
import { motionTransition, motionTransitions } from "@/lib/motion-config"
import { cn } from "@/lib/utils"

interface SmoothSliderProps {
  value: number
  min: number
  max: number
  /** The smallest change; values are whole multiples of it. */
  step?: number
  /** The change with Shift or Page Up / Page Down. */
  bigStep?: number
  /** A value the thumb settles on when it is let go close to it (the default). */
  snap?: number
  /** The value as shown beside the slider and read out by assistive technology. */
  format: (value: number) => string
  /** Width of the value text, so the slider does not shift as the text changes. */
  valueClassName?: string
  ariaLabel: string
  disabled?: boolean
  /** Every move while dragging or pressing keys, for a live preview. */
  onPreview?: (value: number) => void
  /** The value to keep, once the drag ends or a key is pressed. */
  onChange: (value: number) => void
  className?: string
}

/** How close to `snap`, as a share of the range, a released thumb settles on it. */
const SNAP_SHARE = 0.04

/**
 * A continuous slider: press or drag along the line, or use the arrow keys (Shift for bigger
 * steps). The thumb follows the pointer while dragging and glides to a pressed spot; the value is
 * shown beside it.
 */
export function SmoothSlider({
  value,
  min,
  max,
  step = 1,
  bigStep = step * 10,
  snap,
  format,
  valueClassName,
  ariaLabel,
  disabled = false,
  onPreview,
  onChange,
  className,
}: SmoothSliderProps) {
  const trackRef = React.useRef<HTMLDivElement>(null)
  const [draft, setDraft] = React.useState<number | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const [hover, setHover] = React.useState(false)
  const shown = draft ?? value
  const clamp = (next: number) =>
    Math.min(max, Math.max(min, min + Math.round((next - min) / step) * step))
  const settle = (next: number) =>
    snap !== undefined && Math.abs(next - snap) <= (max - min) * SNAP_SHARE ? snap : next

  const at = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return shown
    return clamp(min + ((clientX - rect.left) / rect.width) * (max - min))
  }

  const preview = (next: number) => {
    setDraft(next)
    onPreview?.(next)
  }

  const commit = (next: number) => {
    setDraft(null)
    if (next !== value) onChange(next)
    else onPreview?.(next)
  }

  const ratio = max > min ? (shown - min) / (max - min) : 0
  const glide = motionTransition(dragging ? motionTransitions.instant : motionTransitions.enter)

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown}
        aria-valuetext={format(shown)}
        aria-disabled={disabled || undefined}
        className={cn(
          "relative h-6 w-32 shrink-0 touch-none rounded-full px-2 outline-none focus-visible:ring-1 focus-visible:ring-ring",
          disabled ? "pointer-events-none opacity-50" : "cursor-pointer",
        )}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onPointerDown={(event) => {
          if (disabled) return
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
          preview(at(event.clientX))
        }}
        onPointerMove={(event) => dragging && preview(at(event.clientX))}
        onPointerUp={(event) => {
          if (!dragging) return
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          setDragging(false)
          commit(settle(at(event.clientX)))
        }}
        onPointerCancel={() => {
          setDragging(false)
          commit(shown)
        }}
        onKeyDown={(event) => {
          const change = event.shiftKey || event.key.startsWith("Page") ? bigStep : step
          const delta =
            event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "PageUp"
              ? change
              : event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "PageDown"
                ? -change
                : 0
          const target =
            event.key === "Home" ? min : event.key === "End" ? max : delta ? shown + delta : null
          if (target === null) return
          event.preventDefault()
          commit(clamp(target))
        }}
      >
        <div ref={trackRef} className="relative h-full">
          <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-border" />
          {snap !== undefined && (
            <span
              aria-hidden="true"
              className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-muted-foreground/40"
              style={{ left: `${((snap - min) / (max - min)) * 100}%` }}
            />
          )}
          <motion.span
            aria-hidden="true"
            className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary"
            initial={false}
            animate={{ width: `${ratio * 100}%` }}
            transition={glide}
          />
          <motion.span
            aria-hidden="true"
            className="absolute top-1/2 -ml-2 -mt-2 size-4 rounded-full border-2 border-primary bg-background shadow-sm"
            initial={false}
            animate={{
              left: `${ratio * 100}%`,
              scale: dragging ? 1.2 : hover ? 1.1 : 1,
              boxShadow: dragging
                ? "0 0 0 5px color-mix(in srgb, var(--primary) 20%, transparent)"
                : "0 0 0 0px color-mix(in srgb, var(--primary) 0%, transparent)",
            }}
            transition={{ ...glide, scale: motionTransition(motionTransitions.default) }}
          />
        </div>
      </div>
      <span
        className={cn(
          "w-10 text-right text-[12px] tabular-nums whitespace-nowrap text-muted-foreground",
          valueClassName,
        )}
      >
        {format(shown)}
      </span>
    </div>
  )
}
