"use client"

import * as React from "react"
import { animate, type AnimationPlaybackControls } from "motion/react"

import { motionTransitions } from "@/lib/motion-config"

const INSET = 6
const IDLE_MS = 900

/**
 * A thin scrollbar drawn over the file tree instead of the native one.
 *
 * The native bar takes width from the rows, so the list either shifts sideways when it
 * appears or keeps an empty strip reserved on the right. This one floats above the rows:
 * the native bar is hidden (`.amby-tree-scroll`), nothing is reserved, and the thumb fades in
 * only while the list scrolls or the pointer is on it.
 */
export function TreeScrollbar({ scrollRef }: { scrollRef: React.RefObject<HTMLElement | null> }) {
  const stripRef = React.useRef<HTMLDivElement>(null)
  const thumbRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const scroller = scrollRef.current
    const strip = stripRef.current
    const thumb = thumbRef.current
    if (!scroller || !strip || !thumb) return

    let idleTimer: number | undefined
    let frame = 0
    let scrolling = false
    let hovering = false
    let drag: { startY: number; startScroll: number; ratio: number } | null = null
    let fade: AnimationPlaybackControls | undefined
    let shown = false

    // The thumb is drawn while the list scrolls, while the pointer is on it and while it is dragged.
    const syncVisibility = () => {
      const next = scrolling || hovering || drag !== null
      if (next === shown) return
      shown = next
      fade?.stop()
      fade = animate(thumb, { opacity: next ? 1 : 0 }, motionTransitions.default)
    }

    const track = () => Math.max(scroller.clientHeight - INSET * 2, 0)

    const place = () => {
      frame = 0
      const { scrollHeight, clientHeight, scrollTop } = scroller
      const overflow = clientHeight > 0 && scrollHeight > clientHeight + 1
      strip.hidden = !overflow
      if (!overflow) return
      const length = track()
      const size = Math.max((clientHeight / scrollHeight) * length, 36)
      const travel = length - size
      const progress = scrollTop / (scrollHeight - clientHeight)
      thumb.style.height = `${size}px`
      thumb.style.transform = `translateY(${INSET + progress * travel}px)`
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place)
    }

    const reveal = () => {
      scrolling = true
      syncVisibility()
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => {
        scrolling = false
        syncVisibility()
      }, IDLE_MS)
    }
    const onScroll = () => {
      schedule()
      reveal()
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      event.preventDefault()
      const { scrollHeight, clientHeight } = scroller
      const size = thumb.offsetHeight
      drag = {
        startY: event.clientY,
        startScroll: scroller.scrollTop,
        ratio: (scrollHeight - clientHeight) / Math.max(track() - size, 1),
      }
      thumb.setPointerCapture(event.pointerId)
      syncVisibility()
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!drag) return
      scroller.scrollTop = drag.startScroll + (event.clientY - drag.startY) * drag.ratio
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!drag) return
      drag = null
      if (thumb.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId)
      syncVisibility()
    }

    const onEnter = () => {
      hovering = true
      syncVisibility()
    }
    const onLeave = () => {
      hovering = false
      syncVisibility()
    }

    place()
    scroller.addEventListener("scroll", onScroll, { passive: true })
    thumb.addEventListener("pointerdown", onPointerDown)
    thumb.addEventListener("pointerenter", onEnter)
    thumb.addEventListener("pointerleave", onLeave)
    thumb.addEventListener("pointermove", onPointerMove)
    thumb.addEventListener("pointerup", onPointerUp)
    thumb.addEventListener("pointercancel", onPointerUp)
    // The content decides how much there is to scroll; the panel decides how much is shown.
    const observer = new ResizeObserver(schedule)
    observer.observe(scroller)
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild)
    return () => {
      observer.disconnect()
      scroller.removeEventListener("scroll", onScroll)
      thumb.removeEventListener("pointerdown", onPointerDown)
      thumb.removeEventListener("pointerenter", onEnter)
      thumb.removeEventListener("pointerleave", onLeave)
      thumb.removeEventListener("pointermove", onPointerMove)
      thumb.removeEventListener("pointerup", onPointerUp)
      thumb.removeEventListener("pointercancel", onPointerUp)
      window.clearTimeout(idleTimer)
      cancelAnimationFrame(frame)
      fade?.stop()
    }
  }, [scrollRef])

  return (
    <div ref={stripRef} className="amby-tree-scrollbar" hidden aria-hidden="true">
      <div ref={thumbRef} className="amby-tree-scrollbar-thumb" />
    </div>
  )
}
