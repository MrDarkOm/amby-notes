import { blockContentRect, blockSideAtPoint, blockInsertionLineTop } from "./block-drop-geometry"
import { imageDragFeedback, imageDragScrollContainer } from "./image-drag-feedback"
import { Extension } from "@tiptap/core"
import { Fragment, type Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import {
  createColumnsFromDrop,
  insertBlockBeside,
  removeSoleBlockColumn,
  type ColumnDropSide,
} from "./columns-transaction"

/** Insert one image as a paragraph, splitting only the textblock being edited. */
export function insertImageBlock(tr: Transaction, pos: number, image: PMNode): number {
  const $pos = tr.doc.resolve(pos)
  const paragraph = tr.doc.type.schema.nodes.paragraph.create(null, image)
  if (!$pos.parent.isTextblock) {
    tr.insert(pos, paragraph)
    tr.setSelection(NodeSelection.create(tr.doc, pos + 1))
    return pos + paragraph.nodeSize
  }
  const parent = $pos.parent
  const before = parent.content.cut(0, $pos.parentOffset)
  const after = parent.content.cut($pos.parentOffset)
  const blocks: PMNode[] = []
  if (before.size) blocks.push(parent.copy(before))
  const start = $pos.before()
  const imagePos = start + (blocks[0]?.nodeSize ?? 0)
  blocks.push(paragraph)
  if (after.size) blocks.push(parent.copy(after))
  tr.replaceWith(start, $pos.after(), Fragment.fromArray(blocks))
  tr.setSelection(NodeSelection.create(tr.doc, imagePos + 1))
  return imagePos + paragraph.nodeSize
}

/** Only pictures, optionally wrapped in paragraphs; never discard accompanying text. */
export function imagesOnly(content: Fragment): PMNode[] | null {
  const images: PMNode[] = []
  let otherContent = false
  content.descendants((node) => {
    if (node.type.name === "image") {
      images.push(node)
      return false
    }
    if (node.type.name !== "paragraph") otherContent = true
  })
  return images.length && !otherContent ? images : null
}

type ImageDropTarget = { pos: number; rect: DOMRect; side: ColumnDropSide | null; before: boolean }

function dropTarget(
  view: EditorView,
  x: number,
  y: number,
  _sourcePos: number | null,
): ImageDropTarget | null {
  const viewport = (
    view.dom.closest(".amby-editor-scroll") ??
    view.dom.parentElement ??
    view.dom
  ).getBoundingClientRect()
  if (x < viewport.left || x > viewport.right || y < viewport.top - 16 || y > viewport.bottom + 16)
    return null
  const hit = view.posAtCoords({ left: x, top: y })
  let $pos = hit ? view.state.doc.resolve(hit.pos) : null
  // A gap between blocks resolves to the doc itself in WebKit. Keep a visible
  // destination there by using the closest actual row, as the block Grab does.
  if (!$pos || $pos.depth === 0) {
    const bounds = view.dom.getBoundingClientRect()
    if (y < bounds.top - 40 || y > bounds.bottom + 40) return null
    let closest: number | null = null
    let score = Infinity
    view.state.doc.descendants((node, pos) => {
      if (
        !node.isBlock ||
        !["doc", "column"].includes(view.state.doc.resolve(pos).parent.type.name)
      )
        return
      const dom = view.nodeDOM(pos)
      if (!(dom instanceof HTMLElement)) return
      const rect = dom.getBoundingClientRect()
      if (!rect.height || !rect.width) return
      const distance =
        Math.max(rect.top - y, y - rect.bottom, 0) * 1000 +
        Math.max(rect.left - x, x - rect.right, 0)
      if (distance <= score) {
        closest = pos
        score = distance
      }
    })
    if (closest === null) return null
    $pos = view.state.doc.resolve(closest + 1)
  }
  for (let depth = $pos.depth; depth > 0; depth--) {
    if (!["doc", "column"].includes($pos.node(depth - 1).type.name)) continue
    const pos = $pos.before(depth)
    const dom = view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement)) return null
    const contentRect = blockContentRect(dom)
    const side = blockSideAtPoint(contentRect, x, y)
    const rect = side ? contentRect : dom.getBoundingClientRect()
    return { pos, rect, side, before: y < rect.top + rect.height / 2 }
  }
  return null
}

/** An imported image dropped at a block's side uses the same columns as an internal drag. */
export function insertImageAtPoint(
  view: EditorView,
  tr: Transaction,
  point: { x: number; y: number },
  image: PMNode,
): boolean {
  const target = dropTarget(view, point.x, point.y, null)
  if (!target?.side) return false
  const paragraph = tr.doc.type.schema.nodes.paragraph.create(null, image)
  const pos = insertBlockBeside(tr, target.pos, paragraph, target.side)
  if (pos === null) return false
  tr.setSelection(NodeSelection.create(tr.doc, pos + 1))
  return true
}

function placeImage(
  view: EditorView,
  dragged: { pos: number; node: PMNode } | null,
  image: PMNode,
  target: ImageDropTarget,
  moved: boolean,
): boolean {
  let tr = view.state.tr
  if (moved && dragged) {
    const $source = tr.doc.resolve(dragged.pos)
    if ($source.parent.type.name === "paragraph" && $source.parent.childCount === 1) {
      if ($source.before() === target.pos) return true
      if (target.side) {
        const columns = createColumnsFromDrop(view.state, $source.before(), target.pos, target.side)
        if (columns) {
          view.dispatch(columns.setMeta("uiEvent", "drop"))
          return true
        }
      }
      const cleanup = removeSoleBlockColumn(view.state, $source.before())
      if (cleanup) tr = cleanup
      else tr.delete($source.before(), $source.after())
    } else tr.delete(dragged.pos, dragged.pos + dragged.node.nodeSize)
  }
  // Collapsing a two-column set replaces its entire range, so a step map
  // cannot locate a surviving child inside that range. Follow its node identity.
  const originalTarget = view.state.doc.nodeAt(target.pos)
  let survivingTarget: number | null = null
  tr.doc.descendants((node, pos) => {
    if (node === originalTarget && survivingTarget === null) survivingTarget = pos
  })
  const targetPos = survivingTarget ?? tr.mapping.map(target.pos, 1)
  const block = tr.doc.nodeAt(targetPos)
  if (!block) return true
  const paragraph = tr.doc.type.schema.nodes.paragraph.create(null, image)
  if (target.side) {
    const pos = insertBlockBeside(tr, targetPos, paragraph, target.side)
    if (pos !== null) {
      tr.setSelection(NodeSelection.create(tr.doc, pos + 1))
      view.dispatch(tr.setMeta("uiEvent", "drop"))
      return true
    }
  }
  const insertPos = target.before ? targetPos : targetPos + block.nodeSize
  tr.insert(insertPos, paragraph)
  tr.setSelection(NodeSelection.create(tr.doc, insertPos + 1))
  view.dispatch(tr.setMeta("uiEvent", "drop"))
  return true
}

const pointerDrags = new WeakMap<EditorView, (event: PointerEvent, wrapper: HTMLElement) => void>()

/** Node views forward pointer gestures here; the placement plugin owns their lifecycle. */
export function beginImagePointerDrag(view: EditorView, event: PointerEvent, wrapper: HTMLElement) {
  pointerDrags.get(view)?.(event, wrapper)
}

/** Pointer gestures and external image drops share lossless image placement. */
export const ImagePlacement = Extension.create({
  name: "imagePlacement",
  addProseMirrorPlugins() {
    let source: { pos: number; node: PMNode } | null = null
    let indicator: HTMLDivElement | null = null
    const clearIndicator = () => {
      indicator?.remove()
      indicator = null
    }
    const clear = () => {
      clearIndicator()
      source = null
    }
    let stopPointer = () => {}
    const showIndicator = (view: EditorView, x: number, y: number) => {
      const target = dropTarget(view, x, y, source?.pos ?? null)
      if (!target) {
        clearIndicator()
        return false
      }
      if (!indicator) {
        indicator = document.createElement("div")
        document.body.appendChild(indicator)
      }
      const { rect, side } = target
      indicator.className =
        "amby-block-drop-indicator" + (side ? " amby-block-drop-indicator--column" : "")
      const lineTop = side ? rect.top : blockInsertionLineTop(view, target.pos, rect, target.before)
      Object.assign(indicator.style, {
        left: `${side === "right" ? rect.right - 3 : rect.left}px`,
        top: `${side ? lineTop : lineTop - 1}px`,
        width: `${side ? 3 : rect.width}px`,
        height: `${side ? rect.height : 2}px`,
      })
      return true
    }
    const beginPointer = (view: EditorView, event: PointerEvent, wrapper: HTMLElement) => {
      if (!view.editable || event.button !== 0 || event.ctrlKey) return
      stopPointer()
      clear()
      const pos = view.posAtDOM(wrapper, 0)
      const node = view.state.doc.nodeAt(pos)
      if (node?.type.name !== "image") return
      event.preventDefault() // Keep WKWebView's native asset/file drag from taking over.
      source = { pos, node }
      const dragged = source
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
      // preventDefault above also cancels the click's focus: without it the browser keeps its
      // old text selection (a whole block, or all of the note) painted over the picture.
      if (!view.hasFocus()) view.focus()
      const start = { x: event.clientX, y: event.clientY }
      let active = false
      let feedback: ReturnType<typeof imageDragFeedback> = null
      let frame: number | null = null
      let last = start
      const scrollContainer = imageDragScrollContainer(view.dom)
      const paint = () => {
        frame = null
        if (!active) return
        feedback?.position(last.x, last.y)
        if (scrollContainer) {
          const bounds = scrollContainer.getBoundingClientRect()
          const distance =
            last.y < bounds.top + 56
              ? last.y - bounds.top - 56
              : last.y > bounds.bottom - 56
                ? last.y - bounds.bottom + 56
                : 0
          if (distance) {
            scrollContainer.scrollTop +=
              Math.sign(distance) * Math.min(18, Math.pow(Math.abs(distance) / 56, 2) * 18)
            frame = requestAnimationFrame(paint)
          }
        }
        showIndicator(view, last.x, last.y)
      }
      const move = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return
        if (!view.editable || view.state.doc.nodeAt(pos) !== node) {
          stopPointer()
          return
        }
        if (!active && Math.hypot(next.clientX - start.x, next.clientY - start.y) < 6) return
        if (!active) {
          active = true
          feedback = imageDragFeedback(wrapper, start)
        }
        next.preventDefault()
        last = { x: next.clientX, y: next.clientY }
        if (frame === null) frame = requestAnimationFrame(paint)
      }
      const up = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return
        const target =
          active && next.type === "pointerup"
            ? dropTarget(view, next.clientX, next.clientY, pos)
            : null
        const lifted = feedback
        feedback = null
        stopPointer()
        if (target && view.editable && view.state.doc.nodeAt(pos) === node) {
          placeImage(view, dragged, node, target, true)
          // React node views settle on the next paint after the transaction.
          requestAnimationFrame(() => {
            const dom = view.isDestroyed ? null : view.nodeDOM(view.state.selection.from)
            const image = dom instanceof HTMLElement ? dom.querySelector("img") : null
            lifted?.finish(image?.getBoundingClientRect())
          })
        } else lifted?.finish()
      }
      const escape = (next: KeyboardEvent) => {
        if (next.key === "Escape") stopPointer()
      }
      const doc = view.dom.ownerDocument
      stopPointer = () => {
        if (frame !== null) cancelAnimationFrame(frame)
        frame = null
        active = false
        feedback?.finish()
        feedback = null
        doc.removeEventListener("pointermove", move)
        doc.removeEventListener("pointerup", up)
        doc.removeEventListener("pointercancel", up)
        doc.removeEventListener("keydown", escape)
        doc.defaultView?.removeEventListener("blur", stopPointer)
        stopPointer = () => {}
        clear()
      }
      doc.addEventListener("pointermove", move)
      doc.addEventListener("pointerup", up)
      doc.addEventListener("pointercancel", up)
      doc.addEventListener("keydown", escape)
      doc.defaultView?.addEventListener("blur", stopPointer)
    }
    return [
      new Plugin({
        key: new PluginKey("imagePlacement"),
        view: (view) => {
          pointerDrags.set(view, (event, wrapper) => beginPointer(view, event, wrapper))
          return {
            destroy: () => {
              stopPointer()
              pointerDrags.delete(view)
              clear()
            },
          }
        },
        props: {
          handleDOMEvents: {
            dragstart(view, event) {
              clear()
              const wrapper =
                event.target instanceof Element
                  ? (event.target.closest(".amby-image-wrap") ??
                    event.target.closest(".node-image")?.querySelector(".amby-image-wrap"))
                  : null
              if (!wrapper) return false
              const pos = view.posAtDOM(wrapper, 0)
              const node = view.state.doc.nodeAt(pos)
              if (node?.type.name === "image") source = { pos, node }
              return false
            },
            dragover(view, event) {
              const externalImage = Array.from(event.dataTransfer?.items ?? []).some(
                (item) => item.kind === "file" && item.type.startsWith("image/"),
              )
              if ((!source && !externalImage) || !view.editable) return false
              event.preventDefault()
              return showIndicator(view, event.clientX, event.clientY)
            },
            dragleave(view, event) {
              if (!(event.relatedTarget instanceof Node) || !view.dom.contains(event.relatedTarget))
                clearIndicator()
              return false
            },
            dragend() {
              clear()
              return false
            },
          },
          handlePaste(view, _event, slice) {
            const images = imagesOnly(slice.content)
            if (!images || !view.editable || view.state.selection.$from.parent.type.spec.code)
              return false
            const tr = view.state.tr.deleteSelection()
            let pos = tr.selection.from
            for (const image of images) pos = insertImageBlock(tr, pos, image)
            view.dispatch(tr.setMeta("paste", true).setMeta("uiEvent", "paste"))
            return true
          },
          handleDrop(view, event, slice, moved) {
            const dragged = source
            clear()
            if (!view.editable || (dragged && view.state.doc.nodeAt(dragged.pos) !== dragged.node))
              return false
            const images = imagesOnly(slice.content)
            if (!images || images.length !== 1 || (moved && !dragged)) return false
            const image = dragged?.node ?? images[0]
            const target = dropTarget(view, event.clientX, event.clientY, dragged?.pos ?? null)
            if (!target) return false
            return placeImage(view, dragged, image, target, moved)
          },
        },
      }),
    ]
  },
})
