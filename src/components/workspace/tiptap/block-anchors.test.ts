// @vitest-environment happy-dom
import { Editor } from "@tiptap/core"
import { afterEach, describe, expect, it } from "vitest"
import { BlockAnchors, blockAnchorSuffix } from "./block-anchors"
import { schemaExtensions } from "./schema"
import { docToMarkdown, markdownToDoc, restoreSourceFormatting } from "./markdown"
import { imageLineDecorations } from "./image-line"

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

function open(markdown: string) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...schemaExtensions, BlockAnchors],
    content: markdownToDoc(markdown),
  })
  editors.push(editor)
  return editor
}

describe("block link markers", () => {
  it("hides an ID without changing its Markdown or losing the navigation target", () => {
    const source = "Text ^amby-example\n"
    const editor = open(source)
    expect(editor.view.dom.querySelector("[data-block-id='amby-example']")).not.toBeNull()
    expect(editor.view.dom.querySelector(".amby-block-anchor-marker")?.textContent).toBe(
      " ^amby-example",
    )
    expect(restoreSourceFormatting(docToMarkdown(editor.state.doc), source)).toBe(source)
  })

  it("keeps an image line marked as an image line after adding a block link", () => {
    const editor = open("![](picture.png) ^amby-example\n")
    expect(imageLineDecorations(editor.state.doc).find()).toHaveLength(1)
    expect(blockAnchorSuffix(editor.state.doc.firstChild!)?.offset).toBe(1)
  })

  it("leaves literal IDs in code alone", () => {
    const editor = open("```text\nvalue ^amby-example\n```\n")
    expect(editor.view.dom.querySelector(".amby-block-anchor-marker")).toBeNull()
  })

  it("types before the marker when End would put the cursor inside it", () => {
    const editor = open("Text ^amby-example\n")
    editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize - 1)
    expect(editor.state.selection.from).toBe(5)
    editor.commands.insertContent("!")
    expect(docToMarkdown(editor.state.doc).trimEnd()).toBe("Text! ^amby-example")
  })
})
