// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"

import { docToMarkdown, markdownToDoc } from "./markdown"
import { schemaExtensions } from "./schema"
import { TableAlignment } from "./table-alignment"
import { alignColumn } from "./table-commands"

const NOTE = ["Before", "", "|Name|Age|City|", "|:-|-:|-|", "|Ann|30|Oslo|", "", "After"].join("\n")

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function mount(markdown: string): Editor {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [...schemaExtensions, TableAlignment],
    content: markdownToDoc(markdown),
  })
  return editor
}

const drawn = (target: Editor) =>
  [...target.view.dom.querySelectorAll("th, td")].map(
    (cell) => /amby-cell-(\w+)/u.exec(cell.className)?.[1] ?? "none",
  )

describe("table alignment in the editor", () => {
  it("draws every cell as the delimiter row says and writes nothing", () => {
    const target = mount(NOTE)
    expect(drawn(target)).toEqual(["left", "right", "none", "left", "right", "none"])
    expect(docToMarkdown(target.state.doc)).toBe(NOTE)
  })

  it("keeps no alignment on the cells themselves, also for a pasted HTML table", () => {
    const target = mount(NOTE)
    target.commands.setContent(
      '<table><tr><th style="text-align: center">a</th></tr><tr><td align="right">1</td></tr></table>',
    )
    let cells = 0
    target.state.doc.descendants((node) => {
      if (node.type.name !== "tableCell" && node.type.name !== "tableHeader") return
      cells++
      expect(node.attrs.align).toBeNull()
    })
    expect(cells).toBe(2)
    expect(target.view.dom.querySelectorAll("[style*=text-align]")).toHaveLength(0)
    expect(drawn(target)).toEqual(["none", "none"])
    expect(docToMarkdown(target.state.doc).trimEnd()).toBe("| a |\n| --- |\n| 1 |")
  })

  it("follows the delimiter row when the column is aligned", () => {
    const target = mount(NOTE)
    let at = -1
    target.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "Oslo") at = pos
    })
    target.commands.setTextSelection(at)
    alignColumn("center")(target.state, target.view.dispatch)
    expect(drawn(target)).toEqual(["left", "right", "center", "left", "right", "center"])
    alignColumn("none")(target.state, target.view.dispatch)
    expect(drawn(target)).toEqual(["left", "right", "none", "left", "right", "none"])
  })

  it("draws a table inside a column too", () => {
    const target = mount(
      [
        "<!-- amby:columns -->",
        "<!-- amby:column -->",
        "",
        "| a | b |",
        "| :-: | -: |",
        "| 1 | 2 |",
        "",
        "<!-- amby:column -->",
        "",
        "Text",
        "",
        "<!-- /amby:columns -->",
      ].join("\n"),
    )
    expect(target.state.doc.firstChild?.type.name).toBe("columnSet")
    expect(drawn(target)).toEqual(["center", "right", "center", "right"])
  })
})
