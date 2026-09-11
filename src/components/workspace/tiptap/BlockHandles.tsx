"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/react"
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model"
import { GripVertical } from "lucide-react"
import { animate } from "motion/react"

import { motionTransition, motionTransitions } from "@/lib/motion-config"
import { BlockActionsPanel } from "./BlockActionsPanel"
import { BlockInsertPanel } from "./BlockInsertPanel"
import { CLOSE_BLOCK_MENUS_EVENT, CLOSE_EDITOR_MENUS_EVENT } from "./floating-menu-events"
import {
  createColumnsFromDrop,
  moveBlockAcrossColumns,
  removeSoleBlockColumn,
  type ColumnDropSide,
} from "./columns-transaction"

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

interface DragRowTarget {
  pos: number
  depth: number
  node: PMNode
  element: HTMLElement
  rect: DOMRect
}

interface ColumnGeometry {
  columnRect: DOMRect
  contentRect: DOMRect
  blocks: Array<{ element: HTMLElement; rect: DOMRect }>
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
  const columnGeometryRef = React.useRef<ColumnGeometry[] | null>(null)
  const editorGeometryRef = React.useRef<{
    rect: DOMRect
    paddingLeft: number
  } | null>(null)

  const isEditorSurfaceHidden = React.useCallback(() => {
    if (editor.isDestroyed) return true
    const editorDom = editor.view.dom as HTMLElement
    return !editorDom.isConnected || editorDom.closest('[aria-hidden="true"]') !== null
  }, [editor])

  const applyVisibility = React.useCallback(() => {
    if (editor.isDestroyed) return
    // Block controls live in a body portal, outside the cached tab wrapper.
    // Guard every path that can reveal them: hidden editors keep document-level
    // listeners alive and otherwise react to the same pointer as the active tab.
    if (isEditorSurfaceHidden()) {
      setHandle((current) => (current.visible ? { ...current, visible: false } : current))
      return
    }
    if (!editor.isEditable) {
      setHandle((h) => (h.visible ? { ...h, visible: false } : h))
      return
    }
    if (dragRef.current.active) return

    const { state, view } = editor
    editorGeometryRef.current = {
      rect: view.dom.getBoundingClientRect(),
      paddingLeft: parseFloat(window.getComputedStyle(view.dom).paddingLeft) || 12,
    }

    const mouseOver = mouseInsideEditorRef.current || mouseInsideWidgetRef.current
    const selectionTarget = view.hasFocus() ? findDraggableAncestor(state.selection.$from) : null
    const target =
      pinnedTargetRef.current ??
      (mouseOver ? hoverTargetRef.current : null) ??
      (selectionTarget
        ? {
            mode: "block" as const,
            nodePos: selectionTarget.pos,
            nodeType: selectionTarget.node.type.name,
          }
        : null)
    if (!target) {
      setHandle((h) => (h.visible ? { ...h, visible: false } : h))
      return
    }

    let left: number
    let top: number

    if (target.mode === "insert") {
      const beforeDom = view.nodeDOM(target.beforePos ?? -1)
      const afterDom = view.nodeDOM(target.afterPos ?? -1)
      if (
        !(beforeDom instanceof HTMLElement) ||
        !(afterDom instanceof HTMLElement) ||
        !beforeDom.isConnected ||
        !afterDom.isConnected ||
        !view.dom.contains(beforeDom) ||
        !view.dom.contains(afterDom)
      ) {
        setHandle((h) => (h.visible ? { ...h, visible: false } : h))
        return
      }
      const beforeRect = beforeDom.getBoundingClientRect()
      const afterRect = afterDom.getBoundingClientRect()
      if (
        beforeRect.width <= 0 ||
        beforeRect.height <= 0 ||
        afterRect.width <= 0 ||
        afterRect.height <= 0 ||
        !Number.isFinite(beforeRect.top) ||
        !Number.isFinite(afterRect.top)
      ) {
        setHandle((h) => (h.visible ? { ...h, visible: false } : h))
        return
      }
      left = Math.max(0, Math.min(beforeRect.left, afterRect.left) - HANDLE_WIDTH - GUTTER_GAP)
      top = (beforeRect.bottom + afterRect.top) / 2 - BUTTON_H / 2
    } else {
      if (target.nodePos < 0 || target.nodePos > state.doc.content.size) {
        hoverTargetRef.current = null
        pinnedTargetRef.current = null
        setHandle((h) => (h.visible ? { ...h, visible: false } : h))
        return
      }
      const node = state.doc.nodeAt(target.nodePos)
      const nodeDom = view.nodeDOM(target.nodePos)
      if (
        !node ||
        node.type.name !== target.nodeType ||
        !(nodeDom instanceof HTMLElement) ||
        !nodeDom.isConnected ||
        !view.dom.contains(nodeDom)
      ) {
        hoverTargetRef.current = null
        pinnedTargetRef.current = null
        setHandle((h) => (h.visible ? { ...h, visible: false } : h))
        return
      }
      const rect = nodeDom.getBoundingClientRect()
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        !Number.isFinite(rect.top) ||
        !Number.isFinite(rect.left)
      ) {
        hoverTargetRef.current = null
        pinnedTargetRef.current = null
        setHandle((h) => (h.visible ? { ...h, visible: false } : h))
        return
      }
      // Nested column blocks own a local gutter. Anchoring every handle to the
      // document's far-left edge made the second/third columns nearly
      // impossible to drag.
      const taskLabel =
        target.nodeType === "taskItem" ? nodeDom.querySelector<HTMLElement>(":scope > label") : null
      const anchorRect = taskLabel?.getBoundingClientRect() ?? rect
      const column = nodeDom.closest<HTMLElement>(".amby-column")
      const columnContent = column?.querySelector<HTMLElement>(":scope > .amby-column-content")
      if (column && columnContent) {
        // Every column owns a local gutter. Anchor beside its visible content,
        // not on the resize divider at the column edge.
        left = Math.max(0, columnContent.getBoundingClientRect().left - HANDLE_WIDTH - 8)
      } else {
        const listMarkerClearance = target.nodeType === "listItem" ? 28 : 0
        left = Math.max(0, anchorRect.left - HANDLE_WIDTH - GUTTER_GAP - listMarkerClearance)
      }
      // Align the grip with the first line, rather than the visual centre of
      // a tall block, matching Notion's block affordance. A horizontal rule is
      // itself the visible anchor, so centre the grip directly on its line.
      top =
        taskLabel || target.nodeType === "horizontalRule"
          ? anchorRect.top + (anchorRect.height - BUTTON_H) / 2
          : anchorRect.top + 1
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
  }, [editor, isEditorSurfaceHidden])

  React.useEffect(() => {
    if (editor.isDestroyed) return
    const view = editor.view
    const editorDom = view.dom as HTMLElement
    const invalidateColumnGeometry = () => {
      columnGeometryRef.current = null
    }
    const readColumnGeometry = (): ColumnGeometry[] => {
      if (columnGeometryRef.current) return columnGeometryRef.current
      const geometry: ColumnGeometry[] = []
      editorDom.querySelectorAll<HTMLElement>(".amby-column").forEach((column) => {
        const content = column.querySelector<HTMLElement>(":scope > .amby-column-content")
        if (!content) return
        const blocks = Array.from(content.children)
          .filter((child): child is HTMLElement => child instanceof HTMLElement)
          .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        geometry.push({
          columnRect: column.getBoundingClientRect(),
          contentRect: content.getBoundingClientRect(),
          blocks,
        })
      })
      columnGeometryRef.current = geometry
      return geometry
    }

    const onChange = () => {
      invalidateColumnGeometry()
      // Cached tabs remain laid out off-screen for instant switching. They do
      // not need geometry reads while another editor is visible. The handle is
      // rendered through a body portal, though, so simply skipping the read
      // would leave a stale Grab floating above the newly active tab.
      if (isEditorSurfaceHidden()) {
        hoverTargetRef.current = null
        pinnedTargetRef.current = null
        mouseInsideEditorRef.current = false
        mouseInsideWidgetRef.current = false
        editorGeometryRef.current = null
        setInsertPanel((panel) => (panel.open ? { open: false, anchorPos: -1 } : panel))
        setActionsOpen(false)
        setHandle((current) => (current.visible ? { ...current, visible: false } : current))
        return
      }
      applyVisibility()
    }
    onChange()
    editor.on("selectionUpdate", onChange)
    editor.on("transaction", onChange)
    editor.on("focus", onChange)
    window.addEventListener("resize", onChange)
    window.addEventListener("scroll", onChange, true)

    // A sidebar resize changes the editor viewport without resizing `window`.
    // Observe both the scrolling viewport and ProseMirror itself so a visible
    // Grab follows the reflowed block in the same layout cycle. This also
    // covers content-width changes and sidebar open/close transitions.
    const geometryContainer = editorDom.closest<HTMLElement>(".amby-editor-scroll")
    const geometryObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onChange)
    geometryObserver?.observe(editorDom)
    if (geometryContainer && geometryContainer !== editorDom) {
      geometryObserver?.observe(geometryContainer)
    }

    // Tab visibility is expressed by an aria-hidden attribute on the cached
    // tab wrapper. Observe that attribute so returning to a tab immediately
    // recalculates its handle instead of waiting for a selection or resize.
    const visibilityHost = editorDom.closest<HTMLElement>("[aria-hidden]")
    const visibilityObserver =
      typeof MutationObserver === "undefined" || !visibilityHost
        ? null
        : new MutationObserver(onChange)
    if (visibilityObserver && visibilityHost) {
      visibilityObserver.observe(visibilityHost, {
        attributes: true,
        attributeFilter: ["aria-hidden"],
      })
    }

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
      }, 260)
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

    const projectedColumnX = (
      x: number,
      y: number,
      geometry: ColumnGeometry[] = readColumnGeometry(),
    ): number | null => {
      for (const { columnRect, contentRect } of geometry) {
        if (y < columnRect.top || y > columnRect.bottom) continue
        // The divider, resize hit area and grab gutter are outside the actual
        // text DOM. Project that whole strip onto the content for posAtCoords.
        if (x >= columnRect.left - 16 && x <= contentRect.left + 24) {
          return contentRect.left + 2
        }
      }
      return null
    }

    const targetFromColumnRect = (
      x: number,
      y: number,
      geometry: ColumnGeometry[] = readColumnGeometry(),
    ): HoverTarget | null => {
      for (const { columnRect, blocks } of geometry) {
        if (
          y < columnRect.top ||
          y > columnRect.bottom ||
          x < columnRect.left - 16 ||
          x > columnRect.right
        )
          continue
        const block =
          blocks.find((child) => {
            return y >= child.rect.top && y <= child.rect.bottom
          }) ?? (blocks.length === 1 ? blocks[0] : undefined)
        if (!block) continue
        try {
          const domPos = view.posAtDOM(block.element, 0)
          const safe = Math.min(Math.max(domPos, 0), Math.max(0, view.state.doc.content.size - 1))
          const target = findDraggableAncestor(view.state.doc.resolve(safe))
          if (target) {
            return {
              mode: "block",
              nodePos: target.pos,
              nodeType: target.node.type.name,
            }
          }
        } catch {
          // DOM can be replaced by a transaction between pointermove and RAF.
        }
      }
      return null
    }

    const recomputeFromHover = (x: number, y: number) => {
      if (editor.isDestroyed) return
      if (isEditorSurfaceHidden()) {
        applyVisibility()
        return
      }
      const geometry = readColumnGeometry()
      const columnTarget = targetFromColumnRect(x, y, geometry)
      if (columnTarget) {
        columnGutterRef.current = true
        setHoverTarget(columnTarget)
        return
      }
      columnGutterRef.current = false
      const editorRect = view.dom.getBoundingClientRect()
      const paddingLeft = parseFloat(window.getComputedStyle(view.dom).paddingLeft) || 12
      const contentLeft = editorRect.left + paddingLeft
      const withinGutter =
        x >= contentLeft - HANDLE_WIDTH - GUTTER_GAP - GUTTER_HIT_SLOP && x <= contentLeft + 24
      const localColumnX = projectedColumnX(x, y, geometry)
      const pos = view.posAtCoords({
        left: localColumnX ?? (withinGutter ? contentLeft + 1 : x),
        top: y,
      })
      if (!pos) {
        scheduleHideIfNeeded()
        return
      }
      const safe = Math.min(Math.max(pos.pos, 0), Math.max(0, view.state.doc.content.size - 1))
      const $pos = view.state.doc.resolve(safe)
      const target = findDraggableAncestor($pos)
      if (!target) {
        scheduleHideIfNeeded()
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
    const columnGutterRef = { current: false }
    const onDocumentMouseMove = (e: MouseEvent) => {
      if (isEditorSurfaceHidden()) {
        mouseInsideEditorRef.current = false
        hoverTargetRef.current = null
        pinnedTargetRef.current = null
        if (handlesRef.current) applyVisibility()
        return
      }
      if (pinnedTargetRef.current) return
      const editorGeometry = editorGeometryRef.current
      if (!editorGeometry) {
        lastMoveRef.current = { x: e.clientX, y: e.clientY }
        if (rafRef.current == null) {
          rafRef.current = window.requestAnimationFrame(() => {
            rafRef.current = null
            const p = lastMoveRef.current
            if (p) {
              applyVisibility()
              recomputeFromHover(p.x, p.y)
            }
          })
        }
        return
      }
      const { rect, paddingLeft } = editorGeometry
      const contentLeft = rect.left + paddingLeft
      const inExtendedGutter =
        e.clientX >= contentLeft - HANDLE_WIDTH - GUTTER_GAP - GUTTER_HIT_SLOP &&
        e.clientX <= contentLeft + 24 &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      // Geometry is read by the RAF-coalesced recompute path. Reuse its last
      // classification here so document-level mousemove stays read-free.
      const inColumnGutter = columnGutterRef.current

      if (inExtendedGutter || inColumnGutter) {
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
    // Asset NodeViews can change a paragraph's geometry without a ProseMirror
    // transaction (for example when an image finishes loading). Re-anchor the
    // handle on that native event as well as on editor transactions.
    const onMediaLoad = () => {
      if (editor.isDestroyed) return
      window.requestAnimationFrame(onChange)
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
    editorDom.addEventListener("load", onMediaLoad, true)
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
      geometryObserver?.disconnect()
      visibilityObserver?.disconnect()
      editorDom.removeEventListener("mousedown", onEditorMouseDownCapture, true)
      editorDom.removeEventListener("mousemove", onMouseMove)
      editorDom.removeEventListener("mouseenter", onEditorEnter)
      editorDom.removeEventListener("mouseleave", onEditorLeave)
      editorDom.removeEventListener("contextmenu", onEditorContextMenu)
      editorDom.removeEventListener("load", onMediaLoad, true)
      document.removeEventListener("mousemove", onDocumentMouseMove)
      window.removeEventListener(CLOSE_BLOCK_MENUS_EVENT, closeBlockMenus)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      if (hideTimerRef.current != null) clearTimeout(hideTimerRef.current)
      widgetEnterRef.current = null
      widgetLeaveRef.current = null
      window.removeEventListener("scroll", onChange, true)
    }
  }, [editor, applyVisibility, isEditorSurfaceHidden])

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
      applyVisibility()
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [insertPanel.open, actionsOpen, applyVisibility])

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
      const dragOriginX = e.clientX
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
        const viewport = scrollContainer.getBoundingClientRect()
        if (clientY < viewport.top - 16 || clientY > viewport.bottom + 16) return null

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
        // In an existing layout the broad middle area always means “move this
        // block”. Only the outer 18% reorders a whole single-block column.
        // Top-level blocks keep wider edges because that gesture creates a new
        // column and has no cross-column move ambiguity.
        const edgeRatio = sourceIsTopLevel ? 0.34 : sourceIsSoleColumnBlock ? 0.18 : 0
        const horizontalEdge = rect.width * edgeRatio
        // A plain vertical drag begins in the gutter, so the pointer must move
        // horizontally before edge zones can mean “create/reorder columns”.
        // This keeps the default gesture axis-locked like property reordering.
        const hasHorizontalIntent = Math.abs(clientX - dragOriginX) >= 24
        const side: ColumnDropSide | null =
          hasHorizontalIntent &&
          edgeRatio > 0 &&
          clientX >= rect.left &&
          clientX <= rect.left + horizontalEdge
            ? "left"
            : hasHorizontalIntent &&
                edgeRatio > 0 &&
                clientX >= rect.right - horizontalEdge &&
                clientX <= rect.right
              ? "right"
              : null
        const canCreateColumns =
          side && sourcePos >= 0 && (sourceIsTopLevel || targetIsColumnBlock)
            ? createColumnsFromDrop(view.state, sourcePos, targetPos, side) !== null
            : false
        if (side && canCreateColumns) {
          showSideIndicator(rect, side)
          return { targetPos, before: false, side }
        }
        const before = clientY < rect.top + rect.height / 2
        const $target = doc.resolve(targetPos)
        const parentDepth = closest.row.depth - 1
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
          const nextDom = view.nodeDOM(targetPos + targetNode.nodeSize)
          if (nextDom instanceof HTMLElement) {
            const nextRect = nextDom.getBoundingClientRect()
            lineTop = (rect.bottom + nextRect.top) / 2
          }
        }

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
          if (tr) dispatch(tr)
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
          dispatch(crossColumn)
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
  const $handle =
    handle.nodePos >= 0 && handle.nodePos <= editor.state.doc.content.size
      ? editor.state.doc.resolve(handle.nodePos)
      : null
  let isColumnBlock = false
  if ($handle) {
    for (let depth = $handle.depth; depth > 0; depth--) {
      if ($handle.node(depth).type.name === "column") {
        isColumnBlock = true
        break
      }
    }
  }

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
    // The insertion transaction runs synchronously and can briefly invalidate
    // the old target before the new empty paragraph is pinned. Re-anchor now
    // that the inserted node and its panel target are known.
    applyVisibility()
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
    const removeColumn = removeSoleBlockColumn(state, handle.nodePos)
    dispatch(removeColumn ?? state.tr.delete(handle.nodePos, handle.nodePos + node.nodeSize))
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
      className={`amby-block-handles${isColumnBlock ? " amby-block-handles--column" : ""}`}
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
            applyVisibility()
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
            applyVisibility()
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
            applyVisibility()
          }}
          onDelete={() => {
            deleteBlock()
            pinnedTargetRef.current = null
            setActionsOpen(false)
            applyVisibility()
          }}
          onInsertAbove={insertAboveBlock}
          onInsertBelow={insertBelowBlock}
          onFocusInsideBlock={focusInsideBlock}
          onClose={() => {
            pinnedTargetRef.current = null
            setActionsOpen(false)
            applyVisibility()
          }}
        />
      )}
    </div>,
    document.body,
  )
}
