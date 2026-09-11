"use client"

import * as React from "react"
import { setTreeDragPayload, clearTreeDragPayload } from "@/lib/canvas-dnd"
import { ROOT_DROP_TARGET, isValidTreeDropTarget, type PtrDrag } from "./tree-types"

export function useTreeDnd({
  onMoveItem,
  selectedIds,
}: {
  onMoveItem?: (sourceIds: string[], targetId: string | null) => void
  selectedIds: ReadonlySet<string>
}) {
  const [ptrDrag, setPtrDrag] = React.useState<PtrDrag | null>(null)
  const ptrDragRef = React.useRef<PtrDrag | null>(null)
  const onMoveItemRef = React.useRef(onMoveItem)
  const pointerDownRef = React.useRef<{
    id: string
    sourceIds: string[]
    name: string
    path: string
    x: number
    y: number
  } | null>(null)
  const dragMoveFrameRef = React.useRef<number | null>(null)
  const latestDragPointRef = React.useRef<{ x: number; y: number } | null>(null)

  React.useEffect(() => {
    ptrDragRef.current = ptrDrag
  }, [ptrDrag])

  React.useEffect(() => {
    onMoveItemRef.current = onMoveItem
  }, [onMoveItem])

  const onPtrDragStart = React.useCallback(
    (id: string, name: string, path: string, x: number, y: number) => {
      pointerDownRef.current = {
        id,
        sourceIds: selectedIds.has(id) ? [...selectedIds] : [id],
        name,
        path,
        x,
        y,
      }
    },
    [selectedIds],
  )

  React.useEffect(() => {
    function getValidTarget(drag: PtrDrag, x: number, y: number) {
      const el = document.elementFromPoint(x, y) as HTMLElement | null
      const targetEl = el?.closest("[data-drag-target]") as HTMLElement | null
      const candidate = targetEl?.getAttribute("data-drag-target") ?? null
      const candidatePath = targetEl?.getAttribute("data-drag-target-path") ?? null
      return candidate === ROOT_DROP_TARGET
        ? ROOT_DROP_TARGET
        : candidate &&
            candidatePath &&
            isValidTreeDropTarget(drag.sourceId, drag.sourcePath, candidate, candidatePath)
          ? candidate
          : null
    }

    function updateDragAtPoint(x: number, y: number) {
      const drag = ptrDragRef.current
      if (!drag) return
      const validTarget = getValidTarget(drag, x, y)
      setPtrDrag((prev) => {
        if (!prev) return null
        if (prev.ghostX === x && prev.ghostY === y && prev.targetId === validTarget) return prev
        return { ...prev, ghostX: x, ghostY: y, targetId: validTarget }
      })
    }

    function scheduleDragMove(x: number, y: number) {
      latestDragPointRef.current = { x, y }
      if (dragMoveFrameRef.current !== null) return
      dragMoveFrameRef.current = requestAnimationFrame(() => {
        dragMoveFrameRef.current = null
        const point = latestDragPointRef.current
        if (point) updateDragAtPoint(point.x, point.y)
      })
    }

    function onMove(e: PointerEvent) {
      const pd = pointerDownRef.current
      const drag = ptrDragRef.current

      if (drag) {
        scheduleDragMove(e.clientX, e.clientY)
        return
      }

      if (pd) {
        const dx = Math.abs(e.clientX - pd.x)
        const dy = Math.abs(e.clientY - pd.y)
        if (dx > 5 || dy > 5) {
          const { id: startId, sourceIds, name: startName, path: startPath } = pd
          pointerDownRef.current = null
          const suppress = (ev: MouseEvent) => {
            ev.stopPropagation()
            ev.preventDefault()
            document.removeEventListener("click", suppress, true)
          }
          document.addEventListener("click", suppress, true)
          setTreeDragPayload({ id: startId, name: startName, path: startPath })
          setPtrDrag({
            sourceId: startId,
            sourceIds,
            sourceName: startName,
            sourcePath: startPath,
            startX: pd.x,
            startY: pd.y,
            ghostX: e.clientX,
            ghostY: e.clientY,
            active: true,
            targetId: null,
          })
        }
      }
    }

    function onUp(e: PointerEvent) {
      const drag = ptrDragRef.current
      pointerDownRef.current = null
      if (drag) {
        if (dragMoveFrameRef.current !== null) {
          cancelAnimationFrame(dragMoveFrameRef.current)
          dragMoveFrameRef.current = null
        }
        latestDragPointRef.current = null
        const dropTarget = getValidTarget(drag, e.clientX, e.clientY) ?? drag.targetId
        if (dropTarget) {
          onMoveItemRef.current?.(
            drag.sourceIds,
            dropTarget === ROOT_DROP_TARGET ? null : dropTarget,
          )
        }
        setPtrDrag(null)
      }
      setTimeout(() => clearTreeDragPayload(), 0)
    }

    document.addEventListener("pointermove", onMove)
    document.addEventListener("pointerup", onUp)
    return () => {
      document.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerup", onUp)
      if (dragMoveFrameRef.current !== null) {
        cancelAnimationFrame(dragMoveFrameRef.current)
        dragMoveFrameRef.current = null
      }
      latestDragPointRef.current = null
    }
  }, [])

  return {
    ptrDrag,
    onPtrDragStart,
  }
}
