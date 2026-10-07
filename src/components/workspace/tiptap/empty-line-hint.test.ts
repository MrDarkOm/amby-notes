// @vitest-environment happy-dom
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { afterEach, describe, expect, it } from "vitest"
import "@/lib/i18n"

import { buildExtensions } from "./extensions"

const text = (value: string) => ({ type: "paragraph", content: [{ type: "text", text: value }] })
const content = {
  type: "doc",
  content: [
    {
      type: "columnSet",
      content: [
        { type: "column", content: [text("L")] },
        { type: "column", content: [text("R"), { type: "paragraph" }] },
      ],
    },
    { type: "paragraph" },
  ],
}

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

function open() {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: buildExtensions({ placeholder: "Start", callbacks: { current: {} as never } }),
    content,
  })
  editors.push(editor)
  return editor
}

function emptyLinePositions(editor: Editor) {
  const found: number[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" && node.content.size === 0) found.push(pos + 1)
  })
  return found
}

const hints = (editor: Editor) => editor.view.dom.querySelectorAll("[data-placeholder]").length

describe("empty line hint", () => {
  it("shows one hint, on the line in a column, and none left on the line below", () => {
    const editor = open()
    const [inColumn, bottom] = emptyLinePositions(editor)
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, bottom)),
    )
    expect(hints(editor)).toBe(1)
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, inColumn)),
    )
    expect(hints(editor)).toBe(1)
    expect(editor.view.dom.querySelector("[data-placeholder]")?.parentElement?.className).toBe(
      "amby-column-content",
    )
  })

  it("shows no hint while the cursor is on a line with text", () => {
    const editor = open()
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 4)))
    expect(hints(editor)).toBe(0)
  })
})
