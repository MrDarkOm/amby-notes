import {
  COLUMN_GUTTER,
  type ColumnGeometry,
  DRAGGABLE_TYPES,
  GUTTER_GAP,
  GUTTER_HIT_SLOP,
  HANDLE_WIDTH,
  type HandleState,
  type HoverTarget,
  findDraggableAncestor,
  findDraggableAtCoords,
} from "./block-handles-geometry"
import * as React from "react"
import type { Editor } from "@tiptap/react"
import { CLOSE_BLOCK_MENUS_EVENT, CLOSE_EDITOR_MENUS_EVENT } from "./floating-menu-events"

interface UseBlockHandleTrackingParams {
  editor: Editor
  columnGeometryRef: React.RefObject<ColumnGeometry[] | null>
  isEditorSurfaceHidden: () => boolean
  hoverTargetRef: React.RefObject<HoverTarget | null>
  pinnedTargetRef: React.RefObject<HoverTarget | null>
  mouseInsideEditorRef: React.RefObject<boolean>
  mouseInsideWidgetRef: React.RefObject<boolean>
  editorGeometryRef: React.RefObject<{
    rect: DOMRect
    clipRect: DOMRect
    paddingLeft: number
  } | null>
  setInsertPanel: React.Dispatch<React.SetStateAction<{ open: boolean; anchorPos: number }>>
  setActionsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setHandle: React.Dispatch<React.SetStateAction<HandleState>>
  applyVisibility: () => void
  hideTimerRef: React.RefObject<number | null>
  getVisibleEditorBounds: (editorDom: HTMLElement) => { rect: DOMRect; clipRect: DOMRect }
  typingRef: React.RefObject<{ x: number; y: number } | null>
  pointerRef: React.RefObject<{ x: number; y: number }>
  lastMoveRef: React.RefObject<{ x: number; y: number } | null>
  rafRef: React.RefObject<number | null>
  handlesRef: React.RefObject<HTMLDivElement | null>
  widgetEnterRef: React.RefObject<(() => void) | null>
  widgetLeaveRef: React.RefObject<(() => void) | null>
}

export function useBlockHandleTracking({
  editor,
  columnGeometryRef,
  isEditorSurfaceHidden,
  hoverTargetRef,
  pinnedTargetRef,
  mouseInsideEditorRef,
  mouseInsideWidgetRef,
  editorGeometryRef,
  setInsertPanel,
  setActionsOpen,
  setHandle,
  applyVisibility,
  hideTimerRef,
  getVisibleEditorBounds,
  typingRef,
  pointerRef,
  lastMoveRef,
  rafRef,
  handlesRef,
  widgetEnterRef,
  widgetLeaveRef,
}: UseBlockHandleTrackingParams) {
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
          isLast: !column.nextElementSibling?.classList.contains("amby-column"),
          isFirst: !column.previousElementSibling?.classList.contains("amby-column"),
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
      }, 120)
    }

    // The pointer is over the editor but on nothing grabbable: drop the handle now, not
    // after the leave timer, which never fires while the pointer is still inside.
    const dropHover = () => {
      cancelHide()
      if (!hoverTargetRef.current) return
      hoverTargetRef.current = null
      applyVisibility()
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
        if (x >= columnRect.left - COLUMN_GUTTER && x <= contentRect.left + 24) {
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
      for (const { columnRect, blocks, isLast, isFirst } of geometry) {
        if (
          y < columnRect.top ||
          y > columnRect.bottom ||
          (x < columnRect.left - COLUMN_GUTTER && !isFirst) ||
          (x > columnRect.right && !isLast)
        )
          continue
        // The block under the pointer, else the nearest one in the column by height.
        let block: (typeof blocks)[number] | undefined
        let nearest = Infinity
        for (const child of blocks) {
          const distance = Math.max(child.rect.top - y, y - child.rect.bottom, 0)
          if (distance < nearest) {
            nearest = distance
            block = child
          }
        }
        if (!block) continue
        try {
          const domPos = view.posAtDOM(block.element, 0)
          // A block without text (a database) starts right at this position; a text block
          // is found through its content.
          const atBlock = view.state.doc.nodeAt(domPos)
          const safe = Math.min(Math.max(domPos, 0), Math.max(0, view.state.doc.content.size - 1))
          const target =
            atBlock?.isBlock && atBlock.isAtom && DRAGGABLE_TYPES.has(atBlock.type.name)
              ? { pos: domPos, depth: view.state.doc.resolve(domPos).depth + 1, node: atBlock }
              : findDraggableAncestor(view.state.doc.resolve(safe))
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
      const { clipRect } = getVisibleEditorBounds(editorDom)
      if (
        clipRect.width <= 0 ||
        clipRect.height <= 0 ||
        x < clipRect.left ||
        x > clipRect.right ||
        y < clipRect.top ||
        y > clipRect.bottom
      ) {
        dropHover()
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
      // Below the last block (or above the first) there is no line to grab; the nearest
      // block would otherwise keep its handle while the pointer rests in empty space.
      const first = editorDom.firstElementChild
      const last = editorDom.lastElementChild
      if (
        first &&
        last &&
        (y < first.getBoundingClientRect().top - 4 || y > last.getBoundingClientRect().bottom + 4)
      ) {
        dropHover()
        return
      }
      const editorRect = view.dom.getBoundingClientRect()
      const paddingLeft = parseFloat(window.getComputedStyle(view.dom).paddingLeft) || 12
      const contentLeft = editorRect.left + paddingLeft
      const withinGutter =
        x >= contentLeft - HANDLE_WIDTH - GUTTER_GAP - GUTTER_HIT_SLOP && x <= contentLeft + 24
      const localColumnX = projectedColumnX(x, y, geometry)
      // Beside the editor (the page margin) the row's text is found at the content edge.
      const besideEditor = x < editorRect.left || x > editorRect.right
      // Between two blocks the pointer belongs to the nearer one, the upper one when they
      // are equally far: the same rule a click there follows (`nearestLinePos`), so the
      // handle is shown at the line the cursor would go to.
      let rowY = y
      let nearestGap = Infinity
      for (const child of Array.from(editorDom.children)) {
        const rect = child.getBoundingClientRect()
        if (rect.height <= 0) continue
        if (rect.bottom < clipRect.top || rect.top > clipRect.bottom) continue
        const gap = Math.max(rect.top - y, y - rect.bottom, 0)
        if (gap < nearestGap) {
          nearestGap = gap
          rowY = gap === 0 ? y : y < rect.top ? rect.top + 1 : rect.bottom - 1
        }
      }
      const pos = view.posAtCoords({
        left: localColumnX ?? (withinGutter || besideEditor ? contentLeft + 1 : x),
        top: rowY,
      })
      if (!pos) {
        dropHover()
        return
      }
      const target = findDraggableAtCoords(view.state.doc, pos)
      if (!target) {
        dropHover()
        return
      }
      setHoverTarget({
        mode: "block",
        nodePos: target.pos,
        nodeType: target.node.type.name,
      })
    }

    // True while the pointer still sits where it was when typing began.
    const stillAfterTyping = (e: MouseEvent) => {
      const point = typingRef.current
      if (!point) return false
      if (Math.hypot(e.clientX - point.x, e.clientY - point.y) < 4) return true
      typingRef.current = null
      return false
    }

    const onMouseMove = (e: MouseEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY }
      if (pinnedTargetRef.current) return
      if (stillAfterTyping(e)) return
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
      pointerRef.current = { x: e.clientX, y: e.clientY }
      // On the handle itself the block it belongs to stays; nothing under it is "hovered".
      if ((e.target as Element | null)?.closest?.(".amby-block-handles")) {
        cancelHide()
        return
      }
      if (!pinnedTargetRef.current && stillAfterTyping(e)) return
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
      const { rect, clipRect, paddingLeft } = editorGeometry
      const insideClipRect =
        e.clientX >= clipRect.left &&
        e.clientX <= clipRect.right &&
        e.clientY >= clipRect.top &&
        e.clientY <= clipRect.bottom
      if (!insideClipRect) {
        mouseInsideEditorRef.current = false
        dropHover()
        return
      }
      const contentLeft = rect.left + paddingLeft
      const inExtendedGutter =
        e.clientX >= contentLeft - HANDLE_WIDTH - GUTTER_GAP - GUTTER_HIT_SLOP &&
        e.clientX <= contentLeft + 24 &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      // Geometry is read by the RAF-coalesced recompute path. Reuse its last
      // classification here so document-level mousemove stays read-free.
      const inColumnGutter = columnGutterRef.current
      // The empty page beside the text: no block there, so the one on the same row.
      const target = e.target as Node
      const inSideBand =
        target.contains(editorDom) &&
        target !== editorDom &&
        Boolean(geometryContainer?.contains(target)) &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom

      if (inExtendedGutter || inColumnGutter || inSideBand) {
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
      const target = findDraggableAtCoords(view.state.doc, pos)
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

    const onEditorKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const edits =
        e.key.length === 1 ||
        e.key === "Backspace" ||
        e.key === "Delete" ||
        e.key === "Enter" ||
        e.key === "Process" ||
        e.isComposing
      if (!edits) return
      if (!typingRef.current) typingRef.current = { ...pointerRef.current }
      hoverTargetRef.current = null
      applyVisibility()
    }
    // A click is a deliberate act: the handle may come back for the clicked block.
    const onEditorMouseDown = () => {
      typingRef.current = null
    }

    editorDom.addEventListener("keydown", onEditorKeyDown)
    editorDom.addEventListener("mousedown", onEditorMouseDown)
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
      editorDom.removeEventListener("keydown", onEditorKeyDown)
      editorDom.removeEventListener("mousedown", onEditorMouseDown)
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
  }, [
    editor,
    applyVisibility,
    isEditorSurfaceHidden,
    getVisibleEditorBounds,
    columnGeometryRef,
    editorGeometryRef,
    handlesRef,
    hideTimerRef,
    hoverTargetRef,
    lastMoveRef,
    mouseInsideEditorRef,
    mouseInsideWidgetRef,
    pinnedTargetRef,
    pointerRef,
    rafRef,
    setActionsOpen,
    setHandle,
    setInsertPanel,
    typingRef,
    widgetEnterRef,
    widgetLeaveRef,
  ])
}
