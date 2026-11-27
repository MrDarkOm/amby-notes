import * as React from "react"
import { movePropertyId } from "../database/property-order"

export function useMotionPropertyOrder(
  sourceIds: string[],
  onCommit: (propertyIds: string[]) => Promise<void>,
) {
  const sourceKey = sourceIds.join("\u0000")
  const [order, setOrder] = React.useState(sourceIds)
  const [draggingId, setDraggingId] = React.useState<string | null>(null)
  const orderRef = React.useRef(sourceIds)
  const draggingRef = React.useRef<string | null>(null)
  const startOrderRef = React.useRef(sourceIds)

  React.useEffect(() => {
    if (draggingRef.current) return
    orderRef.current = sourceIds
    setOrder(sourceIds)
    // sourceKey intentionally represents the complete incoming order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey])

  const commitOrder = React.useCallback(
    async (next: string[], previous: string[]) => {
      try {
        await onCommit(next)
      } catch {
        orderRef.current = previous
        setOrder(previous)
      }
    },
    [onCommit],
  )

  const reorder = React.useCallback((next: string[]) => {
    orderRef.current = next
    setOrder(next)
  }, [])

  const startDrag = React.useCallback((propertyId: string) => {
    draggingRef.current = propertyId
    startOrderRef.current = [...orderRef.current]
    setDraggingId(propertyId)
  }, [])

  const endDrag = React.useCallback(() => {
    const previous = startOrderRef.current
    const next = orderRef.current
    draggingRef.current = null
    setDraggingId(null)
    if (previous.join("\u0000") !== next.join("\u0000")) {
      void commitOrder(next, previous)
    }
  }, [commitOrder])

  const moveWithKeyboard = React.useCallback(
    (propertyId: string, direction: -1 | 1) => {
      const previous = orderRef.current
      const index = previous.indexOf(propertyId)
      const targetIndex = index + direction
      if (index < 0 || targetIndex < 0 || targetIndex >= previous.length) return
      const next = movePropertyId(
        previous,
        propertyId,
        previous[targetIndex],
        direction < 0 ? "before" : "after",
      )
      orderRef.current = next
      setOrder(next)
      void commitOrder(next, previous)
    },
    [commitOrder],
  )

  const sourceSet = new Set(sourceIds)
  const currentOrder = order.filter((id) => sourceSet.has(id))
  const seen = new Set(currentOrder)
  currentOrder.push(...sourceIds.filter((id) => !seen.has(id)))
  return { order: currentOrder, draggingId, reorder, startDrag, endDrag, moveWithKeyboard }
}
