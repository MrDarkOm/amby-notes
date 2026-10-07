// @vitest-environment happy-dom
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { afterEach, describe, expect, it } from "vitest"

import { removeEmptyLineAfterAtom, selectEndOfNote } from "./line-after-block"
import { schemaExtensions } from "./schema"

const block = { type: "ambyBlock", attrs: { blockType: "db", blockId: "{}" } }
const columns = {
  type: "columnSet",
  content: [
    { type: "column", content: [{ type: "paragraph", content: [{ type: "text", text: "L" }] }] },
    { type: "column", content: [{ type: "paragraph", content: [{ type: "text", text: "R" }] }] },
  ],
}
const line = (text?: string) =>
  text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" }

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

function open(content: unknown[], cursorLine?: number) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: schemaExtensions,
    content: { type: "doc", content: content as never },
  })
  editors.push(editor)
  if (cursorLine !== undefined) {
    let pos = 0
    editor.state.doc.forEach((_node, offset, index) => {
      if (index === cursorLine) pos = offset + 1
    })
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)))
  }
  return editor
}

const kinds = (editor: Editor) => editor.state.doc.children.map((node) => node.type.name)

describe("line after a block without text", () => {
  it("does not force an empty line after a block that ends the note", () => {
    const editor = open([line("a"), block])
    editor.view.dispatch(editor.state.tr.insertText("x", 2))
    expect(kinds(editor)).toEqual(["paragraph", "ambyBlock"])
  })

  it("deletes the last empty line and keeps it deleted", () => {
    const editor = open([line("a"), block, line()], 2)
    const tr = removeEmptyLineAfterAtom(editor.state)
    expect(tr).not.toBeNull()
    editor.view.dispatch(tr!)
    expect(kinds(editor)).toEqual(["paragraph", "ambyBlock"])
  })

  it("moves the cursor to the next text when the line was in the middle", () => {
    const editor = open([line("a"), block, line(), line("b")], 2)
    editor.view.dispatch(removeEmptyLineAfterAtom(editor.state)!)
    expect(kinds(editor)).toEqual(["paragraph", "ambyBlock", "paragraph"])
    expect(editor.state.selection instanceof TextSelection).toBe(true)
    expect(editor.state.selection.$from.parent.textContent).toBe("b")
  })

  it("leaves other empty lines to the default Backspace", () => {
    expect(removeEmptyLineAfterAtom(open([line("a"), line(), line("b")], 1).state)).toBeNull()
  })

  it("a click below a block that ends the note adds a line to write on", () => {
    const editor = open([line("a"), block])
    editor.view.dispatch(selectEndOfNote(editor.state))
    expect(kinds(editor)).toEqual(["paragraph", "ambyBlock", "paragraph"])
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph")
    expect(editor.state.selection.$from.index(0)).toBe(2)
  })

  it("a click below columns that end the note adds a line under both of them", () => {
    const editor = open([line("a"), columns])
    editor.view.dispatch(selectEndOfNote(editor.state))
    expect(kinds(editor)).toEqual(["paragraph", "columnSet", "paragraph"])
    expect(editor.state.selection.$from.depth).toBe(1)
  })

  it("Backspace on the empty line under columns deletes it", () => {
    const editor = open([line("a"), columns, line()], 2)
    editor.view.dispatch(removeEmptyLineAfterAtom(editor.state)!)
    expect(kinds(editor)).toEqual(["paragraph", "columnSet"])
  })

  it("a click below a last line with text adds an empty line to write on", () => {
    const editor = open([line("a"), block, line("tail")], 0)
    editor.view.dispatch(selectEndOfNote(editor.state))
    expect(kinds(editor)).toEqual(["paragraph", "ambyBlock", "paragraph", "paragraph"])
    expect(editor.state.selection.$from.parent.textContent).toBe("")
    expect(editor.state.selection.$from.index(0)).toBe(3)
  })

  it("a click below an empty last line keeps just that line", () => {
    const editor = open([line("a"), line()])
    editor.view.dispatch(selectEndOfNote(editor.state))
    expect(kinds(editor)).toEqual(["paragraph", "paragraph"])
  })

  it("Enter on a selected block opens a line after it", () => {
    const editor = open([line("a"), block])
    editor.commands.setNodeSelection(editor.state.doc.firstChild!.nodeSize)
    editor.commands.createParagraphNear()
    expect(kinds(editor)).toEqual(["paragraph", "ambyBlock", "paragraph"])
  })
})
