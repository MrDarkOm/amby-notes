import { Extension } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

import { splitInlineMath } from "./markdown-math"
import { renderMath } from "./rendered-source"
import { changedTextRanges } from "./tags-wikilinks"

// Inline formulas (`$E = mc^2$`) are drawn over their text, like wikilinks: the text
// stays in the note exactly as it is written, a drawing is shown in its place, and the
// text comes back as soon as the cursor touches it.

export interface InlineMath {
  from: number
  to: number
  tex: string
}

/** The inline formulas of the text nodes between two positions. Code is left alone. */
export function findInlineMath(doc: PMNode, from: number, to: number): InlineMath[] {
  const found: InlineMath[] = []
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (parent?.type.spec.code) return false
    if (!node.isText || !node.text) return
    if (node.marks.some((mark) => mark.type.spec.code)) return
    for (const part of splitInlineMath(node.text)) {
      if (!part.math) continue
      const start = pos + part.at
      found.push({ from: start, to: start + part.text.length, tex: part.tex ?? "" })
    }
  })
  return found
}

const inlineMathKey = new PluginKey<DecorationSet>("ambyInlineMath")

function decorate(doc: PMNode, from: number, to: number): Decoration[] {
  return findInlineMath(doc, from, to).flatMap((math) => [
    Decoration.inline(math.from, math.to, { class: "amby-math-source" }),
    Decoration.widget(
      math.from,
      (view, getPos) => {
        const drawing = document.createElement("span")
        drawing.className = "amby-math-inline"
        drawing.contentEditable = "false"
        // Until the formula is drawn its text is shown, so nothing ever disappears.
        drawing.textContent = `$${math.tex}$`
        void renderMath(math.tex, drawing, false)
        // A click puts the cursor into the text of the formula, which reveals it.
        drawing.addEventListener("mousedown", (event) => {
          const at = getPos()
          if (typeof at !== "number" || !view.editable) return
          event.preventDefault()
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at + 1)))
          view.focus()
        })
        return drawing
      },
      { side: -1, key: `math:${math.tex}` },
    ),
  ])
}

export const InlineMathView = Extension.create({
  name: "inlineMathView",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: inlineMathKey,
        state: {
          init: (_config, state) =>
            DecorationSet.create(state.doc, decorate(state.doc, 0, state.doc.content.size)),
          apply(tr, decorations) {
            if (!tr.docChanged) return decorations
            let next = decorations.map(tr.mapping, tr.doc)
            for (const range of changedTextRanges(tr)) {
              const stale = next.find(range.from, range.to)
              if (stale.length > 0) next = next.remove(stale)
              const fresh = decorate(tr.doc, range.from, range.to)
              if (fresh.length > 0) next = next.add(tr.doc, fresh)
            }
            return next
          },
        },
        props: {
          decorations(state) {
            const all = inlineMathKey.getState(state)
            if (!all) return null
            // The formula the selection touches is shown as its text, ready to be edited.
            const { from, to } = state.selection
            let shown = all
            for (const mark of all.find(from, to)) {
              // The drawing sits at the start of the formula's text: both go together.
              if (mark.from !== mark.to) shown = shown.remove(shown.find(mark.from, mark.to))
            }
            return shown
          },
        },
      }),
    ]
  },
})
