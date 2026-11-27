import { useRef, useState, type PointerEvent } from "react"
import { useMotionValue } from "motion/react"

type Axis = "x" | "y"

interface PageDrag {
  from: number
  axis: Axis
  origin: number
  pointerId: number
  box: DOMRect
  targets: { index: number; center: number }[]
}

export function useNotePageDrag(onMove: (from: number, to: number) => void) {
  const pending = useRef<PageDrag | null>(null)
  const [preview, setPreview] = useState<(PageDrag & { to: number }) | null>(null)
  const offset = useMotionValue(0)

  const cancel = () => {
    pending.current = null
    setPreview(null)
  }
  const begin = (event: PointerEvent<HTMLElement>, from: number, axis: Axis) => {
    if (event.button !== 0 || event.ctrlKey || event.pointerType === "touch") return
    const group = event.currentTarget.closest("[data-note-page-reorder]")
    const targets = Array.from(
      group?.querySelectorAll<HTMLElement>("[data-note-page-drag-item]") ?? [],
    ).map((item) => {
      const box = item.getBoundingClientRect()
      return {
        index: Number(item.dataset.notePageDragItem),
        center: axis === "x" ? box.left + box.width / 2 : box.top + box.height / 2,
      }
    })
    if (targets.length < 2) return
    offset.set(0)
    pending.current = {
      from,
      axis,
      origin: axis === "x" ? event.clientX : event.clientY,
      pointerId: event.pointerId,
      box: event.currentTarget.getBoundingClientRect(),
      targets,
    }
  }

  const targetAt = (event: PointerEvent<HTMLElement>, drag: PageDrag) => {
    const point = drag.axis === "x" ? event.clientX : event.clientY
    const bounds = event.currentTarget.getBoundingClientRect()
    const across = drag.axis === "x" ? event.clientY : event.clientX
    const low = drag.axis === "x" ? bounds.top : bounds.left
    const high = drag.axis === "x" ? bounds.bottom : bounds.right
    if (across < low - 12 || across > high + 12) return drag.from
    return drag.targets.reduce((best, target) =>
      Math.abs(target.center - point) < Math.abs(best.center - point) ? target : best,
    ).index
  }

  const groupProps = {
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const drag = pending.current
      if (!drag || event.pointerId !== drag.pointerId) return
      const delta = (drag.axis === "x" ? event.clientX : event.clientY) - drag.origin
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        if (Math.abs(delta) < 6) return
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      event.preventDefault()
      offset.set(delta)
      const to = targetAt(event, drag)
      setPreview((current) => (current?.to === to ? current : { ...drag, to }))
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const drag = pending.current
      if (!drag || event.pointerId !== drag.pointerId) return
      const moved = event.currentTarget.hasPointerCapture(event.pointerId)
      cancel()
      if (moved) {
        event.preventDefault()
        const to = targetAt(event, drag)
        if (drag.from !== to) onMove(drag.from, to)
      }
    },
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
  }

  const orderFor = (length: number, axis: Axis) => {
    const order = Array.from({ length }, (_, index) => index)
    if (preview?.axis === axis && preview.from !== preview.to) {
      const [source] = order.splice(preview.from, 1)
      order.splice(preview.to, 0, source)
    }
    return order
  }
  return { begin, cancel, groupProps, offset, orderFor, preview }
}
