import { Extension } from "@tiptap/core"
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"

/**
 * A line that holds only images (or attachments drawn from an image node). The
 * images are inline nodes, so the cursor can stand beside them; text typed or pasted
 * there goes to a new line instead: above when the cursor is before the first image,
 * below otherwise. The cursor is not drawn on such a line, the pointer is an arrow,
 * and a click beside the images does nothing (a click on an image selects it). Images that share a line with
 * text are left alone.
 */

function isImageLine(node: {
  type: { name: string }
  childCount: number
  forEach: (fn: (child: { type: { name: string } }) => void) => void
}): boolean {
  if (node.type.name !== "paragraph" || node.childCount === 0) return false
  let onlyImages = true
  node.forEach((child) => {
    if (child.type.name !== "image") onlyImages = false
  })
  return onlyImages
}

/** Whether a document position is inside a line that holds only images. */
export function isImageLinePos(state: EditorState, pos: number): boolean {
  return isImageLine(state.doc.resolve(pos).parent)
}

/** Whether a press landed on an image line itself, beside its images rather than on one. */
export function isPressBesideImages(view: EditorView, target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement) || !view.dom.contains(target) || target === view.dom) {
    return false
  }
  try {
    const $pos = view.state.doc.resolve(view.posAtDOM(target, 0))
    return $pos.depth > 0 && isImageLine($pos.parent) && view.nodeDOM($pos.before()) === target
  } catch {
    return false
  }
}

/** Adds an empty line next to the image line the cursor is on and moves the cursor into it. */
export function moveOffImageLine(state: EditorState): Transaction | null {
  const { selection, schema } = state
  if (!selection.empty) return null
  const { $from } = selection
  if (!isImageLine($from.parent)) return null
  const before = $from.parentOffset === 0
  const pos = before ? $from.before() : $from.after()
  const tr = state.tr.insert(pos, schema.nodes.paragraph.create())
  return tr.setSelection(TextSelection.create(tr.doc, pos + 1))
}

/**
 * Every image line, marked so that neither the text cursor nor the text pointer is
 * shown beside its images. Blocks are walked without their inline content.
 */
export function imageLineDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (isImageLine(node)) {
        decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "amby-image-line" }))
      }
      return false
    }
    return node.isBlock
  })
  return DecorationSet.create(doc, decorations)
}

/** Text typed beside an image that stands alone on its line, written on a new line. */
export function typeOffImageLine(state: EditorState, text: string): Transaction | null {
  const tr = moveOffImageLine(state)
  if (!tr) return null
  return tr.insertText(text).scrollIntoView()
}

const imageLineKey = new PluginKey<DecorationSet>("imageLine")

export const ImageLine = Extension.create({
  name: "imageLine",
  // Ahead of input rules, footnote typing and the paste handlers, which then work
  // on the new line.
  priority: 300,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: imageLineKey,
        state: {
          init: (_config, state) => imageLineDecorations(state.doc),
          apply: (tr, set) => (tr.docChanged ? imageLineDecorations(tr.doc) : set),
        },
        props: {
          decorations: (state) => imageLineKey.getState(state),
          handleDOMEvents: {
            mousedown(view, event) {
              if (event.button !== 0 || !isPressBesideImages(view, event.target)) return false
              event.preventDefault()
              return true
            },
          },
          handleTextInput(view, from, to, text) {
            if (from !== to) return false
            const tr = typeOffImageLine(view.state, text)
            if (!tr) return false
            view.dispatch(tr)
            return true
          },
          handlePaste(view) {
            const tr = moveOffImageLine(view.state)
            if (tr) view.dispatch(tr)
            // The paste itself goes on through the other handlers, now on the new line.
            return false
          },
        },
      }),
    ]
  },
})
