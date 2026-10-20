// @vitest-environment happy-dom
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { afterEach, describe, expect, it } from "vitest"

import { imageLineDecorations, typeOffImageLine } from "./image-line"
import { schemaExtensions } from "./schema"

const image = { type: "image", attrs: { src: "a.png" } }
const text = (value: string) => ({ type: "text", text: value })
const line = (...content: unknown[]) => ({ type: "paragraph", content })

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

function open(content: unknown[], cursor: number) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: schemaExtensions,
    content: { type: "doc", content: content as never },
  })
  editors.push(editor)
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, cursor)))
  return editor
}

const lines = (editor: Editor) =>
  editor.state.doc.children.map((node) =>
    node.content.content.map((child) => (child.isText ? child.text : child.type.name)).join("|"),
  )

describe("typing beside an image alone on its line", () => {
  it("writes after the image on a new line below", () => {
    const editor = open([line(image)], 2)
    editor.view.dispatch(typeOffImageLine(editor.state, "x")!)
    expect(lines(editor)).toEqual(["image", "x"])
    expect(editor.state.selection.$from.parent.textContent).toBe("x")
  })

  it("writes before the image on a new line above", () => {
    const editor = open([line(image)], 1)
    editor.view.dispatch(typeOffImageLine(editor.state, "x")!)
    expect(lines(editor)).toEqual(["x", "image"])
  })

  it("leaves an image that shares its line with text alone", () => {
    const editor = open([line(text("a"), image)], 3)
    expect(typeOffImageLine(editor.state, "x")).toBeNull()
  })

  it("leaves ordinary lines alone", () => {
    const editor = open([line(text("ab"))], 2)
    expect(typeOffImageLine(editor.state, "x")).toBeNull()
  })
})

describe("image lines", () => {
  it("are marked, also inside columns, and lines with text are not", () => {
    const columns = {
      type: "columnSet",
      content: [
        { type: "column", content: [line(image), line(text("a"))] },
        { type: "column", content: [line(text("b"), image)] },
      ],
    }
    const editor = open([line(image), columns], 1)
    const marked = imageLineDecorations(editor.state.doc)
      .find()
      .map((decoration) => editor.state.doc.nodeAt(decoration.from)?.firstChild?.type.name)
    expect(marked).toEqual(["image", "image"])
  })
})
