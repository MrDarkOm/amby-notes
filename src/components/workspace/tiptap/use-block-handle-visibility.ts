import {
  BUTTON_H,
  GUTTER_GAP,
  HANDLE_WIDTH,
  type HandleState,
  type HoverTarget,
} from "./block-handles-geometry"
import * as React from "react"
import type { Editor } from "@tiptap/react"

interface UseBlockHandleVisibilityParams {
  editor: Editor
  setHandle: React.Dispatch<React.SetStateAction<HandleState>>
  dragRef: React.RefObject<{ srcPos: number; startX: number; startY: number; active: boolean }>
  typingRef: React.RefObject<{ x: number; y: number } | null>
  pinnedTargetRef: React.RefObject<HoverTarget | null>
  editorGeometryRef: React.RefObject<{
    rect: DOMRect
    clipRect: DOMRect
    paddingLeft: number
  } | null>
  mouseInsideEditorRef: React.RefObject<boolean>
  mouseInsideWidgetRef: React.RefObject<boolean>
  hoverTargetRef: React.RefObject<HoverTarget | null>
  placedAtRef: React.RefObject<string | null>
  menuOpenRef: React.RefObject<boolean>
  appearRef: React.RefObject<{ stop: () => void } | null>
  handlesRef: React.RefObject<HTMLDivElement | null>
  setAppearTick: React.Dispatch<React.SetStateAction<number>>
  posRef: React.RefObject<{ top: number; left: number }>
}

export function useBlockHandleVisibility({
  editor,
  setHandle,
  dragRef,
  typingRef,
  pinnedTargetRef,
  editorGeometryRef,
  mouseInsideEditorRef,
  mouseInsideWidgetRef,
  hoverTargetRef,
  placedAtRef,
  menuOpenRef,
  appearRef,
  handlesRef,
  setAppearTick,
  posRef,
}: UseBlockHandleVisibilityParams) {
  const getVisibleEditorBounds = React.useCallback((editorDom: HTMLElement) => {
    const rawRect = editorDom.getBoundingClientRect()
    const scrollEl = editorDom.closest<HTMLElement>(".amby-editor-scroll")
    const clipRect = scrollEl ? scrollEl.getBoundingClientRect() : rawRect
    const top = Math.max(rawRect.top, clipRect.top)
    const bottom = Math.min(rawRect.bottom, clipRect.bottom)
    const left = Math.max(rawRect.left, clipRect.left)
    const right = Math.min(rawRect.right, clipRect.right)
    return {
      rect: new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top)),
      clipRect,
    }
  }, [])

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
    // Typing hides the handle, and skips the layout reads below on every keystroke.
    if (typingRef.current && !pinnedTargetRef.current) {
      setHandle((h) => (h.visible ? { ...h, visible: false } : h))
      return
    }

    const { state, view } = editor
    const bounds = getVisibleEditorBounds(view.dom as HTMLElement)
    editorGeometryRef.current = {
      rect: bounds.rect,
      clipRect: bounds.clipRect,
      paddingLeft: parseFloat(window.getComputedStyle(view.dom).paddingLeft) || 12,
    }

    const mouseOver = mouseInsideEditorRef.current || mouseInsideWidgetRef.current
    // The handle follows the pointer (or a pinned menu), never the caret: with the
    // pointer gone it must not stay behind on the line being edited.
    const target = pinnedTargetRef.current ?? (mouseOver ? hoverTargetRef.current : null)
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

    // Never render the body-portaled grip outside the note's visible scroll container.
    if (
      bounds.clipRect.width <= 0 ||
      bounds.clipRect.height <= 0 ||
      top < bounds.clipRect.top + 2 ||
      top + BUTTON_H > bounds.clipRect.bottom - 2 ||
      left < bounds.clipRect.left ||
      left + HANDLE_WIDTH > bounds.clipRect.right
    ) {
      setHandle((h) => (h.visible ? { ...h, visible: false } : h))
      return
    }

    // At another block the handle is hidden before it is moved there, or it would be seen
    // jumping after the pointer for a frame before the fade starts over.
    const placedAt = `${target.mode}:${target.nodePos}:${target.insertPos ?? -1}`
    if (placedAt !== placedAtRef.current) {
      placedAtRef.current = placedAt
      if (!menuOpenRef.current) {
        appearRef.current?.stop()
        appearRef.current = null
        if (handlesRef.current) handlesRef.current.style.opacity = "0"
        setAppearTick((tick) => tick + 1)
      }
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
  }, [
    editor,
    isEditorSurfaceHidden,
    getVisibleEditorBounds,
    appearRef,
    dragRef,
    editorGeometryRef,
    handlesRef,
    hoverTargetRef,
    menuOpenRef,
    mouseInsideEditorRef,
    mouseInsideWidgetRef,
    pinnedTargetRef,
    placedAtRef,
    posRef,
    setAppearTick,
    setHandle,
    typingRef,
  ])
  return { isEditorSurfaceHidden, applyVisibility, getVisibleEditorBounds }
}
