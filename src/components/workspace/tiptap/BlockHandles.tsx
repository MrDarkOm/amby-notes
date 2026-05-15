"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/react"
import {
  CheckSquare,
  Code2,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  MessageSquare,
  Minus,
  Pilcrow,
  Plus,
  Quote,
  Trash2,
} from "lucide-react"

import { CALLOUT_DEFAULTS } from "./callout-node"

// ── Shared drag state (lives outside React so handleDrop on the editor can read it) ──

export interface BlockDragState {
  active: boolean
  srcPos: number
}

export const blockDragState: BlockDragState = { active: false, srcPos: -1 }

// ── Block type insertion options ──────────────────────────────────────────────

interface InsertOption {
  label: string
  icon: React.ElementType
  action: (editor: Editor, nodePos: number) => void
}

function insertAfterBlock(editor: Editor, nodePos: number, nodeJson: object) {
  const node = editor.state.doc.nodeAt(nodePos)
  if (!node) return
  const afterPos = nodePos + node.nodeSize
  editor.chain().focus().insertContentAt(afterPos, nodeJson).run()
}

const INSERT_OPTIONS: InsertOption[] = [
  {
    label: "Paragraph",
    icon: Pilcrow,
    action: (e, pos) => insertAfterBlock(e, pos, { type: "paragraph" }),
  },
  {
    label: "Heading 1",
    icon: Heading1,
    action: (e, pos) => insertAfterBlock(e, pos, { type: "heading", attrs: { level: 1 } }),
  },
  {
    label: "Heading 2",
    icon: Heading2,
    action: (e, pos) => insertAfterBlock(e, pos, { type: "heading", attrs: { level: 2 } }),
  },
  {
    label: "Heading 3",
    icon: Heading3,
    action: (e, pos) => insertAfterBlock(e, pos, { type: "heading", attrs: { level: 3 } }),
  },
  {
    label: "Bullet list",
    icon: List,
    action: (e, pos) =>
      insertAfterBlock(e, pos, {
        type: "bulletList",
        content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
      }),
  },
  {
    label: "Numbered list",
    icon: ListOrdered,
    action: (e, pos) =>
      insertAfterBlock(e, pos, {
        type: "orderedList",
        content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
      }),
  },
  {
    label: "Task list",
    icon: CheckSquare,
    action: (e, pos) =>
      insertAfterBlock(e, pos, {
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph" }] },
        ],
      }),
  },
  {
    label: "Code block",
    icon: Code2,
    action: (e, pos) => insertAfterBlock(e, pos, { type: "codeBlock" }),
  },
  {
    label: "Callout",
    icon: MessageSquare,
    action: (e, pos) =>
      insertAfterBlock(e, pos, {
        type: "callout",
        attrs: { calloutType: "NOTE", emoji: CALLOUT_DEFAULTS.NOTE },
        content: [{ type: "paragraph" }],
      }),
  },
  {
    label: "Blockquote",
    icon: Quote,
    action: (e, pos) =>
      insertAfterBlock(e, pos, {
        type: "blockquote",
        content: [{ type: "paragraph" }],
      }),
  },
  {
    label: "Divider",
    icon: Minus,
    action: (e, pos) => insertAfterBlock(e, pos, { type: "horizontalRule" }),
  },
]

// ── Block action options (shown on grip-click palette) ────────────────────────

interface ActionOption {
  label: string
  icon: React.ElementType
  danger?: boolean
  action: (editor: Editor, nodePos: number) => void
}

function focusInsideBlock(editor: Editor, nodePos: number) {
  const inner = nodePos + 1
  editor.chain().focus().setTextSelection(inner).run()
}

const BLOCK_ACTIONS: ActionOption[] = [
  {
    label: "Paragraph",
    icon: Pilcrow,
    action: (editor, pos) => {
      focusInsideBlock(editor, pos)
      editor.chain().focus().setParagraph().run()
    },
  },
  {
    label: "Heading 1",
    icon: Heading1,
    action: (editor, pos) => {
      focusInsideBlock(editor, pos)
      editor.chain().focus().setHeading({ level: 1 }).run()
    },
  },
  {
    label: "Heading 2",
    icon: Heading2,
    action: (editor, pos) => {
      focusInsideBlock(editor, pos)
      editor.chain().focus().setHeading({ level: 2 }).run()
    },
  },
  {
    label: "Heading 3",
    icon: Heading3,
    action: (editor, pos) => {
      focusInsideBlock(editor, pos)
      editor.chain().focus().setHeading({ level: 3 }).run()
    },
  },
  {
    label: "Delete block",
    icon: Trash2,
    danger: true,
    action: (editor, pos) => {
      const node = editor.state.doc.nodeAt(pos)
      if (!node) return
      const { state, dispatch } = editor.view
      dispatch(state.tr.delete(pos, pos + node.nodeSize))
    },
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearDragIndicators() {
  document.querySelectorAll("[data-drag-before],[data-drag-after]").forEach(el => {
    el.removeAttribute("data-drag-before")
    el.removeAttribute("data-drag-after")
  })
}

// ── Main component ────────────────────────────────────────────────────────────

interface HandleState {
  visible: boolean
  top: number
  left: number
  nodePos: number
}

export function BlockHandles({ editor }: { editor: Editor }) {
  const [handle, setHandle] = React.useState<HandleState>({
    visible: false,
    top: 0,
    left: 0,
    nodePos: -1,
  })
  const [insertOpen, setInsertOpen] = React.useState(false)
  const [actionsOpen, setActionsOpen] = React.useState(false)
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const didDragRef = React.useRef(false)

  const cancelHide = React.useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }, [])

  const scheduleHide = React.useCallback(() => {
    cancelHide()
    hideTimer.current = setTimeout(() => {
      setHandle(h => ({ ...h, visible: false }))
      setInsertOpen(false)
      setActionsOpen(false)
    }, 350)
  }, [cancelHide])

  // ── Mouse tracking on the editor dom ──────────────────────────────────────
  React.useEffect(() => {
    const dom = editor.view.dom as HTMLElement

    function onMouseMove(e: MouseEvent) {
      if (!editor.isEditable) return
      cancelHide()

      const posMaybe = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (!posMaybe) {
        scheduleHide()
        return
      }

      const { doc } = editor.state
      const safe = Math.min(posMaybe.pos, doc.content.size - 1)
      if (safe < 0) {
        scheduleHide()
        return
      }

      const $pos = doc.resolve(safe)
      if ($pos.depth === 0) {
        scheduleHide()
        return
      }

      // The top-level block is at depth 1 (direct child of doc)
      const nodePos = $pos.before(1)
      const nodeDom = editor.view.nodeDOM(nodePos) as HTMLElement | null
      if (!nodeDom) {
        scheduleHide()
        return
      }

      const rect = nodeDom.getBoundingClientRect()
      // Place handle buttons to the left of the text column, clamped to viewport
      const left = Math.max(4, rect.left - 56)

      setHandle({ visible: true, top: rect.top, left, nodePos })
    }

    function onMouseLeave() {
      scheduleHide()
    }

    dom.addEventListener("mousemove", onMouseMove)
    dom.addEventListener("mouseleave", onMouseLeave)
    return () => {
      dom.removeEventListener("mousemove", onMouseMove)
      dom.removeEventListener("mouseleave", onMouseLeave)
    }
  }, [editor, cancelHide, scheduleHide])

  // ── Drag-and-drop: editor-side dragover / drop ────────────────────────────
  React.useEffect(() => {
    const dom = editor.view.dom as HTMLElement
    function setIndicator(el: HTMLElement | null, before: boolean) {
      clearDragIndicators()
      if (!el) return
      el.setAttribute(before ? "data-drag-before" : "data-drag-after", "true")
    }

    function onDragOver(e: DragEvent) {
      if (!blockDragState.active) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move"

      const pos = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (!pos) { setIndicator(null, true); return }

      const { doc } = editor.state
      const safe = Math.min(pos.pos, doc.content.size - 1)
      if (safe < 0) { setIndicator(null, true); return }

      const $pos = doc.resolve(safe)
      if ($pos.depth === 0) { setIndicator(null, true); return }

      const targetPos = $pos.before(1)
      const targetDom = editor.view.nodeDOM(targetPos) as HTMLElement | null
      if (!targetDom) { setIndicator(null, true); return }

      const rect = targetDom.getBoundingClientRect()
      const before = e.clientY < rect.top + rect.height / 2
      setIndicator(targetDom, before)
    }

    function onDrop(e: DragEvent) {
      if (!blockDragState.active) return
      e.preventDefault()
      clearDragIndicators()

      const srcPos = blockDragState.srcPos
      blockDragState.active = false
      blockDragState.srcPos = -1

      if (srcPos < 0) return

      const pos = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (!pos) return

      const { state, dispatch } = editor.view
      const { doc } = state
      const safe = Math.min(pos.pos, doc.content.size - 1)
      if (safe < 0) return

      const $drop = doc.resolve(safe)
      if ($drop.depth === 0) return

      const targetBlockPos = $drop.before(1)
      const targetNode = doc.nodeAt(targetBlockPos)
      if (!targetNode) return

      const srcNode = doc.nodeAt(srcPos)
      if (!srcNode) return

      const targetDomEl = editor.view.nodeDOM(targetBlockPos) as HTMLElement | null
      let insertPos: number
      if (targetDomEl) {
        const rect = targetDomEl.getBoundingClientRect()
        const before = e.clientY < rect.top + rect.height / 2
        insertPos = before ? targetBlockPos : targetBlockPos + targetNode.nodeSize
      } else {
        insertPos = targetBlockPos
      }

      const srcEnd = srcPos + srcNode.nodeSize
      if (insertPos >= srcPos && insertPos <= srcEnd) return // same block

      const tr = state.tr
      if (insertPos < srcPos) {
        // Insert copy before source, then delete original (now shifted by nodeSize)
        tr.insert(insertPos, srcNode).delete(
          srcPos + srcNode.nodeSize,
          srcPos + srcNode.nodeSize * 2,
        )
      } else {
        // Delete first, then insert at adjusted position
        tr.delete(srcPos, srcEnd).insert(insertPos - srcNode.nodeSize, srcNode)
      }
      dispatch(tr)
    }

    function onDragEnd() {
      clearDragIndicators()
      blockDragState.active = false
    }

    dom.addEventListener("dragover", onDragOver)
    dom.addEventListener("drop", onDrop)
    dom.addEventListener("dragend", onDragEnd)
    return () => {
      dom.removeEventListener("dragover", onDragOver)
      dom.removeEventListener("drop", onDrop)
      dom.removeEventListener("dragend", onDragEnd)
    }
  }, [editor])

  if (!handle.visible || !editor.isEditable) return null

  return createPortal(
    <div
      className="amby-block-handles"
      style={{ top: handle.top, left: handle.left }}
      onMouseEnter={cancelHide}
      onMouseLeave={scheduleHide}
    >
      {/* ── Insert (+) button ──────────────────────────────────────────── */}
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

      {/* ── Drag / grip button ────────────────────────────────────────── */}
      <button
        type="button"
        className="amby-block-handle-btn amby-block-handle-grip"
        title="Drag to reorder · Click for block actions"
        draggable
        onMouseDown={() => {
          didDragRef.current = false
        }}
        onDragStart={e => {
          didDragRef.current = true
          blockDragState.active = true
          blockDragState.srcPos = handle.nodePos
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move"
            e.dataTransfer.setData("application/x-amby-block", String(handle.nodePos))
          }
          setInsertOpen(false)
          setActionsOpen(false)
        }}
        onDragEnd={() => {
          blockDragState.active = false
          clearDragIndicators()
        }}
        onClick={() => {
          if (!didDragRef.current) {
            setActionsOpen(v => !v)
            setInsertOpen(false)
          }
        }}
      >
        <GripVertical className="size-3.5" />
      </button>

      {/* ── Insert block menu ─────────────────────────────────────────── */}
      {insertOpen && (
        <div className="amby-block-handle-menu" onMouseDown={e => e.preventDefault()}>
          {INSERT_OPTIONS.map(opt => (
            <button
              key={opt.label}
              type="button"
              className="amby-block-handle-menu-item"
              onClick={() => {
                opt.action(editor, handle.nodePos)
                setInsertOpen(false)
                setHandle(h => ({ ...h, visible: false }))
              }}
            >
              <opt.icon className="size-3.5 shrink-0 text-zinc-500" />
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Block actions palette ────────────────────────────────────── */}
      {actionsOpen && (
        <div className="amby-block-handle-menu" onMouseDown={e => e.preventDefault()}>
          {BLOCK_ACTIONS.map(act => (
            <button
              key={act.label}
              type="button"
              className={`amby-block-handle-menu-item${act.danger ? " amby-block-handle-menu-item--danger" : ""}`}
              onClick={() => {
                act.action(editor, handle.nodePos)
                setActionsOpen(false)
                setHandle(h => ({ ...h, visible: false }))
              }}
            >
              <act.icon className="size-3.5 shrink-0 text-zinc-500" />
              {act.label}
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  )
}
