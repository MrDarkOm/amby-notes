// @vitest-environment happy-dom

// EDIT-01 tail: what is pasted into a table cell. A GFM cell is one line of inline text, so
// pasted paragraphs, lists, headings and code become the text of the one paragraph, joined with
// a space (a cell has no `<br>` here), and the saved table stays a table that reads back the same.

import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"

import { docToMarkdown, editorSchema, markdownToDoc } from "./markdown"
import { MarkdownPaste } from "./markdown-paste"
import { schemaExtensions } from "./schema"
import { sameDocument } from "./markdown-block-source"

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

const TABLE = [
  "| A | B | C |",
  "| --- | --- | --- |",
  "| a1 | b1 | c1 |",
  "| a2 | b2 | c2 |",
  "| a3 | b3 | c3 |",
  "",
].join("\n")

function mount(): Editor {
  editor = new Editor({
    extensions: [...schemaExtensions, MarkdownPaste],
    content: markdownToDoc(TABLE),
  })
  return editor
}

function caretIn(target: Editor, cellText: string) {
  let at = -1
  target.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text === cellText) at = pos + node.text.length
  })
  expect(at).toBeGreaterThan(0)
  target.view.dispatch(target.state.tr.setSelection(TextSelection.create(target.state.doc, at)))
}

/** A paste as the browser delivers it: the clipboard has text and/or html. */
function paste(target: Editor, data: { text?: string; html?: string }) {
  const types = [data.text ? "text/plain" : "", data.html ? "text/html" : ""].filter(Boolean)
  const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
    clipboardData: unknown
  }
  event.clipboardData = {
    types,
    files: [],
    items: [],
    getData: (type: string) =>
      (type === "text/plain" ? data.text : type === "text/html" ? data.html : "") ?? "",
  }
  target.view.dom.dispatchEvent(event)
}

/** The table's cells as text: every cell must be exactly one paragraph. */
function cells(target: Editor): string[][] {
  const rows: string[][] = []
  target.state.doc.descendants((node) => {
    if (node.type.name !== "tableRow") return true
    const row: string[] = []
    node.forEach((cell) => {
      expect(cell.childCount).toBe(1)
      expect(cell.firstChild?.type.name).toBe("paragraph")
      row.push(cell.textContent)
    })
    rows.push(row)
    return false
  })
  return rows
}

function expectValidTable(target: Editor): string {
  const markdown = docToMarkdown(target.state.doc)
  // Every line is a row with the same number of unescaped pipes: nothing broke a row.
  const lines = markdown.trim().split("\n")
  expect(lines).toHaveLength(5)
  for (const line of lines) {
    expect(line.replace(/\\\|/gu, "").split("|").length - 1).toBe(4)
  }
  // And the saved table reads back as the same document.
  const again = editorSchema.nodeFromJSON(markdownToDoc(markdown))
  expect(sameDocument(again, target.state.doc)).toBe(true)
  expect(docToMarkdown(again).trimEnd()).toBe(markdown.trimEnd())
  return markdown
}

describe("pasting into a table cell", () => {
  it("plain text with blank lines becomes one paragraph", () => {
    const target = mount()
    caretIn(target, "b2")
    paste(target, { text: "first\n\nsecond\nthird" })
    expect(cells(target)[2][1]).toBe("b2first second third")
    expect(expectValidTable(target)).toContain("| b2first second third |")
  })

  it("html paragraphs are joined with a space", () => {
    const target = mount()
    caretIn(target, "b2")
    paste(target, { html: "<p>one</p><p>two</p>", text: "one\n\ntwo" })
    expect(cells(target)[2][1]).toBe("b2one two")
    expectValidTable(target)
  })

  it("a bullet list loses its structure, not its items", () => {
    const target = mount()
    caretIn(target, "b2")
    paste(target, { html: "<ul><li>x</li><li>y</li></ul>", text: "x\ny" })
    expect(cells(target)[2][1]).toBe("b2x y")
    expectValidTable(target)
  })

  it("a bullet list written as Markdown does the same", () => {
    const target = mount()
    caretIn(target, "b2")
    paste(target, { text: "- x\n- y\n- z" })
    expect(cells(target)[2][1]).toBe("b2x y z")
    expectValidTable(target)
  })

  it("a heading becomes text", () => {
    const target = mount()
    caretIn(target, "b2")
    paste(target, { html: "<h2>Title</h2><p>body</p>", text: "Title\nbody" })
    expect(cells(target)[2][1]).toBe("b2Title body")
    expectValidTable(target)
  })

  it("a Markdown heading and a fenced code block become text and inline code", () => {
    const target = mount()
    caretIn(target, "b2")
    paste(target, { text: "# Title\n\n```\nlet a = 1\nlet b = 2\n```" })
    const row = cells(target)[2]
    expect(row[1]).toBe("b2Title let a = 1 let b = 2")
    const markdown = expectValidTable(target)
    expect(markdown).toContain("`let a = 1 let b = 2`")
  })

  it("a code block copied as html becomes inline code", () => {
    const target = mount()
    caretIn(target, "b2")
    paste(target, { html: "<pre><code>a\nb</code></pre>", text: "a\nb" })
    expect(cells(target)[2][1]).toBe("b2a b")
    expect(expectValidTable(target)).toContain("`a b`")
  })

  it("text with a pipe keeps it, escaped", () => {
    const target = mount()
    caretIn(target, "b2")
    paste(target, { text: "x | y\n\nz" })
    expect(cells(target)[2][1]).toBe("b2x | y z")
    expect(expectValidTable(target)).toContain("x \\| y z")
  })

  it("inline marks survive", () => {
    const target = mount()
    caretIn(target, "b2")
    paste(target, { html: "<p><b>bold</b> and</p><p><i>it</i></p>", text: "bold and\n\nit" })
    expect(cells(target)[2][1]).toBe("b2bold and it")
    const markdown = expectValidTable(target)
    expect(markdown).toContain("**bold**")
    expect(markdown).toMatch(/(\*it\*|_it_)/u)
  })

  it("a line break in rich text becomes a space, not a stray backslash", () => {
    const target = mount()
    caretIn(target, "b2")
    paste(target, { html: "<p>one<br>two</p>", text: "one\ntwo" })
    expect(cells(target)[2][1]).toBe("b2one two")
    expect(expectValidTable(target)).not.toContain("\\")
  })

  it("an html table pasted into a cell keeps the table valid", () => {
    const target = mount()
    caretIn(target, "b2")
    paste(target, {
      html: "<table><tr><td>p</td><td>q</td></tr></table>",
      text: "p\tq",
    })
    cells(target)
    expectValidTable(target)
  })

  it("the other cells are untouched", () => {
    const target = mount()
    caretIn(target, "b2")
    paste(target, { text: "p\n\nq" })
    const rows = cells(target)
    expect(rows[1]).toEqual(["a1", "b1", "c1"])
    expect(rows[2][0]).toBe("a2")
    expect(rows[2][2]).toBe("c2")
    expect(rows[3]).toEqual(["a3", "b3", "c3"])
  })

  it("outside a table blocks are still blocks", () => {
    editor = new Editor({
      extensions: [...schemaExtensions, MarkdownPaste],
      content: markdownToDoc("start\n"),
    })
    caretIn(editor, "start")
    paste(editor, { html: "<p>one</p><p>two</p>", text: "one\n\ntwo" })
    expect(docToMarkdown(editor.state.doc)).toBe("startone\n\ntwo")
  })
})
