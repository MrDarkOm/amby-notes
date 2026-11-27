import { EditorState, TextSelection } from "@tiptap/pm/state"
import { describe, expect, it } from "vitest"

import {
  createColumnsFromDrop,
  moveBlockAcrossColumns,
  removeEmptyColumnAtSelection,
  removeSoleBlockColumn,
} from "./columns-transaction"
import { docToMarkdown, editorSchema, markdownToDoc, roundTripCheck } from "./markdown"

describe("Markdown columns", () => {
  it("round-trips editable Markdown content inside columns", () => {
    const markdown =
      "<!-- amby:columns -->\n\n<!-- amby:column -->\n\nFirst **bold**\n\n<!-- amby:column -->\n\nSecond\n\n<!-- /amby:columns -->"
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
    const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
    expect(doc.firstChild?.type.name).toBe("columnSet")
    expect(doc.firstChild?.childCount).toBe(2)
  })

  it("round-trips persisted column width proportions", () => {
    const markdown =
      '<!-- amby:columns widths="0.3500,0.6500" -->\n\n<!-- amby:column -->\n\nNarrow\n\n<!-- amby:column -->\n\nWide\n\n<!-- /amby:columns -->'
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
    const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
    expect(doc.firstChild?.attrs.widths).toBe("0.3500,0.6500")
  })

  it("creates two columns by dropping a block on the right side of another", () => {
    const doc = editorSchema.nodeFromJSON(markdownToDoc("First\n\nSecond"))
    const state = EditorState.create({ schema: editorSchema, doc })
    const secondPos = doc.firstChild!.nodeSize
    const tr = createColumnsFromDrop(state, secondPos, 0, "right")
    expect(tr).not.toBeNull()
    expect(tr!.doc.firstChild?.type.name).toBe("columnSet")
    expect(tr!.doc.firstChild?.childCount).toBe(2)
    expect(docToMarkdown(tr!.doc)).toContain("<!-- amby:columns -->")
  })

  it("adds another top-level block as a third column", () => {
    const markdown =
      "<!-- amby:columns -->\n\n<!-- amby:column -->\n\nFirst\n\n<!-- amby:column -->\n\nSecond\n\n<!-- /amby:columns -->\n\nThird"
    const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
    const state = EditorState.create({ schema: editorSchema, doc })
    const sourcePos = doc.firstChild!.nodeSize
    const firstColumnBlockPos = 2
    const tr = createColumnsFromDrop(state, sourcePos, firstColumnBlockPos, "right")
    expect(tr).not.toBeNull()
    expect(tr!.doc.firstChild?.childCount).toBe(3)
    expect(roundTripCheck(docToMarkdown(tr!.doc)).ok).toBe(true)
  })

  it("reorders existing columns with a side drop", () => {
    const markdown =
      "<!-- amby:columns -->\n\n<!-- amby:column -->\n\nFirst\n\n<!-- amby:column -->\n\nSecond\n\n<!-- /amby:columns -->"
    const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
    const set = doc.firstChild!
    const firstBlockPos = 2
    const secondBlockPos = 1 + set.child(0).nodeSize + 1
    const state = EditorState.create({ schema: editorSchema, doc })
    const tr = createColumnsFromDrop(state, secondBlockPos, firstBlockPos, "left")
    expect(tr).not.toBeNull()
    expect(tr!.doc.firstChild?.child(0).textContent).toBe("Second")
    expect(tr!.doc.firstChild?.child(1).textContent).toBe("First")
  })

  it("moves an ordinary block between column containers", () => {
    const markdown =
      "<!-- amby:columns -->\n\n<!-- amby:column -->\n\nFirst\n\n<!-- amby:column -->\n\nSecond\n\n<!-- /amby:columns -->"
    const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
    const set = doc.firstChild!
    const firstBlockPos = 2
    const secondBlockPos = 1 + set.child(0).nodeSize + 1
    const state = EditorState.create({ schema: editorSchema, doc })
    const tr = moveBlockAcrossColumns(state, firstBlockPos, secondBlockPos, false)
    expect(tr).not.toBeNull()
    expect(tr!.doc.firstChild?.type.name).toBe("paragraph")
    expect(tr!.doc.childCount).toBe(2)
    expect(tr!.doc.textContent).toBe("SecondFirst")
    expect(docToMarkdown(tr!.doc)).not.toContain("amby:columns")
  })

  it.each([true, false])(
    "removes the emptied column when moving its last block outside (before=%s)",
    (before) => {
      const markdown =
        "<!-- amby:columns -->\n\n<!-- amby:column -->\n\nKeep\n\n<!-- amby:column -->\n\nMove\n\n<!-- /amby:columns -->\n\nOutside"
      const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
      const set = doc.firstChild!
      const state = EditorState.create({ schema: editorSchema, doc })
      const tr = moveBlockAcrossColumns(state, set.child(0).nodeSize + 2, set.nodeSize, before)!
      expect(tr.doc.childCount).toBe(3)
      expect(
        Array.from({ length: tr.doc.childCount }, (_, index) => tr.doc.child(index).textContent),
      ).toEqual(before ? ["Keep", "Move", "Outside"] : ["Keep", "Outside", "Move"])
      expect(docToMarkdown(tr.doc)).not.toContain("amby:columns")
      expect(roundTripCheck(docToMarkdown(tr.doc)).ok).toBe(true)
    },
  )

  it("keeps the other columns and their width proportions when moving out of three columns", () => {
    const markdown =
      '<!-- amby:columns widths="0.2000,0.3000,0.5000" -->\n\n<!-- amby:column -->\n\nFirst\n\n<!-- amby:column -->\n\nSecond\n\n<!-- amby:column -->\n\nThird\n\n<!-- /amby:columns -->\n\nOutside'
    const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
    const set = doc.firstChild!
    const state = EditorState.create({ schema: editorSchema, doc })
    const tr = moveBlockAcrossColumns(state, set.child(0).nodeSize + 2, set.nodeSize, false)!
    expect(tr.doc.firstChild?.childCount).toBe(2)
    expect(tr.doc.firstChild?.attrs.widths).toBe("0.2857,0.7143")
    expect(tr.doc.firstChild?.textContent).toBe("FirstThird")
    expect(tr.doc.lastChild?.textContent).toBe("Second")
    expect(roundTripCheck(docToMarkdown(tr.doc)).ok).toBe(true)
  })

  it("does not move an entire multi-block column through a block side-drop", () => {
    const markdown =
      "<!-- amby:columns -->\n\n<!-- amby:column -->\n\nFirst\n\nExtra\n\n<!-- amby:column -->\n\nSecond\n\n<!-- /amby:columns -->"
    const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
    const set = doc.firstChild!
    const firstBlockPos = 2
    const secondColumnBlockPos = 1 + set.child(0).nodeSize + 1
    const state = EditorState.create({ schema: editorSchema, doc })
    expect(createColumnsFromDrop(state, firstBlockPos, secondColumnBlockPos, "right")).toBeNull()
    expect(moveBlockAcrossColumns(state, firstBlockPos, secondColumnBlockPos, false)).not.toBeNull()
  })

  it("removes an empty column and dissolves a two-column layout", () => {
    const markdown =
      "<!-- amby:columns -->\n\n<!-- amby:column -->\n\nKeep\n\n<!-- amby:column -->\n\n\n\n<!-- /amby:columns -->"
    const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
    const emptyParagraphPos = 1 + doc.firstChild!.child(0).nodeSize + 1
    const state = EditorState.create({
      schema: editorSchema,
      doc,
      selection: TextSelection.create(doc, emptyParagraphPos + 1),
    })
    const tr = removeEmptyColumnAtSelection(state)
    expect(tr).not.toBeNull()
    expect(tr!.doc.firstChild?.type.name).toBe("paragraph")
    expect(tr!.doc.textContent).toBe("Keep")
  })

  it("removes the explicitly deleted sole block and renormalizes three columns", () => {
    const markdown =
      '<!-- amby:columns widths="0.2000,0.3000,0.5000" -->\n\n<!-- amby:column -->\n\nFirst\n\n<!-- amby:column -->\n\nSecond\n\n<!-- amby:column -->\n\nThird\n\n<!-- /amby:columns -->'
    const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
    const set = doc.firstChild!
    const secondBlockPos = 1 + set.child(0).nodeSize + 1
    const state = EditorState.create({ schema: editorSchema, doc })
    const tr = removeSoleBlockColumn(state, secondBlockPos)
    expect(tr).not.toBeNull()
    expect(tr!.doc.firstChild?.childCount).toBe(2)
    expect(tr!.doc.firstChild?.attrs.widths).toBe("0.2857,0.7143")
    expect(tr!.doc.textContent).toBe("FirstThird")
  })
})
