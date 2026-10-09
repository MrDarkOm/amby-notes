import { Extension } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

import { columnAlignments } from "./table-commands"

// The alignment of a table column is drawn from the table's delimiter row, the one
// place it is written (`markdownSeparator`). Nothing is stored on the cells, so what is
// shown cannot differ from what the file says.

const key = new PluginKey<DecorationSet>("ambyTableAlignment")

function alignmentDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== "table") return !node.isTextblock
    const aligned = columnAlignments(node)
    node.forEach((row, rowOffset) => {
      row.forEach((cell, cellOffset, column) => {
        const alignment = aligned[column]
        if (!alignment || alignment === "none") return
        const from = pos + 1 + rowOffset + 1 + cellOffset
        decorations.push(
          Decoration.node(from, from + cell.nodeSize, { class: `amby-cell-${alignment}` }),
        )
      })
    })
    return false
  })
  return DecorationSet.create(doc, decorations)
}

export const TableAlignment = Extension.create({
  name: "tableAlignment",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => alignmentDecorations(state.doc),
          apply: (tr, shown) => (tr.docChanged ? alignmentDecorations(tr.doc) : shown),
        },
        props: {
          decorations: (state) => key.getState(state),
        },
      }),
    ]
  },
})
