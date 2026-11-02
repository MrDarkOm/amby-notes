import {
  DRAGGABLE_TYPES,
  type DragRowTarget,
  type HandleState,
  type HoverTarget,
  findDraggableAncestor,
  findScrollAncestor,
} from "./block-handles-geometry"
import * as React from "react"
import type { Editor } from "@tiptap/react"
import type { ResolvedPos } from "@tiptap/pm/model"
import { animate } from "motion/react"
import { motionTransition, motionTransitions } from "@/lib/motion-config"
import { blockContentRect, blockSideAtPoint, blockInsertionLineTop } from "./block-drop-geometry"
import { CLOSE_EDITOR_MENUS_EVENT } from "./floating-menu-events"
import {
  createColumnsFromDrop,
  moveBlockAcrossColumns,
  type ColumnDropSide,
} from "./columns-transaction"

interface UseBlockDragParams {
  dragRef: React.RefObject<{ srcPos: number; startX: number; startY: number; active: boolean }>
  handle: HandleState
  setInsertPanel: React.Dispatch<React.SetStateAction<{ open: boolean; anchorPos: number }>>
  setActionsOpen: React.Dispatch<React.SetStateAction<boolean>>
  editor: Editor
  ghostRef: React.RefObject<HTMLElement | null>
  handlesRef: React.RefObject<HTMLDivElement | null>
  pinnedTargetRef: React.RefObject<HoverTarget | null>
}

export function useBlockDrag({
  dragRef,
  handle,
  setInsertPanel,
  setActionsOpen,
  editor,
  ghostRef,
  handlesRef,
  pinnedTargetRef,
}: UseBlockDragParams) {
  // ── Pointer-based drag ────────────────────────────────────────────────────
  const startDrag = React.useCallback(
    (e: React.PointerEvent) => {
      // macOS Ctrl+click is a context-menu gesture, not the start of a drag.
      if (e.button !== 0 || e.ctrlKey) return
      e.preventDefault()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      dragRef.current = {
        srcPos: handle.nodePos,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
      }
      setInsertPanel({ open: false, anchorPos: -1 })
      setActionsOpen(false)

      const view = editor.view
      const editorDom = view.dom as HTMLElement
      const scrollContainer = findScrollAncestor(editorDom)

      const AUTOSCROLL_ZONE = 60
      const AUTOSCROLL_MAX_SPEED = 18
      let scrollRaf: number | null = null
      let dragRaf: number | null = null
      let lastX = e.clientX
      let lastY = e.clientY
      let dragRows: DragRowTarget[] = []
      let dragRowsScrollTop = scrollContainer.scrollTop

      function tickScroll() {
        scrollRaf = null
        const rect = scrollContainer.getBoundingClientRect()
        const distTop = lastY - rect.top
        const distBot = rect.bottom - lastY
        let delta = 0
        if (distTop < AUTOSCROLL_ZONE) {
          const t = 1 - Math.max(0, distTop) / AUTOSCROLL_ZONE
          delta = -Math.ceil(t * t * AUTOSCROLL_MAX_SPEED)
        } else if (distBot < AUTOSCROLL_ZONE) {
          const t = 1 - Math.max(0, distBot) / AUTOSCROLL_ZONE
          delta = Math.ceil(t * t * AUTOSCROLL_MAX_SPEED)
        }
        if (delta !== 0) {
          scrollContainer.scrollTop += delta
          updateIndicator(lastX, lastY)
          scrollRaf = requestAnimationFrame(tickScroll)
        }
      }
      function maybeStartScroll() {
        if (scrollRaf == null) scrollRaf = requestAnimationFrame(tickScroll)
      }
      function stopScroll() {
        if (scrollRaf != null) {
          cancelAnimationFrame(scrollRaf)
          scrollRaf = null
        }
      }

      function positionGhost(x: number, y: number) {
        const wrapper = ghostRef.current
        if (!wrapper) return
        const ox = Number(wrapper.dataset.offsetX || 0)
        const oy = Number(wrapper.dataset.offsetY || 0)
        wrapper.style.transform = `translate3d(${x - ox}px, ${y - oy}px, 0)`
      }

      let indicatorEl: HTMLElement | null = null

      function collectDragRows() {
        const { doc } = view.state
        const seen = new Set<number>()
        const rows: DragRowTarget[] = []

        doc.descendants((node, pos) => {
          if (!DRAGGABLE_TYPES.has(node.type.name)) return true

          // Resolve the same logical row that owns the Grab. In particular,
          // paragraphs inside callouts and list items resolve to their visual
          // container instead of becoming overlapping drop targets.
          const probe = Math.min(pos + 1, doc.content.size)
          let target = findDraggableAncestor(doc.resolve(probe))
          if (!target || target.pos > pos || target.pos + target.node.nodeSize <= pos) {
            target = { pos, depth: doc.resolve(pos).depth + 1, node }
          }
          if (!target || seen.has(target.pos)) return true
          const element = view.nodeDOM(target.pos)
          if (!(element instanceof HTMLElement) || !element.isConnected) return true
          const rect = element.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return true

          seen.add(target.pos)
          rows.push({
            pos: target.pos,
            depth: target.depth,
            node: target.node,
            element,
            rect,
            contentRect: blockContentRect(element),
          })

          // Keep walking: duplicate children collapse through `seen`, while a
          // genuinely nested list item still needs its own reorder row.
          return true
        })

        dragRows = rows
        dragRowsScrollTop = scrollContainer.scrollTop
      }

      function currentRowRect(row: DragRowTarget): DOMRect {
        const scrollDelta = dragRowsScrollTop - scrollContainer.scrollTop
        return new DOMRect(
          row.rect.left,
          row.rect.top + scrollDelta,
          row.rect.width,
          row.rect.height,
        )
      }

      function findClosestDragRow(clientX: number, clientY: number) {
        const viewport = (
          editorDom.closest(".amby-editor-scroll") ?? scrollContainer
        ).getBoundingClientRect()
        if (
          clientX < viewport.left ||
          clientX > viewport.right ||
          clientY < viewport.top - 16 ||
          clientY > viewport.bottom + 16
        )
          return null

        let closest: { row: DragRowTarget; rect: DOMRect } | null = null
        let closestScore = Number.POSITIVE_INFINITY
        for (const row of dragRows) {
          if (!row.element.isConnected) continue
          const rect = currentRowRect(row)
          const yDistance =
            clientY < rect.top
              ? rect.top - clientY
              : clientY > rect.bottom
                ? clientY - rect.bottom
                : 0
          const xDistance =
            clientX < rect.left
              ? rect.left - clientX
              : clientX > rect.right
                ? clientX - rect.right
                : 0
          // Vertical order is authoritative, matching Motion's y-axis
          // Reorder.Group used by properties. Horizontal distance only chooses
          // between columns that share the same vertical band.
          const score = yDistance * 10_000 + xDistance * 10 - row.depth
          if (score < closestScore) {
            closestScore = score
            closest = { row, rect }
          }
        }
        return closest
      }

      function showIndicatorAt(rect: DOMRect, top: number, crossColumn = false) {
        if (!indicatorEl) {
          indicatorEl = document.createElement("div")
          indicatorEl.className = "amby-block-drop-indicator"
          document.body.appendChild(indicatorEl)
        }
        indicatorEl.className = crossColumn
          ? "amby-block-drop-indicator amby-block-drop-indicator--cross-column"
          : "amby-block-drop-indicator"
        indicatorEl.style.height = crossColumn ? "4px" : "2px"
        indicatorEl.style.left = `${rect.left}px`
        indicatorEl.style.width = `${rect.width}px`
        indicatorEl.style.top = `${top - (crossColumn ? 2 : 1)}px`
      }
      function showSideIndicator(rect: DOMRect, side: ColumnDropSide) {
        if (!indicatorEl) {
          indicatorEl = document.createElement("div")
          document.body.appendChild(indicatorEl)
        }
        indicatorEl.className = "amby-block-drop-indicator amby-block-drop-indicator--column"
        indicatorEl.style.left = `${side === "left" ? rect.left : rect.right - 3}px`
        indicatorEl.style.top = `${rect.top}px`
        indicatorEl.style.width = "3px"
        indicatorEl.style.height = `${rect.height}px`
      }
      function hideIndicator() {
        if (indicatorEl) {
          indicatorEl.remove()
          indicatorEl = null
        }
      }

      function updateIndicator(
        clientX: number,
        clientY: number,
        sourcePos = dragRef.current.srcPos,
      ): {
        targetPos: number
        before: boolean
        side: ColumnDropSide | null
      } | null {
        const closest = findClosestDragRow(clientX, clientY)
        if (!closest) {
          hideIndicator()
          return null
        }
        const { doc } = view.state
        const targetPos = closest.row.pos
        const targetNode = doc.nodeAt(targetPos)
        if (!targetNode) {
          hideIndicator()
          return null
        }
        const rect = closest.rect
        const $source =
          sourcePos >= 0 && sourcePos <= doc.content.size ? doc.resolve(sourcePos) : null
        const sourceIsTopLevel = $source?.depth === 0
        const sourceIsSoleColumnBlock =
          $source?.parent.type.name === "column" && $source.parent.childCount === 1
        const targetIsColumnBlock = doc.resolve(targetPos).parent.type.name === "column"
        const originalContent = closest.row.contentRect
        const contentRect = new DOMRect(
          originalContent.left,
          originalContent.top + dragRowsScrollTop - scrollContainer.scrollTop,
          originalContent.width,
          originalContent.height,
        )
        const side =
          sourceIsTopLevel || sourceIsSoleColumnBlock
            ? blockSideAtPoint(contentRect, clientX, clientY)
            : null
        const canCreateColumns =
          side && sourcePos >= 0 && (sourceIsTopLevel || targetIsColumnBlock)
            ? createColumnsFromDrop(view.state, sourcePos, targetPos, side) !== null
            : false
        if (side && canCreateColumns) {
          showSideIndicator(contentRect, side)
          return { targetPos, before: false, side }
        }
        const before = clientY < rect.top + rect.height / 2
        const lineTop = blockInsertionLineTop(view, targetPos, rect, before)

        showIndicatorAt(rect, lineTop, targetIsColumnBlock)
        return { targetPos, before, side: null }
      }

      function onMove(ev: PointerEvent) {
        ev.preventDefault()
        lastX = ev.clientX
        lastY = ev.clientY
        const d = dragRef.current
        if (!d.active) {
          const dx = ev.clientX - d.startX
          const dy = ev.clientY - d.startY
          if (dx * dx + dy * dy < 25) return // 5 px threshold
          d.active = true
          document.body.style.cursor = "grabbing"
          editorDom.style.userSelect = "none"

          const srcDom = view.nodeDOM(d.srcPos)
          if (srcDom instanceof HTMLElement) {
            const rect = srcDom.getBoundingClientRect()
            const ghost = srcDom.cloneNode(true) as HTMLElement
            const ghostWrapper = document.createElement("div")
            ghostWrapper.className = "amby-block-drag-ghost-wrapper"
            ghost.classList.add("amby-block-drag-ghost")
            ghost.style.width = `${rect.width}px`
            ghost.style.maxWidth = `${rect.width}px`
            ghostWrapper.dataset.offsetX = String(d.startX - rect.left)
            ghostWrapper.dataset.offsetY = String(d.startY - rect.top)
            ghostWrapper.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`
            ghostWrapper.appendChild(ghost)
            document.body.appendChild(ghostWrapper)
            ghostRef.current = ghostWrapper
            collectDragRows()
            positionGhost(ev.clientX, ev.clientY)
            srcDom.classList.add("amby-block-drag-source")
            // Motion is decorative here: a browser animation failure must
            // never abort the functional pointermove/drop pipeline.
            try {
              animate(
                ghost,
                { opacity: [0, 0.92], scale: [0.975, 1.015], y: [3, 0] },
                motionTransition(motionTransitions.reorder),
              )
            } catch {
              ghost.style.opacity = "0.92"
            }
            if (handlesRef.current) {
              try {
                animate(
                  handlesRef.current,
                  { opacity: 0.35 },
                  motionTransition(motionTransitions.fast),
                )
              } catch {
                handlesRef.current.style.opacity = "0.35"
              }
            }
          }
        }
        // Geometry reads and visual writes are capped at one pass per paint.
        // This keeps the ghost attached to the pointer even across large notes.
        if (dragRaf == null) {
          dragRaf = requestAnimationFrame(() => {
            dragRaf = null
            updateIndicator(lastX, lastY)
            positionGhost(lastX, lastY)
            maybeStartScroll()
          })
        }
      }

      function cleanupGhost() {
        const ghostWrapper = ghostRef.current
        ghostRef.current = null
        if (ghostWrapper) {
          const ghost = ghostWrapper.firstElementChild
          if (ghost instanceof HTMLElement) {
            try {
              animate(
                ghost,
                { opacity: 0, scale: 0.985, y: 2 },
                motionTransition(motionTransitions.fast),
              )
              window.setTimeout(() => ghostWrapper.remove(), 140)
            } catch {
              ghostWrapper.remove()
            }
          } else {
            ghostWrapper.remove()
          }
        }
        if (handlesRef.current) {
          try {
            animate(handlesRef.current, { opacity: 1 }, motionTransition(motionTransitions.fast))
          } catch {
            handlesRef.current.style.opacity = "1"
          }
        }
        document.querySelectorAll<HTMLElement>(".amby-block-drag-source").forEach((element) => {
          element.classList.remove("amby-block-drag-source")
          try {
            const controls = animate(
              element,
              { opacity: 1 },
              motionTransition(motionTransitions.fast),
            )
            void controls.then(() => element.style.removeProperty("opacity"))
          } catch {
            element.style.removeProperty("opacity")
          }
        })
      }

      function onUp(ev: PointerEvent) {
        document.removeEventListener("pointermove", onMove)
        document.removeEventListener("pointerup", onUp)
        document.removeEventListener("pointercancel", onUp)
        document.body.style.cursor = ""
        editorDom.style.userSelect = ""
        stopScroll()
        if (dragRaf != null) {
          cancelAnimationFrame(dragRaf)
          dragRaf = null
        }
        cleanupGhost()

        const d = dragRef.current
        const wasActive = d.active
        const srcPos = d.srcPos
        dragRef.current = { srcPos: -1, startX: 0, startY: 0, active: false }

        if (!wasActive) {
          hideIndicator()
          pinnedTargetRef.current = {
            mode: "block",
            nodePos: handle.nodePos,
            nodeType: handle.nodeType,
          }
          window.dispatchEvent(new Event(CLOSE_EDITOR_MENUS_EVENT))
          setActionsOpen((v) => {
            if (v) pinnedTargetRef.current = null
            return !v
          })
          setInsertPanel({ open: false, anchorPos: -1 })
          return
        }

        if (srcPos < 0) {
          hideIndicator()
          return
        }
        const target = updateIndicator(ev.clientX, ev.clientY, srcPos)
        hideIndicator()
        if (!target) return

        const { state, dispatch } = view
        const { doc } = state
        const srcNode = doc.nodeAt(srcPos)
        const targetNode = doc.nodeAt(target.targetPos)
        if (!srcNode || !targetNode) return

        if (target.side) {
          const tr = createColumnsFromDrop(state, srcPos, target.targetPos, target.side)
          if (tr) dispatch(tr.setMeta("uiEvent", "drop"))
          return
        }

        const srcEnd = srcPos + srcNode.nodeSize
        const insertPos = target.before ? target.targetPos : target.targetPos + targetNode.nodeSize

        // No-op: dropping into our own slot (immediately before or after self).
        if (insertPos === srcPos || insertPos === srcEnd) return
        // Dropping strictly inside the source — invalid for container draggables.
        if (insertPos > srcPos && insertPos < srcEnd) return

        const $src = doc.resolve(srcPos)
        const $ins = doc.resolve(insertPos)
        const crossColumn = moveBlockAcrossColumns(state, srcPos, target.targetPos, target.before)
        if (crossColumn) {
          dispatch(crossColumn.setMeta("uiEvent", "drop"))
          return
        }
        const parentKey = ($p: ResolvedPos) => ($p.depth === 0 ? -1 : $p.before($p.depth))
        if (parentKey($src) !== parentKey($ins)) {
          return
        }

        const tr = state.tr
        tr.delete(srcPos, srcEnd)
        const mappedInsert = tr.mapping.map(insertPos, -1)
        try {
          tr.insert(mappedInsert, srcNode)
          if (tr.docChanged) dispatch(tr.setMeta("uiEvent", "drop"))
        } catch {
          /* swallow */
        }
      }

      document.addEventListener("pointermove", onMove)
      document.addEventListener("pointerup", onUp)
      document.addEventListener("pointercancel", onUp)
    },
    [
      editor,
      handle.nodePos,
      handle.nodeType,
      dragRef,
      ghostRef,
      handlesRef,
      pinnedTargetRef,
      setActionsOpen,
      setInsertPanel,
    ],
  )
  return { startDrag }
}
