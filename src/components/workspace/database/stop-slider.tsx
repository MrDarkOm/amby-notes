"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

interface StopSliderProps<T extends string> {
  /** The stops, in order. */
  stops: readonly T[]
  value: T
  /** Names a stop for assistive technology and the current-value text. */
  label: (stop: T) => string
  ariaLabel: string
  disabled?: boolean
  onChange: (stop: T) => void
  className?: string
}

/**
 * A slider with a few fixed positions drawn as dots: press or drag along the line,
 * or use the arrow keys. The chosen stop is the large filled dot.
 */
export function StopSlider<T extends string>({
  stops,
  value,
  label,
  ariaLabel,
  disabled = false,
  onChange,
  className,
}: StopSliderProps<T>) {
  const trackRef = React.useRef<HTMLDivElement>(null)
  const dragging = React.useRef(false)
  const index = Math.max(0, stops.indexOf(value))
  const last = stops.length - 1

  const pick = (clientX: number) => {
    const track = trackRef.current
    if (!track || last < 1) return
    const rect = track.getBoundingClientRect()
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
    const next = stops[Math.min(last, Math.max(0, Math.round(ratio * last)))]
    if (next !== value) onChange(next)
  }

  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={index}
      aria-valuetext={label(value)}
      title={label(value)}
      aria-disabled={disabled || undefined}
      className={cn(
        "relative h-6 w-28 shrink-0 touch-none rounded-full px-2 outline-none focus-visible:ring-1 focus-visible:ring-ring",
        disabled ? "pointer-events-none opacity-50" : "cursor-pointer",
        className,
      )}
      onPointerDown={(event) => {
        if (disabled) return
        dragging.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
        pick(event.clientX)
      }}
      onPointerMove={(event) => dragging.current && pick(event.clientX)}
      onPointerUp={(event) => {
        dragging.current = false
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
      onKeyDown={(event) => {
        const step =
          event.key === "ArrowRight" || event.key === "ArrowUp"
            ? 1
            : event.key === "ArrowLeft" || event.key === "ArrowDown"
              ? -1
              : 0
        const target =
          event.key === "Home" ? 0 : event.key === "End" ? last : step ? index + step : null
        if (target === null) return
        event.preventDefault()
        onChange(stops[Math.min(last, Math.max(0, target))])
      }}
    >
      <div ref={trackRef} className="relative h-full">
        <span className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-border" />
        <span
          className="absolute left-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-primary"
          style={{ width: `${last > 0 ? (index / last) * 100 : 0}%` }}
        />
        {stops.map((stop, position) => (
          <span
            key={stop}
            aria-hidden="true"
            className={cn(
              "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full",
              position === index
                ? "size-3.5 bg-primary shadow-sm ring-4 ring-primary/20"
                : position < index
                  ? "size-2 bg-primary"
                  : "size-2 bg-border",
            )}
            style={{ left: `${last > 0 ? (position / last) * 100 : 0}%` }}
          />
        ))}
      </div>
    </div>
  )
}
