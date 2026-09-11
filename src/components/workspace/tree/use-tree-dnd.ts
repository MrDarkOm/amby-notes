"use client"

import * as React from "react"
import { setTreeDragPayload, clearTreeDragPayload } from "@/lib/canvas-dnd"
import { ROOT_DROP_TARGET, isValidTreeDropTarget, type PtrDrag } from "./tree-types"
import type { TreeReorderPosition } from "../tree-sort"

type ReorderDropTarget =
  | { kind: "reorder"; targetId: string | null; position: TreeReorderPosition }
  | { kind: "move"; targetId: string }

export function useTreeDnd({
  onMoveItem,
  onReorderItems,
  selectedIds,
}: {
  onMoveItem?: (sourceIds: string[], targetId: string | null) => void
  onReorderItems?: (
    sourceIds: string[],
    targetId: string | null,
    position: TreeReorderPosition,
  ) => void
  selectedIds: ReadonlySet<string>
}) {
  const [ptrDrag, setPtrDrag] = React.useState<PtrDrag | null>(null)
  const ptrDragRef = React.useRef<PtrDrag | null>(null)
  const onMoveItemRef = React.useRef(onMoveItem)
  const onReorderItemsRef = React.useRef(onReorderItems)
  const reorderEnabledRef = React.useRef(Boolean(onReorderItems))
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

  React.useEffect(() => {
    onReorderItemsRef.current = onReorderItems
    reorderEnabledRef.current = Boolean(onReorderItems)
  }, [onReorderItems])

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

    function getReorderDropTarget(drag: PtrDrag, x: number, y: number): ReorderDropTarget | null {
      const el = document.elementFromPoint(x, y) as HTMLElement | null
      const targetEl = el?.closest("[data-tree-reorder-target]") as HTMLElement | null
      const targetId = targetEl?.getAttribute("data-tree-reorder-target")
      const targetPath = targetEl?.getAttribute("data-tree-reorder-target-path")
      if (targetEl && targetId && targetPath) {
        if (!isValidTreeDropTarget(drag.sourceId, drag.sourcePath, targetId, targetPath)) {
          return null
        }
        const rect = targetEl.getBoundingClientRect()
        const relativeY = rect.height > 0 ? (y - rect.top) / rect.height : 0
        if (
          targetEl.hasAttribute("data-tree-move-target") &&
          relativeY > 0.34 &&
          relativeY < 0.66
        ) {
          return { kind: "move", targetId }
        }
        return {
          kind: "reorder",
          targetId,
          position: relativeY < 0.5 ? "before" : "after",
        }
      }

      // The scroll container is a legacy root move target and surrounds every
      // row, so it must not be used to detect the manual-sort drop location.
      // The dedicated bottom zone is the only place that means "append".
      const rootTarget = el?.closest("[data-tree-root-drop-zone]")
      if (rootTarget) return { kind: "reorder", targetId: null, position: "end" }
      return null
    }

    function updateDragAtPoint(x: number, y: number) {
      const drag = ptrDragRef.current
      if (!drag) return
      const reorderTarget = reorderEnabledRef.current ? getReorderDropTarget(drag, x, y) : null
      const validTarget = reorderEnabledRef.current
        ? (reorderTarget?.targetId ?? null)
        : getValidTarget(drag, x, y)
      const dropPosition: TreeReorderPosition | null =
        reorderTarget?.kind === "reorder" ? reorderTarget.position : null
      setPtrDrag((prev) => {
        if (!prev) return null
        if (
          prev.ghostX === x &&
          prev.ghostY === y &&
          prev.targetId === validTarget &&
          prev.dropPosition === dropPosition
        )
          return prev
        return { ...prev, ghostX: x, ghostY: y, targetId: validTarget, dropPosition }
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
            dropPosition: null,
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
        if (reorderEnabledRef.current && onReorderItemsRef.current) {
          const dropTarget = getReorderDropTarget(drag, e.clientX, e.clientY)
          if (dropTarget?.kind === "reorder") {
            onReorderItemsRef.current(drag.sourceIds, dropTarget.targetId, dropTarget.position)
          } else if (dropTarget?.kind === "move") {
            onMoveItemRef.current?.(drag.sourceIds, dropTarget.targetId)
          }
        } else {
          const dropTarget = getValidTarget(drag, e.clientX, e.clientY) ?? drag.targetId
          if (dropTarget) onMoveItemRef.current?.(drag.sourceIds, dropTarget)
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
