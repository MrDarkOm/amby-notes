// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"

import { docToMarkdown, markdownToDoc, roundTripCheck } from "./markdown"
import { schemaExtensions } from "./schema"

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function mount(markdown: string): Editor {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: schemaExtensions,
    content: markdownToDoc(markdown),
  })
  return editor
}

const NOTE = "Intro\n\n```js\nconst answer = 42\n```\n\n~~~\nplain\n~~~\n\nOutro"

describe("the code block", () => {
  it("is the same node with the same Markdown as before", () => {
    const target = mount(NOTE)
    const block = target.state.doc.child(1)
    expect(block.type.name).toBe("codeBlock")
    expect(block.attrs.language).toBe("js")
    expect(block.textContent).toBe("const answer = 42")
    // Untouched blocks keep their bytes, the tilde fence included.
    expect(docToMarkdown(target.state.doc)).toBe(NOTE)
    expect(roundTripCheck(NOTE).ok).toBe(true)
  })

  it("draws colours, the language and a Copy button outside the text", () => {
    const target = mount(NOTE)
    const blocks = target.view.dom.querySelectorAll(".amby-code-block")
    expect(blocks).toHaveLength(2)
    expect(blocks[0].querySelector(".amby-code-block-language")?.textContent).toBe("js")
    expect(blocks[0].querySelector(".hljs-keyword")?.textContent).toBe("const")
    expect(blocks[0].querySelector("code")?.textContent).toBe("const answer = 42")
    expect(blocks[0].querySelector(".amby-code-block-bar")?.getAttribute("contenteditable")).toBe(
      "false",
    )
    // No language: the label says so, and nothing is written into the note for it.
    expect(blocks[1].querySelector(".amby-code-block-language")?.textContent).toBe("текст")
    expect(docToMarkdown(target.state.doc)).toBe(NOTE)
  })

  it("follows a change of the language without being rebuilt", () => {
    const target = mount(NOTE)
    const before = target.view.dom.querySelector(".amby-code-block")
    target.commands.setTextSelection(10)
    target.commands.updateAttributes("codeBlock", { language: "ts" })
    const after = target.view.dom.querySelector(".amby-code-block")
    expect(after).toBe(before)
    expect(after?.querySelector(".amby-code-block-language")?.textContent).toBe("ts")
    expect(docToMarkdown(target.state.doc)).toContain("```ts\nconst answer = 42\n```")
  })
})
