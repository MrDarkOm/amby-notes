"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/react"
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model"
import { GripVertical } from "lucide-react"

import { BlockActionsPanel } from "./BlockActionsPanel"
import { BlockInsertPanel } from "./BlockInsertPanel"
import { CLOSE_BLOCK_MENUS_EVENT, CLOSE_EDITOR_MENUS_EVENT } from "./floating-menu-events"

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
  let fallback: { pos: number; depth: number; node: PMNode } | null = null
  for (let d = $pos.depth; d >= 1; d--) {
    const node = $pos.node(d)
    if (DRAGGABLE_TYPES.has(node.type.name)) {
      const found = { pos: $pos.before(d), depth: d, node }
      // Callouts contain paragraphs. Their controls belong to the visual
      // Callout container, never to a nested paragraph above it.
      if (
        node.type.name === "callout" ||
        node.type.name === "listItem" ||
        node.type.name === "taskItem"
      )
        return found
      if (!fallback) fallback = found
    }
  }
  if (fallback) return fallback
  if ($pos.depth === 0 && $pos.nodeAfter && DRAGGABLE_TYPES.has($pos.nodeAfter.type.name)) {
    return { pos: $pos.pos, depth: 1, node: $pos.nodeAfter }
  }
  return null
}

function findScrollAncestor(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el.parentElement
  while (node) {
    const oy = window.getComputedStyle(node).overflowY
    if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) return node
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

interface HandleState {
  visible: boolean
  mode: "block" | "insert"
  nodePos: number
  nodeType: string
  insertPos: number
}

interface HoverTarget {
  mode: "block" | "insert"
  nodePos: number
  nodeType: string
  insertPos?: number
  beforePos?: number
  afterPos?: number
}

const HANDLE_WIDTH = 22
const BUTTON_H = 22
const GUTTER_GAP = 12
// The mouse target is wider than the visible button so the affordance can be
// discovered before the cursor reaches the text column.
const GUTTER_HIT_SLOP = 48

interface BlockHandlesProps {
  editor: Editor
  vaultPath?: string
  notePath?: string
}

export function BlockHandles({ editor, vaultPath, notePath }: BlockHandlesProps) {
  const [handle, setHandle] = React.useState<HandleState>({
    visible: false,
    mode: "block",
    nodePos: -1,
    nodeType: "",
    insertPos: -1,
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
  const hoverTargetRef = React.useRef<HoverTarget | null>(null)
  const pinnedTargetRef = React.useRef<HoverTarget | null>(null)
  const mouseInsideEditorRef = React.useRef(false)
  const mouseInsideWidgetRef = React.useRef(false)
  const hideTimerRef = React.useRef<number | null>(null)
  const rafRef = React.useRef<number | null>(null)
  const lastMoveRef = React.useRef<{ x: number; y: number } | null>(null)
  const widgetEnterRef = React.useRef<(() => void) | null>(null)
  const widgetLeaveRef = React.useRef<(() => void) | null>(null)

  const applyVisibility = React.useCallback(() => {
    if (editor.isDestroyed) return
    if (!editor.isEditable) {
      setHandle((h) => (h.visible ? { ...h, visible: false } : h))
      return
    }
    if (dragRef.current.active) return

    const { state, view } = editor

    // Controls are hover-only. The cursor selection must never leave a grab
    // handle pinned in the gutter when the pointer is elsewhere.
    const mouseOver = mouseInsideEditorRef.current || mouseInsideWidgetRef.current
    const target = pinnedTargetRef.current ?? (mouseOver ? hoverTargetRef.current : null)
    if (!target) {
      setHandle((h) => (h.visible ? { ...h, visible: false } : h))
      return
    }

    const editorRect = view.dom.getBoundingClientRect()
    const editorPaddingLeft = parseFloat(window.getComputedStyle(view.dom).paddingLeft) || 12
    const contentLeft = editorRect.left + editorPaddingLeft
    const left = Math.max(0, contentLeft - HANDLE_WIDTH - GUTTER_GAP)
    let top: number

    if (target.mode === "insert") {
      const beforeDom = view.nodeDOM(target.beforePos ?? -1)
      const afterDom = view.nodeDOM(target.afterPos ?? -1)
      if (!(beforeDom instanceof HTMLElement) || !(afterDom instanceof HTMLElement)) {
        setHandle((h) => (h.visible ? { ...h, visible: false } : h))
        return
      }
      const beforeRect = beforeDom.getBoundingClientRect()
      const afterRect = afterDom.getBoundingClientRect()
      top = (beforeRect.bottom + afterRect.top) / 2 - BUTTON_H / 2
    } else {
      const node = state.doc.nodeAt(target.nodePos)
      const nodeDom = view.nodeDOM(target.nodePos)
      if (!node || !(nodeDom instanceof HTMLElement)) {
        setHandle((h) => (h.visible ? { ...h, visible: false } : h))
        return
      }
      const rect = nodeDom.getBoundingClientRect()
      // Align the grip with the first line, rather than the visual centre of
      // a tall block, matching Notion's block affordance.
      top = rect.top + 1
    }

    posRef.current = { top, left }
    if (handlesRef.current) {
      handlesRef.current.style.top = `${top}px`
      handlesRef.current.style.left = `${left}px`
    }

    setHandle((h) => {
      const insertPos = target.insertPos ?? -1
      if (
        h.visible &&
        h.mode === target.mode &&
        h.nodePos === target.nodePos &&
        h.nodeType === target.nodeType &&
        h.insertPos === insertPos
      )
        return h
      return {
        visible: true,
        mode: target.mode,
        nodePos: target.nodePos,
        nodeType: target.nodeType,
        insertPos,
      }
    })
  }, [editor])

  React.useEffect(() => {
    if (editor.isDestroyed) return
    const view = editor.view
    const editorDom = view.dom as HTMLElement

    applyVisibility()
    const onChange = () => applyVisibility()
    editor.on("selectionUpdate", onChange)
    editor.on("transaction", onChange)
    editor.on("focus", onChange)
    window.addEventListener("resize", onChange)
    window.addEventListener("scroll", onChange, true)

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
        if (pinnedTargetRef.current) return
        if (mouseInsideEditorRef.current || mouseInsideWidgetRef.current) return
        hoverTargetRef.current = null
        applyVisibility()
      }, 120)
    }

    const setHoverTarget = (next: HoverTarget | null) => {
      const current = hoverTargetRef.current
      if (
        current?.mode === next?.mode &&
        current?.nodePos === next?.nodePos &&
        current?.nodeType === next?.nodeType &&
        current?.insertPos === next?.insertPos &&
        current?.beforePos === next?.beforePos &&
        current?.afterPos === next?.afterPos
      )
        return
      hoverTargetRef.current = next
      applyVisibility()
    }

    const recomputeFromHover = (x: number, y: number) => {
      if (editor.isDestroyed) return
      const editorRect = view.dom.getBoundingClientRect()
      const paddingLeft = parseFloat(window.getComputedStyle(view.dom).paddingLeft) || 12
      const contentLeft = editorRect.left + paddingLeft
      const withinGutter =
        x >= contentLeft - HANDLE_WIDTH - GUTTER_GAP - GUTTER_HIT_SLOP && x <= contentLeft + 24
      const pos = view.posAtCoords({ left: withinGutter ? contentLeft + 1 : x, top: y })
      if (!pos) {
        setHoverTarget(null)
        return
      }
      const safe = Math.min(Math.max(pos.pos, 0), Math.max(0, view.state.doc.content.size - 1))
      const $pos = view.state.doc.resolve(safe)
      const target = findDraggableAncestor($pos)
      if (!target) {
        setHoverTarget(null)
        return
      }
      setHoverTarget({
        mode: "block",
        nodePos: target.pos,
        nodeType: target.node.type.name,
      })
    }

    const onMouseMove = (e: MouseEvent) => {
      if (pinnedTargetRef.current) return
      if ((e.target as HTMLElement).closest(".amby-live-wikilink-button")) {
        setHoverTarget(null)
        return
      }
      lastMoveRef.current = { x: e.clientX, y: e.clientY }
      if (rafRef.current != null) return
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null
        const p = lastMoveRef.current
        if (p) recomputeFromHover(p.x, p.y)
      })
    }

    // `view.dom` starts at the content column, while the Grab gutter sits to
    // its left. Listen at document level as well so entering that outer gutter
    // can reveal the controls before the pointer crosses the block edge.
    const onDocumentMouseMove = (e: MouseEvent) => {
      if (pinnedTargetRef.current) return
      const rect = editorDom.getBoundingClientRect()
      const paddingLeft = parseFloat(window.getComputedStyle(editorDom).paddingLeft) || 12
      const contentLeft = rect.left + paddingLeft
      const inExtendedGutter =
        e.clientX >= contentLeft - HANDLE_WIDTH - GUTTER_GAP - GUTTER_HIT_SLOP &&
        e.clientX <= contentLeft + 24 &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom

      if (inExtendedGutter) {
        mouseInsideEditorRef.current = true
        cancelHide()
        onMouseMove(e)
        return
      }

      if (
        !editorDom.contains(e.target as Node) &&
        !handlesRef.current?.contains(e.target as Node)
      ) {
        mouseInsideEditorRef.current = false
        scheduleHideIfNeeded()
      }
    }
    const onEditorEnter = () => {
      mouseInsideEditorRef.current = true
      cancelHide()
    }
    const onEditorLeave = () => {
      mouseInsideEditorRef.current = false
      scheduleHideIfNeeded()
    }
    const onEditorContextMenu = (e: MouseEvent) => {
      if (editor.isDestroyed) return
      if ((e.target as HTMLElement).closest(".amby-live-wikilink-button")) return
      const pos = view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (!pos) return
      const safe = Math.min(Math.max(pos.pos, 0), Math.max(0, view.state.doc.content.size - 1))
      const target = findDraggableAncestor(view.state.doc.resolve(safe))
      if (!target) return

      e.preventDefault()
      const blockTarget: HoverTarget = {
        mode: "block",
        nodePos: target.pos,
        nodeType: target.node.type.name,
      }
      window.dispatchEvent(new Event(CLOSE_EDITOR_MENUS_EVENT))
      setInsertPanel({ open: false, anchorPos: -1 })
      setActionsOpen((open) => {
        if (open) {
          pinnedTargetRef.current = null
          return false
        }
        pinnedTargetRef.current = blockTarget
        setHoverTarget(blockTarget)
        return true
      })
    }
    // macOS Ctrl+click is dispatched as a primary-button mousedown before the
    // later contextmenu event. Prevent that first event from moving the
    // ProseMirror selection and opening the text bubble toolbar.
    const onEditorMouseDownCapture = (e: MouseEvent) => {
      if (e.button === 2 || (e.button === 0 && e.ctrlKey)) e.preventDefault()
    }

    editorDom.addEventListener("mousedown", onEditorMouseDownCapture, true)
    editorDom.addEventListener("mousemove", onMouseMove)
    editorDom.addEventListener("mouseenter", onEditorEnter)
    editorDom.addEventListener("mouseleave", onEditorLeave)
    editorDom.addEventListener("contextmenu", onEditorContextMenu)
    document.addEventListener("mousemove", onDocumentMouseMove)

    const closeBlockMenus = () => {
      pinnedTargetRef.current = null
      setInsertPanel((p) => (p.open ? { open: false, anchorPos: -1 } : p))
      setActionsOpen(false)
      applyVisibility()
    }
    window.addEventListener(CLOSE_BLOCK_MENUS_EVENT, closeBlockMenus)

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
      editorDom.removeEventListener("mousedown", onEditorMouseDownCapture, true)
      editorDom.removeEventListener("mousemove", onMouseMove)
      editorDom.removeEventListener("mouseenter", onEditorEnter)
      editorDom.removeEventListener("mouseleave", onEditorLeave)
      editorDom.removeEventListener("contextmenu", onEditorContextMenu)
      document.removeEventListener("mousemove", onDocumentMouseMove)
      window.removeEventListener(CLOSE_BLOCK_MENUS_EVENT, closeBlockMenus)
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
      pinnedTargetRef.current = null
      setInsertPanel((p) => (p.open ? { open: false, anchorPos: -1 } : p))
      setActionsOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [insertPanel.open, actionsOpen])

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

      function showIndicatorAt(rect: DOMRect, top: number) {
        if (!indicatorEl) {
          indicatorEl = document.createElement("div")
          indicatorEl.className = "amby-block-drop-indicator"
          document.body.appendChild(indicatorEl)
        }
        indicatorEl.style.left = `${rect.left}px`
        indicatorEl.style.width = `${rect.width}px`
        indicatorEl.style.top = `${top - 1}px`
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
      ): {
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
        const targetDom = view.nodeDOM(targetPos)
        if (!(targetDom instanceof HTMLElement)) {
          hideIndicator()
          return null
        }
        const rect = targetDom.getBoundingClientRect()
        const before = clientY < rect.top + rect.height / 2
        const $target = doc.resolve(targetPos)
        const parentDepth = target.depth - 1
        const parent = $target.node(parentDepth)
        const index = $target.index(parentDepth)
        let lineTop = before ? rect.top : rect.bottom

        if (before && index > 0) {
          const previous = parent.child(index - 1)
          const previousDom = view.nodeDOM(targetPos - previous.nodeSize)
          if (previousDom instanceof HTMLElement) {
            const previousRect = previousDom.getBoundingClientRect()
            lineTop = (previousRect.bottom + rect.top) / 2
          }
        } else if (!before && index + 1 < parent.childCount) {
          const nextDom = view.nodeDOM(targetPos + target.node.nodeSize)
          if (nextDom instanceof HTMLElement) {
            const nextRect = nextDom.getBoundingClientRect()
            lineTop = (rect.bottom + nextRect.top) / 2
          }
        }

        showIndicatorAt(rect, lineTop)
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

          const srcDom = view.nodeDOM(d.srcPos)
          if (srcDom instanceof HTMLElement) {
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
          .forEach((el) => el.classList.remove("amby-block-drag-source"))
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
        const target = updateIndicator(ev.clientX, ev.clientY)
        hideIndicator()
        if (!target) return

        const { state, dispatch } = view
        const { doc } = state
        const srcNode = doc.nodeAt(srcPos)
        const targetNode = doc.nodeAt(target.targetPos)
        if (!srcNode || !targetNode) return

        const srcEnd = srcPos + srcNode.nodeSize
        const insertPos = target.before ? target.targetPos : target.targetPos + targetNode.nodeSize

        // No-op: dropping into our own slot (immediately before or after self).
        if (insertPos === srcPos || insertPos === srcEnd) return
        // Dropping strictly inside the source — invalid for container draggables.
        if (insertPos > srcPos && insertPos < srcEnd) return

        const $src = doc.resolve(srcPos)
        const $ins = doc.resolve(insertPos)
        const parentKey = ($p: ResolvedPos) => ($p.depth === 0 ? -1 : $p.before($p.depth))
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
    [editor, handle.nodePos, handle.nodeType],
  )

  if (!handle.visible || !editor.isEditable) return null

  const isCallout = handle.nodeType === "callout"

  // Compute anchor rect for child panels — same viewport coords as the handles.
  const anchorRect = {
    left: posRef.current.left,
    top: posRef.current.top,
    right: posRef.current.left + HANDLE_WIDTH,
    bottom: posRef.current.top + BUTTON_H,
    width: HANDLE_WIDTH,
    height: BUTTON_H,
  }

  function openInsertAt(insertPos: number) {
    const listItem = handle.nodeType === "listItem" || handle.nodeType === "taskItem"
    const newBlock = listItem
      ? {
          type: handle.nodeType,
          attrs: handle.nodeType === "taskItem" ? { checked: false } : undefined,
          content: [{ type: "paragraph" }],
        }
      : { type: "paragraph" }
    editor
      .chain()
      .focus()
      .insertContentAt(insertPos, newBlock)
      .setTextSelection(insertPos + (listItem ? 2 : 1))
      .run()
    pinnedTargetRef.current = {
      mode: "block",
      nodePos: insertPos,
      nodeType: listItem ? handle.nodeType : "paragraph",
    }
    window.dispatchEvent(new Event(CLOSE_EDITOR_MENUS_EVENT))
    setActionsOpen(false)
    setInsertPanel({ open: true, anchorPos: insertPos })
  }

  function insertAboveBlock() {
    openInsertAt(handle.nodePos)
  }

  function insertBelowBlock() {
    const node = editor.state.doc.nodeAt(handle.nodePos)
    if (node) openInsertAt(handle.nodePos + node.nodeSize)
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
    editor
      .chain()
      .focus()
      .setTextSelection(handle.nodePos + 1)
      .run()
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
        className="amby-block-handle-btn amby-block-handle-grip"
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(event) => {
          // Close an already-open menu synchronously. Waiting for pointerup is
          // unreliable on macOS once the menu's focused input and pointer
          // capture are involved, and can leave the same menu open.
          if (actionsOpen || insertPanel.open) {
            event.preventDefault()
            event.stopPropagation()
            pinnedTargetRef.current = null
            setActionsOpen(false)
            setInsertPanel({ open: false, anchorPos: -1 })
            return
          }
          startDrag(event)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setInsertPanel({ open: false, anchorPos: -1 })
          window.dispatchEvent(new Event(CLOSE_EDITOR_MENUS_EVENT))
          setActionsOpen((open) => {
            if (open) {
              pinnedTargetRef.current = null
              return false
            }
            pinnedTargetRef.current = {
              mode: "block",
              nodePos: handle.nodePos,
              nodeType: handle.nodeType,
            }
            return true
          })
        }}
      >
        <GripVertical className="size-3.5" />
      </button>

      {insertPanel.open && (
        <BlockInsertPanel
          editor={editor}
          vaultPath={vaultPath}
          notePath={notePath}
          anchorRect={anchorRect}
          onClose={() => {
            pinnedTargetRef.current = null
            setInsertPanel({ open: false, anchorPos: -1 })
          }}
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
            pinnedTargetRef.current = null
            setActionsOpen(false)
          }}
          onDelete={() => {
            deleteBlock()
            pinnedTargetRef.current = null
            setActionsOpen(false)
          }}
          onInsertAbove={insertAboveBlock}
          onInsertBelow={insertBelowBlock}
          onFocusInsideBlock={focusInsideBlock}
          onClose={() => {
            pinnedTargetRef.current = null
            setActionsOpen(false)
          }}
        />
      )}
    </div>,
    document.body,
  )
}
