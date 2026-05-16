"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/react"
import {
  Copy,
  Droplet,
  GripVertical,
  Plus,
  Trash2,
} from "lucide-react"

import { INLINE_INSERT_ITEMS } from "./block-insert-items"

const CALLOUT_SWATCHES: Array<{ id: string; label: string; color?: string }> = [
  { id: "teal", label: "Teal", color: "rgba(20, 184, 166, 0.45)" },
  { id: "orange", label: "Orange", color: "rgba(245, 158, 11, 0.55)" },
  { id: "blue", label: "Blue", color: "rgba(14, 165, 233, 0.55)" },
  { id: "green", label: "Green", color: "rgba(34, 197, 94, 0.55)" },
  { id: "red", label: "Red", color: "rgba(239, 68, 68, 0.55)" },
  { id: "purple", label: "Purple", color: "rgba(168, 85, 247, 0.55)" },
  { id: "zinc", label: "Zinc", color: "rgba(113, 113, 122, 0.55)" },
  { id: "none", label: "Без фона" },
]

function clearDragIndicators() {
  document.querySelectorAll("[data-drag-before],[data-drag-after]").forEach(el => {
    el.removeAttribute("data-drag-before")
    el.removeAttribute("data-drag-after")
  })
}

// top/left are NOT in state — they're written directly to the DOM ref so that
// scroll updates bypass the React re-render cycle and have zero visible lag.
interface HandleState {
  visible: boolean
  nodePos: number
  nodeType: string
}

const HANDLES_WIDTH = 46 // 22 + 2 gap + 22
const BUTTON_H = 22

export function BlockHandles({ editor }: { editor: Editor }) {
  const [handle, setHandle] = React.useState<HandleState>({
    visible: false,
    nodePos: -1,
    nodeType: "",
  })
  const [insertOpen, setInsertOpen] = React.useState(false)
  const [actionsOpen, setActionsOpen] = React.useState(false)

  // Direct DOM ref for position updates — no React state, no render-cycle lag.
  const handlesRef = React.useRef<HTMLDivElement>(null)
  const posRef = React.useRef({ top: 0, left: 0 })

  const dragRef = React.useRef<{
    srcPos: number
    startX: number
    startY: number
    active: boolean
  }>({ srcPos: -1, startX: 0, startY: 0, active: false })

  const updateHandle = React.useCallback(() => {
    if (!editor.isEditable) {
      setHandle(h => (h.visible ? { ...h, visible: false } : h))
      return
    }
    // Don't reposition while a drag is in flight — avoids jumps.
    if (dragRef.current.active) return

    const { state, view } = editor
    const { $from } = state.selection
    if ($from.depth === 0) {
      setHandle(h => (h.visible ? { ...h, visible: false } : h))
      return
    }
    const nodePos = $from.before(1)
    const node = state.doc.nodeAt(nodePos)
    const nodeDom = view.nodeDOM(nodePos) as HTMLElement | null
    if (!node || !nodeDom) {
      setHandle(h => (h.visible ? { ...h, visible: false } : h))
      return
    }

    const editorRect = view.dom.getBoundingClientRect()
    const rect = nodeDom.getBoundingClientRect()

    // Left: place handles 2 px to the left of the actual text content column,
    // accounting for the ProseMirror element's own padding-left.
    const editorPaddingLeft =
      parseFloat(window.getComputedStyle(view.dom).paddingLeft) || 12
    const contentLeft = editorRect.left + editorPaddingLeft
    const left = Math.max(0, contentLeft - HANDLES_WIDTH - 2)

    // Top: center the 22 px buttons on the first text line of the block.
    const cs = window.getComputedStyle(nodeDom)
    const lineHeight = parseFloat(cs.lineHeight) || 28
    const paddingTop = parseFloat(cs.paddingTop) || 0
    const top =
      rect.top + paddingTop + Math.max(0, Math.round((lineHeight - BUTTON_H) / 2))

    // Write position directly to the DOM — this is synchronous and paint-frame
    // aligned, so the element follows scrolling without any React cycle delay.
    posRef.current = { top, left }
    if (handlesRef.current) {
      handlesRef.current.style.top = `${top}px`
      handlesRef.current.style.left = `${left}px`
    }

    setHandle(h => {
      if (h.visible && h.nodePos === nodePos && h.nodeType === node.type.name)
        return h
      return { visible: true, nodePos, nodeType: node.type.name }
    })
  }, [editor])

  React.useEffect(() => {
    updateHandle()
    const onChange = () => updateHandle()
    editor.on("selectionUpdate", onChange)
    editor.on("transaction", onChange)
    editor.on("focus", onChange)
    window.addEventListener("resize", onChange)
    window.addEventListener("scroll", onChange, true)
    return () => {
      editor.off("selectionUpdate", onChange)
      editor.off("transaction", onChange)
      editor.off("focus", onChange)
      window.removeEventListener("resize", onChange)
      window.removeEventListener("scroll", onChange, true)
    }
  }, [editor, updateHandle])

  // Close menus when clicking outside.
  React.useEffect(() => {
    if (!insertOpen && !actionsOpen) return
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (target.closest(".amby-block-handles")) return
      setInsertOpen(false)
      setActionsOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [insertOpen, actionsOpen])

  // ── Pointer-based drag ────────────────────────────────────────────────────
  const startDrag = React.useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      // Capture pointer so move/up fire reliably even at high mouse speed.
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      dragRef.current = {
        srcPos: handle.nodePos,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
      }
      setInsertOpen(false)
      setActionsOpen(false)

      const view = editor.view
      const editorDom = view.dom as HTMLElement

      function updateIndicator(clientX: number, clientY: number): {
        targetPos: number
        before: boolean
      } | null {
        const pos = view.posAtCoords({ left: clientX, top: clientY })
        if (!pos) return null
        const { doc } = view.state
        const safe = Math.min(pos.pos, doc.content.size - 1)
        if (safe < 0) return null
        const $pos = doc.resolve(safe)
        if ($pos.depth === 0) return null
        const targetPos = $pos.before(1)
        const targetDom = view.nodeDOM(targetPos) as HTMLElement | null
        if (!targetDom) return null
        const rect = targetDom.getBoundingClientRect()
        const before = clientY < rect.top + rect.height / 2
        clearDragIndicators()
        targetDom.setAttribute(before ? "data-drag-before" : "data-drag-after", "true")
        return { targetPos, before }
      }

      function onMove(ev: PointerEvent) {
        ev.preventDefault()
        const d = dragRef.current
        if (!d.active) {
          const dx = ev.clientX - d.startX
          const dy = ev.clientY - d.startY
          if (dx * dx + dy * dy < 25) return // 5 px threshold
          d.active = true
          document.body.style.cursor = "grabbing"
          editorDom.style.userSelect = "none"
        }
        updateIndicator(ev.clientX, ev.clientY)
      }

      function onUp(ev: PointerEvent) {
        document.removeEventListener("pointermove", onMove)
        document.removeEventListener("pointerup", onUp)
        document.removeEventListener("pointercancel", onUp)
        document.body.style.cursor = ""
        editorDom.style.userSelect = ""

        const d = dragRef.current
        const wasActive = d.active
        const srcPos = d.srcPos
        dragRef.current = { srcPos: -1, startX: 0, startY: 0, active: false }
        clearDragIndicators()

        if (!wasActive) {
          setActionsOpen(v => !v)
          setInsertOpen(false)
          return
        }

        if (srcPos < 0) return
        const target = updateIndicator(ev.clientX, ev.clientY)
        clearDragIndicators()
        if (!target) return

        const { state, dispatch } = view
        const { doc } = state
        const srcNode = doc.nodeAt(srcPos)
        const targetNode = doc.nodeAt(target.targetPos)
        if (!srcNode || !targetNode) return

        const srcEnd = srcPos + srcNode.nodeSize
        const insertPos = target.before
          ? target.targetPos
          : target.targetPos + targetNode.nodeSize
        if (insertPos >= srcPos && insertPos <= srcEnd) return

        const tr = state.tr
        tr.delete(srcPos, srcEnd)
        tr.insert(tr.mapping.map(insertPos), srcNode)
        dispatch(tr)
      }

      document.addEventListener("pointermove", onMove)
      document.addEventListener("pointerup", onUp)
      document.addEventListener("pointercancel", onUp)
    },
    [editor, handle.nodePos],
  )

  if (!handle.visible || !editor.isEditable) return null

  const isCallout = handle.nodeType === "callout"

  function duplicateBlock() {
    const node = editor.state.doc.nodeAt(handle.nodePos)
    if (!node) return
    const after = handle.nodePos + node.nodeSize
    editor.chain().focus().insertContentAt(after, node.toJSON()).run()
  }

  function deleteBlock() {
    const node = editor.state.doc.nodeAt(handle.nodePos)
    if (!node) return
    const { state, dispatch } = editor.view
    dispatch(state.tr.delete(handle.nodePos, handle.nodePos + node.nodeSize))
  }

  function setCalloutBg(bg: string | null) {
    editor.chain().focus().updateAttributes("callout", { bgColor: bg }).run()
  }

  function focusInsideBlock() {
    editor.chain().focus().setTextSelection(handle.nodePos + 1).run()
  }

  return createPortal(
    <div
      ref={handlesRef}
      className="amby-block-handles"
      style={{ top: posRef.current.top, left: posRef.current.left }}
    >
      <button
        type="button"
        className="amby-block-handle-btn"
        title="Insert block below"
        onMouseDown={e => e.preventDefault()}
        onClick={() => {
          setInsertOpen(v => !v)
          setActionsOpen(false)
        }}
      >
        <Plus className="size-3.5" />
      </button>

      <button
        type="button"
        className="amby-block-handle-btn amby-block-handle-grip"
        title="Drag to reorder · Click for block actions"
        onMouseDown={e => e.preventDefault()}
        onPointerDown={startDrag}
      >
        <GripVertical className="size-3.5" />
      </button>

      {insertOpen && (
        <div className="amby-block-handle-menu" onMouseDown={e => e.preventDefault()}>
          {INLINE_INSERT_ITEMS.map(opt => (
            <button
              key={opt.id}
              type="button"
              className="amby-block-handle-menu-item"
              onClick={() => {
                opt.insertAfter(editor, handle.nodePos)
                setInsertOpen(false)
              }}
            >
              <opt.icon className="size-3.5 shrink-0 text-zinc-500" />
              {opt.title}
            </button>
          ))}
        </div>
      )}

      {actionsOpen && (
        <div className="amby-block-handle-menu" onMouseDown={e => e.preventDefault()}>
          <div className="amby-block-handle-menu-section">Превратить в</div>
          {INLINE_INSERT_ITEMS.filter(
            i => !["tag", "backlink", "divider"].includes(i.id),
          ).map(opt => (
            <button
              key={opt.id}
              type="button"
              className="amby-block-handle-menu-item"
              onClick={() => {
                focusInsideBlock()
                opt.inline(editor)
                setActionsOpen(false)
              }}
            >
              <opt.icon className="size-3.5 shrink-0 text-zinc-500" />
              {opt.title}
            </button>
          ))}

          {isCallout && (
            <>
              <div className="amby-block-handle-menu-section">Фон Callout</div>
              <div className="amby-block-handle-menu-swatches">
                {CALLOUT_SWATCHES.map(sw => (
                  <button
                    key={sw.id}
                    type="button"
                    title={sw.label}
                    className={
                      sw.id === "none"
                        ? "amby-block-handle-swatch amby-block-handle-swatch--none"
                        : "amby-block-handle-swatch"
                    }
                    style={sw.color ? { background: sw.color } : undefined}
                    onClick={() => {
                      setCalloutBg(sw.id)
                      setActionsOpen(false)
                    }}
                  >
                    {sw.id === "none" && <Droplet className="size-3" />}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="amby-block-handle-menu-section">Действия</div>
          <button
            type="button"
            className="amby-block-handle-menu-item"
            onClick={() => {
              duplicateBlock()
              setActionsOpen(false)
            }}
          >
            <Copy className="size-3.5 shrink-0 text-zinc-500" />
            Дублировать
          </button>
          <button
            type="button"
            className="amby-block-handle-menu-item amby-block-handle-menu-item--danger"
            onClick={() => {
              deleteBlock()
              setActionsOpen(false)
            }}
          >
            <Trash2 className="size-3.5 shrink-0" />
            Удалить блок
          </button>
        </div>
      )}
    </div>,
    document.body,
  )
}
