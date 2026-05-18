"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/react"
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model"
import { GripVertical, Plus } from "lucide-react"

import { BlockActionsPanel } from "./BlockActionsPanel"
import { BlockInsertPanel } from "./BlockInsertPanel"

const DRAGGABLE_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "listItem",
  "taskItem",
  "callout",
  "horizontalRule",
  "image",
  "table",
])

function findDraggableAncestor(
  $pos: ResolvedPos,
): { pos: number; depth: number; node: PMNode } | null {
  for (let d = $pos.depth; d >= 1; d--) {
    const node = $pos.node(d)
    if (DRAGGABLE_TYPES.has(node.type.name)) {
      return { pos: $pos.before(d), depth: d, node }
    }
  }
  if ($pos.depth === 0 && $pos.nodeAfter && DRAGGABLE_TYPES.has($pos.nodeAfter.type.name)) {
    return { pos: $pos.pos, depth: 1, node: $pos.nodeAfter }
  }
  return null
}

function findScrollAncestor(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el.parentElement
  while (node) {
    const oy = window.getComputedStyle(node).overflowY
    if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight)
      return node
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}


interface HandleState {
  visible: boolean
  nodePos: number
  nodeType: string
}

const HANDLES_WIDTH = 46
const BUTTON_H = 22

interface BlockHandlesProps {
  editor: Editor
  vaultPath?: string
  notePath?: string
}

export function BlockHandles({ editor, vaultPath, notePath }: BlockHandlesProps) {
  const [handle, setHandle] = React.useState<HandleState>({
    visible: false,
    nodePos: -1,
    nodeType: "",
  })
  // anchorPos is the doc position at which the just-inserted empty paragraph
  // sits. The panel uses item.inline(editor) which acts on current selection;
  // the selection was placed inside that paragraph right before opening.
  const [insertPanel, setInsertPanel] = React.useState<{ open: boolean; anchorPos: number }>({
    open: false,
    anchorPos: -1,
  })
  const [actionsOpen, setActionsOpen] = React.useState(false)

  const handlesRef = React.useRef<HTMLDivElement>(null)
  const posRef = React.useRef({ top: 0, left: 0 })

  const dragRef = React.useRef<{
    srcPos: number
    startX: number
    startY: number
    active: boolean
  }>({ srcPos: -1, startX: 0, startY: 0, active: false })

  const ghostRef = React.useRef<HTMLElement | null>(null)

  // Hover tracking: which block the mouse is over, plus presence flags so we
  // know when to show / hide handles and survive moves from row → gutter.
  const hoveredPosRef = React.useRef<number>(-1)
  const mouseInsideEditorRef = React.useRef(false)
  const mouseInsideWidgetRef = React.useRef(false)
  const hideTimerRef = React.useRef<number | null>(null)
  const rafRef = React.useRef<number | null>(null)
  const lastMoveRef = React.useRef<{ x: number; y: number } | null>(null)
  const widgetEnterRef = React.useRef<(() => void) | null>(null)
  const widgetLeaveRef = React.useRef<(() => void) | null>(null)

  const applyVisibility = React.useCallback(() => {
    if (!editor.isEditable) {
      setHandle(h => (h.visible ? { ...h, visible: false } : h))
      return
    }
    if (dragRef.current.active) return

    const { state, view } = editor

    // Decide effective nodePos: hover wins when mouse is over editor/widget,
    // otherwise fall back to cursor selection.
    let nodePos = -1
    const mouseOver = mouseInsideEditorRef.current || mouseInsideWidgetRef.current
    if (mouseOver && hoveredPosRef.current >= 0) {
      nodePos = hoveredPosRef.current
    } else {
      const { $from } = state.selection
      const found = findDraggableAncestor($from)
      if (found) nodePos = found.pos
    }

    if (nodePos < 0) {
      setHandle(h => (h.visible ? { ...h, visible: false } : h))
      return
    }

    const node = state.doc.nodeAt(nodePos)
    const nodeDom = view.nodeDOM(nodePos) as HTMLElement | null
    if (!node || !nodeDom) {
      setHandle(h => (h.visible ? { ...h, visible: false } : h))
      return
    }

    const editorRect = view.dom.getBoundingClientRect()
    const rect = nodeDom.getBoundingClientRect()

    // Left: place handles 4 px to the left of the actual text content column,
    // accounting for the ProseMirror element's own padding-left.
    const editorPaddingLeft =
      parseFloat(window.getComputedStyle(view.dom).paddingLeft) || 12
    const contentLeft = editorRect.left + editorPaddingLeft
    const left = Math.max(0, contentLeft - HANDLES_WIDTH - 4)

    const cs = window.getComputedStyle(nodeDom)
    const lineHeight = parseFloat(cs.lineHeight) || 28
    const paddingTop = parseFloat(cs.paddingTop) || 0
    const top =
      rect.top + paddingTop + Math.max(0, Math.round((lineHeight - BUTTON_H) / 2))

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
    applyVisibility()
    const onChange = () => applyVisibility()
    editor.on("selectionUpdate", onChange)
    editor.on("transaction", onChange)
    editor.on("focus", onChange)
    window.addEventListener("resize", onChange)
    window.addEventListener("scroll", onChange, true)

    const editorDom = editor.view.dom as HTMLElement

    const cancelHide = () => {
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }
    const scheduleHideIfNeeded = () => {
      cancelHide()
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null
        if (mouseInsideEditorRef.current || mouseInsideWidgetRef.current) return
        hoveredPosRef.current = -1
        applyVisibility()
      }, 120)
    }

    const recomputeFromHover = (x: number, y: number) => {
      const view = editor.view
      const pos = view.posAtCoords({ left: x, top: y })
      if (!pos) return
      const safe = Math.min(Math.max(pos.pos, 0), view.state.doc.content.size - 1)
      const $pos = view.state.doc.resolve(safe)
      const target = findDraggableAncestor($pos)
      if (!target) return
      if (hoveredPosRef.current !== target.pos) {
        hoveredPosRef.current = target.pos
        applyVisibility()
      }
    }

    const onMouseMove = (e: MouseEvent) => {
      lastMoveRef.current = { x: e.clientX, y: e.clientY }
      if (rafRef.current != null) return
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null
        const p = lastMoveRef.current
        if (p) recomputeFromHover(p.x, p.y)
      })
    }
    const onEditorEnter = () => {
      mouseInsideEditorRef.current = true
      cancelHide()
    }
    const onEditorLeave = () => {
      mouseInsideEditorRef.current = false
      scheduleHideIfNeeded()
    }

    editorDom.addEventListener("mousemove", onMouseMove)
    editorDom.addEventListener("mouseenter", onEditorEnter)
    editorDom.addEventListener("mouseleave", onEditorLeave)

    // Expose enter/leave for the widget portal via refs read from JSX handlers.
    widgetEnterRef.current = () => {
      mouseInsideWidgetRef.current = true
      cancelHide()
    }
    widgetLeaveRef.current = () => {
      mouseInsideWidgetRef.current = false
      scheduleHideIfNeeded()
    }

    return () => {
      editor.off("selectionUpdate", onChange)
      editor.off("transaction", onChange)
      editor.off("focus", onChange)
      window.removeEventListener("resize", onChange)
      editorDom.removeEventListener("mousemove", onMouseMove)
      editorDom.removeEventListener("mouseenter", onEditorEnter)
      editorDom.removeEventListener("mouseleave", onEditorLeave)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      if (hideTimerRef.current != null) clearTimeout(hideTimerRef.current)
      widgetEnterRef.current = null
      widgetLeaveRef.current = null
      window.removeEventListener("scroll", onChange, true)
    }
  }, [editor, applyVisibility])

  // Close menus when clicking outside.
  React.useEffect(() => {
    if (!insertPanel.open && !actionsOpen) return
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (target.closest(".amby-block-handles")) return
      if (target.closest(".amby-block-panel")) return
      if (target.closest(".amby-turn-into-menu")) return
      if (target.closest("em-emoji-picker")) return
      setInsertPanel(p => (p.open ? { open: false, anchorPos: -1 } : p))
      setActionsOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [insertPanel.open, actionsOpen])

  // ── Pointer-based drag ────────────────────────────────────────────────────
  const startDrag = React.useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
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
      let lastX = e.clientX
      let lastY = e.clientY

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
        const g = ghostRef.current
        if (!g) return
        const ox = Number(g.dataset.offsetX || 0)
        const oy = Number(g.dataset.offsetY || 0)
        g.style.transform = `translate(${x - ox}px, ${y - oy}px)`
      }

      let indicatorEl: HTMLElement | null = null

      function showIndicatorAt(rect: DOMRect, before: boolean) {
        if (!indicatorEl) {
          indicatorEl = document.createElement("div")
          indicatorEl.className = "amby-block-drop-indicator"
          document.body.appendChild(indicatorEl)
        }
        const y = before ? rect.top : rect.bottom
        indicatorEl.style.left = `${rect.left}px`
        indicatorEl.style.width = `${rect.width}px`
        indicatorEl.style.top = `${y - 1}px`
      }
      function hideIndicator() {
        if (indicatorEl) {
          indicatorEl.remove()
          indicatorEl = null
        }
      }

      function updateIndicator(clientX: number, clientY: number): {
        targetPos: number
        before: boolean
      } | null {
        const pos = view.posAtCoords({ left: clientX, top: clientY })
        if (!pos) {
          hideIndicator()
          return null
        }
        const { doc } = view.state
        const safe = Math.min(pos.pos, doc.content.size - 1)
        if (safe < 0) {
          hideIndicator()
          return null
        }
        const $pos = doc.resolve(safe)
        const target = findDraggableAncestor($pos)
        if (!target) return null
        const targetPos = target.pos
        const targetDom = view.nodeDOM(targetPos) as HTMLElement | null
        if (!targetDom) {
          hideIndicator()
          return null
        }
        const rect = targetDom.getBoundingClientRect()
        const before = clientY < rect.top + rect.height / 2
        showIndicatorAt(rect, before)
        return { targetPos, before }
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

          const srcDom = view.nodeDOM(d.srcPos) as HTMLElement | null
          if (srcDom) {
            const rect = srcDom.getBoundingClientRect()
            const ghost = srcDom.cloneNode(true) as HTMLElement
            ghost.classList.add("amby-block-drag-ghost")
            ghost.style.width = `${rect.width}px`
            ghost.style.maxWidth = `${rect.width}px`
            ghost.dataset.offsetX = String(d.startX - rect.left)
            ghost.dataset.offsetY = String(d.startY - rect.top)
            document.body.appendChild(ghost)
            ghostRef.current = ghost
            srcDom.classList.add("amby-block-drag-source")
          }
        }
        updateIndicator(ev.clientX, ev.clientY)
        positionGhost(ev.clientX, ev.clientY)
        maybeStartScroll()
      }

      function cleanupGhost() {
        if (ghostRef.current) {
          ghostRef.current.remove()
          ghostRef.current = null
        }
        document
          .querySelectorAll(".amby-block-drag-source")
          .forEach(el => el.classList.remove("amby-block-drag-source"))
      }

      function onUp(ev: PointerEvent) {
        document.removeEventListener("pointermove", onMove)
        document.removeEventListener("pointerup", onUp)
        document.removeEventListener("pointercancel", onUp)
        document.body.style.cursor = ""
        editorDom.style.userSelect = ""
        stopScroll()
        cleanupGhost()

        const d = dragRef.current
        const wasActive = d.active
        const srcPos = d.srcPos
        dragRef.current = { srcPos: -1, startX: 0, startY: 0, active: false }

        if (!wasActive) {
          hideIndicator()
          setActionsOpen(v => !v)
          setInsertPanel({ open: false, anchorPos: -1 })
          return
        }

        if (srcPos < 0) {
          hideIndicator()
          return
        }
        const target = updateIndicator(ev.clientX, ev.clientY)
        hideIndicator()
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

        // No-op: dropping into our own slot (immediately before or after self).
        if (insertPos === srcPos || insertPos === srcEnd) return
        // Dropping strictly inside the source — invalid for container draggables.
        if (insertPos > srcPos && insertPos < srcEnd) return

        const $src = doc.resolve(srcPos)
        const $ins = doc.resolve(insertPos)
        const parentKey = ($p: ResolvedPos) =>
          $p.depth === 0 ? -1 : $p.before($p.depth)
        // Same-parent siblings only in this round; cross-parent drops bail.
        if (parentKey($src) !== parentKey($ins)) return

        const tr = state.tr
        tr.delete(srcPos, srcEnd)
        const mappedInsert = tr.mapping.map(insertPos, -1)
        try {
          tr.insert(mappedInsert, srcNode)
          if (tr.docChanged) dispatch(tr)
        } catch {
          /* swallow */
        }
      }

      document.addEventListener("pointermove", onMove)
      document.addEventListener("pointerup", onUp)
      document.addEventListener("pointercancel", onUp)
    },
    [editor, handle.nodePos],
  )

  if (!handle.visible || !editor.isEditable) return null

  const isCallout = handle.nodeType === "callout"

  // Compute anchor rect for child panels — same viewport coords as the handles.
  const anchorRect = {
    left: posRef.current.left,
    top: posRef.current.top,
    right: posRef.current.left + HANDLES_WIDTH,
    bottom: posRef.current.top + BUTTON_H,
    width: HANDLES_WIDTH,
    height: BUTTON_H,
  }

  function openInsertFromPlus() {
    const node = editor.state.doc.nodeAt(handle.nodePos)
    if (!node) return

    // If the current block is an empty paragraph, transform it in place
    // (cursor moves inside it). Otherwise insert a new empty paragraph below
    // and focus that.
    const isEmptyPara = node.type.name === "paragraph" && node.content.size === 0

    if (isEmptyPara) {
      editor.chain().focus().setTextSelection(handle.nodePos + 1).run()
      setActionsOpen(false)
      setInsertPanel({ open: true, anchorPos: handle.nodePos })
    } else {
      const after = handle.nodePos + node.nodeSize
      editor
        .chain()
        .focus()
        .insertContentAt(after, { type: "paragraph" })
        .setTextSelection(after + 1)
        .run()
      setActionsOpen(false)
      setInsertPanel({ open: true, anchorPos: after })
    }
  }

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

  function focusInsideBlock() {
    editor.chain().focus().setTextSelection(handle.nodePos + 1).run()
  }

  return createPortal(
    <div
      ref={handlesRef}
      className="amby-block-handles"
      style={{ top: posRef.current.top, left: posRef.current.left }}
      onMouseEnter={() => widgetEnterRef.current?.()}
      onMouseLeave={() => widgetLeaveRef.current?.()}
    >
      <button
        type="button"
        className="amby-block-handle-btn"
        title="Insert block below"
        onMouseDown={e => e.preventDefault()}
        onClick={openInsertFromPlus}
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

      {insertPanel.open && (
        <BlockInsertPanel
          editor={editor}
          vaultPath={vaultPath}
          notePath={notePath}
          anchorRect={anchorRect}
          onClose={() => setInsertPanel({ open: false, anchorPos: -1 })}
        />
      )}

      {actionsOpen && (
        <BlockActionsPanel
          editor={editor}
          nodePos={handle.nodePos}
          nodeType={handle.nodeType}
          isCallout={isCallout}
          vaultPath={vaultPath}
          notePath={notePath}
          anchorRect={anchorRect}
          onDuplicate={() => {
            duplicateBlock()
            setActionsOpen(false)
          }}
          onDelete={() => {
            deleteBlock()
            setActionsOpen(false)
          }}
          onFocusInsideBlock={focusInsideBlock}
          onClose={() => setActionsOpen(false)}
        />
      )}
    </div>,
    document.body,
  )
}
