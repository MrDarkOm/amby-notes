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
  sourcePos: number | null,
): ImageDropTarget | null {
  const hit = view.posAtCoords({ left: x, top: y })
  if (!hit) return null
  const $pos = view.state.doc.resolve(hit.pos)
  for (let depth = $pos.depth; depth > 0; depth--) {
    if (!["doc", "column"].includes($pos.node(depth - 1).type.name)) continue
    const pos = $pos.before(depth)
    const dom = view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement)) return null
    let rect = dom.getBoundingClientRect()
    // The image's visible edge may be far from the paragraph's full-width edge.
    let closest = Infinity
    for (const image of dom.querySelectorAll<HTMLElement>(".amby-image-wrap")) {
      if (sourcePos !== null && view.posAtDOM(image, 0) === sourcePos) continue
      const imageRect = (image.querySelector("img") ?? image).getBoundingClientRect()
      const distance =
        Math.max(imageRect.left - x, x - imageRect.right, 0) +
        Math.max(imageRect.top - y, y - imageRect.bottom, 0)
      if (distance < closest) {
        closest = distance
        rect = imageRect
      }
    }
    const inHeight = y > rect.top + rect.height * 0.1 && y < rect.bottom - rect.height * 0.1
    const side =
      inHeight && x >= rect.left - 40 && x < rect.left + rect.width * 0.34
        ? "left"
        : inHeight && x > rect.right - rect.width * 0.34 && x <= rect.right + 40
          ? "right"
          : null
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

/** Native image drags move the picture, even when old Markdown put several in one paragraph. */
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
    return [
      new Plugin({
        key: new PluginKey("imagePlacement"),
        view: () => ({ destroy: clear }),
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
              const target = dropTarget(view, event.clientX, event.clientY, source?.pos ?? null)
              if (!target) {
                clearIndicator()
                return false
              }
              event.preventDefault()
              if (!indicator) {
                indicator = document.createElement("div")
                document.body.appendChild(indicator)
              }
              const { rect, side } = target
              indicator.className =
                "amby-block-drop-indicator" + (side ? " amby-block-drop-indicator--column" : "")
              Object.assign(indicator.style, {
                left: `${side === "right" ? rect.right - 3 : rect.left}px`,
                top: `${side ? rect.top : target.before ? rect.top : rect.bottom}px`,
                width: `${side ? 3 : rect.width}px`,
                height: `${side ? rect.height : 2}px`,
              })
              return true
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
            let tr = view.state.tr
            if (moved && dragged) {
              const $source = tr.doc.resolve(dragged.pos)
              if ($source.parent.type.name === "paragraph" && $source.parent.childCount === 1) {
                if ($source.before() === target.pos) return true
                if (target.side) {
                  const columns = createColumnsFromDrop(
                    view.state,
                    $source.before(),
                    target.pos,
                    target.side,
                  )
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
          },
        },
      }),
    ]
  },
})
