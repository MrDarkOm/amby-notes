// @vitest-environment happy-dom

// EDIT-01: Markdown has no line break inside an ATX heading or a GFM table cell, and a cell holds one
// line of inline text. The editor used to let both be typed; the saved file then read back as something
// else (`# Title\` plus a separate paragraph; a cell's lines merged, or a literal `\ `).

import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"

import { MarkdownLineBreaks } from "./markdown-line-breaks"
import { docToMarkdown, editorSchema, markdownToDoc } from "./markdown"
import { schemaExtensions } from "./schema"

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function mount(markdown: string): Editor {
  editor = new Editor({
    extensions: [...schemaExtensions, MarkdownLineBreaks],
    content: markdownToDoc(markdown),
  })
  return editor
}

function caretAfter(target: Editor, text: string) {
  let at = -1
  target.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(text)) {
      at = pos + node.text.indexOf(text) + text.length
    }
  })
  expect(at).toBeGreaterThan(0)
  target.view.dispatch(target.state.tr.setSelection(TextSelection.create(target.state.doc, at)))
}

/** `Mod` is Ctrl here: the test DOM does not report a Mac. */
function press(target: Editor, key: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers })
  return Boolean(target.view.someProp("handleKeyDown", (handler) => handler(target.view, event)))
}

const TABLE = "| A | B |\n| --- | --- |\n| one | two |\n"

describe("a line break where Markdown has none", () => {
  it("Shift-Enter and Mod-Enter in a heading add no line break", () => {
    const target = mount("# Title more\n")
    caretAfter(target, "Title")
    press(target, "Enter", { shiftKey: true })
    press(target, "Enter", { ctrlKey: true })
    expect(docToMarkdown(target.state.doc)).toBe("# Title more")
  })

  it("Shift-Enter in a paragraph still adds a line break", () => {
    const target = mount("one two\n")
    caretAfter(target, "one")
    press(target, "Enter", { shiftKey: true })
    let breaks = 0
    target.state.doc.descendants((node) => {
      if (node.type.name === "hardBreak") breaks += 1
    })
    expect(breaks).toBe(1)
  })

  it("Enter and Shift-Enter in a table cell change nothing in the file", () => {
    const target = mount(TABLE)
    const before = docToMarkdown(target.state.doc)
    caretAfter(target, "one")
    press(target, "Enter")
    press(target, "Enter", { shiftKey: true })
    expect(docToMarkdown(target.state.doc)).toBe(before)
  })
})

describe("what a table cell holds", () => {
  it("is one paragraph of inline text, like a GFM cell", () => {
    expect(editorSchema.nodes.tableCell.spec.content).toBe("paragraph")
    expect(editorSchema.nodes.tableHeader.spec.content).toBe("paragraph")
  })

  it("reads an ordinary table back the same", () => {
    const target = mount(TABLE)
    expect(docToMarkdown(target.state.doc)).toBe(TABLE.trimEnd())
  })
})
