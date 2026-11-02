import {
  BUTTON_H,
  type ColumnGeometry,
  HANDLE_APPEAR_DELAY_S,
  HANDLE_WIDTH,
  type HandleState,
  type HoverTarget,
} from "./block-handles-geometry"
import * as React from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/react"
import { GripVertical } from "lucide-react"
import { animate } from "motion/react"
import { motionTransition, motionTransitions } from "@/lib/motion-config"
import { BlockActionsPanel } from "./BlockActionsPanel"
import { BlockInsertPanel } from "./BlockInsertPanel"
import { CLOSE_EDITOR_MENUS_EVENT } from "./floating-menu-events"
import { removeSoleBlockColumn } from "./columns-transaction"
import { useBlockDrag } from "./use-block-drag"
import { useBlockHandleTracking } from "./use-block-handle-tracking"
import { useBlockHandleVisibility } from "./use-block-handle-visibility"

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
  // The delayed appearance of the handle: the block it was last placed at, the running
  // fade, whether one of its menus is open, and a counter that restarts the fade.
  const placedAtRef = React.useRef<string | null>(null)
  const appearRef = React.useRef<{ stop: () => void } | null>(null)
  const menuOpenRef = React.useRef(false)
  const [appearTick, setAppearTick] = React.useState(0)

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
  // Set while the user types: where the pointer was. The handle stays hidden until the
  // pointer really moves away from it (a reflow under a still pointer does not count).
  const typingRef = React.useRef<{ x: number; y: number } | null>(null)
  const pointerRef = React.useRef({ x: 0, y: 0 })
  const lastMoveRef = React.useRef<{ x: number; y: number } | null>(null)
  const widgetEnterRef = React.useRef<(() => void) | null>(null)
  const widgetLeaveRef = React.useRef<(() => void) | null>(null)
  const columnGeometryRef = React.useRef<ColumnGeometry[] | null>(null)
  const editorGeometryRef = React.useRef<{
    rect: DOMRect
    clipRect: DOMRect
    paddingLeft: number
  } | null>(null)

  const { isEditorSurfaceHidden, applyVisibility, getVisibleEditorBounds } =
    useBlockHandleVisibility({
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
    })

  useBlockHandleTracking({
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
  })

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

  const { startDrag } = useBlockDrag({
    dragRef,
    handle,
    setInsertPanel,
    setActionsOpen,
    editor,
    ghostRef,
    handlesRef,
    pinnedTargetRef,
  })

  // The handle waits 0.3 s and then fades in, at its first block and at every next one
  // (`applyVisibility` restarts it), so that it does not flash under a pointer that only
  // crosses the text. With a
  // menu of the handle open it stays as it is: the block under it may change its position.
  const menuOpen = actionsOpen || insertPanel.open
  React.useLayoutEffect(() => {
    menuOpenRef.current = menuOpen
    // A press on a handle that is still fading in shows it in full at once.
    if (!menuOpen) return
    appearRef.current?.stop()
    appearRef.current = null
    handlesRef.current?.style.removeProperty("opacity")
  }, [menuOpen])
  React.useLayoutEffect(() => {
    const element = handlesRef.current
    if (!handle.visible || !element || menuOpenRef.current || dragRef.current.active) return
    element.style.opacity = "0"
    try {
      const controls = animate(
        element,
        { opacity: [0, 1] },
        { ...motionTransition(motionTransitions.default), delay: HANDLE_APPEAR_DELAY_S },
      )
      appearRef.current = controls
      return () => {
        controls.stop()
        if (appearRef.current === controls) appearRef.current = null
        element.style.removeProperty("opacity")
      }
    } catch {
      element.style.removeProperty("opacity")
    }
  }, [handle.visible, appearTick])

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
