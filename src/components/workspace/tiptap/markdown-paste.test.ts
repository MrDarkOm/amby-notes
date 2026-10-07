// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { EditorState, TextSelection } from "@tiptap/pm/state"

import { docToMarkdown, editorSchema, markdownToDoc, roundTripCheck } from "./markdown"
import { looksLikeMarkdown, markdownPasteContent, pasteMarkdown } from "./markdown-paste"
import { schemaExtensions } from "./schema"

const open = (markdown: string, anchor: number, head = anchor) => {
  const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
  const base = EditorState.create({ schema: editorSchema, doc })
  return base.apply(base.tr.setSelection(TextSelection.create(doc, anchor, head)))
}

const paste = (state: EditorState, text: string) => {
  const tr = pasteMarkdown(state, text)
  return tr ? state.apply(tr) : null
}

const blockTypes = (state: EditorState) => {
  const types: string[] = []
  state.doc.forEach((child) => types.push(child.type.name))
  return types
}

describe("pasting plain text written as Markdown", () => {
  it("tells Markdown from ordinary text", () => {
    expect(looksLikeMarkdown("# Heading")).toBe(true)
    expect(looksLikeMarkdown("- a\n- b")).toBe(true)
    expect(looksLikeMarkdown("1) a")).toBe(true)
    expect(looksLikeMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(true)
    expect(looksLikeMarkdown("```js\nlet a\n```")).toBe(true)
    expect(looksLikeMarkdown("> quote")).toBe(true)
    expect(looksLikeMarkdown("some **bold** word")).toBe(true)
    expect(looksLikeMarkdown("see [site](https://example.com)")).toBe(true)

    expect(looksLikeMarkdown("Just a sentence.")).toBe(false)
    expect(looksLikeMarkdown("Two lines\nof plain text")).toBe(false)
    expect(looksLikeMarkdown("a * b * c and 2 - 1")).toBe(false)
    expect(looksLikeMarkdown("#tag at the start")).toBe(false)
    expect(looksLikeMarkdown("https://example.com/a_b_c")).toBe(false)
  })

  it("leaves ordinary text to the editor's own paste", () => {
    expect(markdownPasteContent("Just a sentence.")).toBeNull()
    expect(paste(open("Start", 6), "Two lines\nof plain text")).toBeNull()
  })

  it("makes a heading, a list, a table and a code block on an empty line", () => {
    const clip = [
      "# Heading",
      "",
      "- a",
      "- b",
      "",
      "| x | y |",
      "| --- | :-: |",
      "| 1 | 2 |",
      "",
      "```js",
      "let a = 1",
      "```",
    ].join("\n")
    // "Start", an empty paragraph, "End": the cursor is on the empty line.
    const text = (value: string) => ({
      type: "paragraph",
      content: [{ type: "text", text: value }],
    })
    const doc = editorSchema.nodeFromJSON({
      type: "doc",
      content: [text("Start"), { type: "paragraph" }, text("End")],
    })
    const base = EditorState.create({ schema: editorSchema, doc })
    const state = paste(base.apply(base.tr.setSelection(TextSelection.create(doc, 8))), clip)
    expect(state).not.toBeNull()
    expect(blockTypes(state!)).toEqual([
      "paragraph",
      "heading",
      "bulletList",
      "table",
      "codeBlock",
      "paragraph",
    ])
    const markdown = docToMarkdown(state!.doc)
    expect(markdown).toBe(
      [
        "Start",
        "",
        "# Heading",
        "",
        "- a",
        "- b",
        "",
        "| x | y |",
        // The alignment is kept; the dashes are the editor's own.
        "| --- | :---: |",
        "| 1 | 2 |",
        "",
        "```js",
        "let a = 1",
        "```",
        "",
        "End",
      ].join("\n"),
    )
    expect(roundTripCheck(markdown).ok).toBe(true)
  })

  it("pastes blocks as new ones, written in the editor's form", () => {
    const state = paste(open("", 1), "Title\n=====\n\n1) one\n2) two\n\n* * *")
    expect(state).not.toBeNull()
    state!.doc.descendants((node) => {
      expect(node.attrs.markdownBlockSource ?? null).toBeNull()
      expect(node.attrs.markdownBlockGap ?? null).toBeNull()
      expect(node.attrs.markdownSource ?? null).toBeNull()
    })
    expect(docToMarkdown(state!.doc)).toBe("# Title\n\n1. one\n2. two\n\n---")
  })

  it("puts one pasted paragraph into the text at the cursor, marks included", () => {
    const state = paste(open("Hello world", 7), "**bold** and [link](https://example.com) ")
    expect(state).not.toBeNull()
    expect(blockTypes(state!)).toEqual(["paragraph"])
    expect(docToMarkdown(state!.doc)).toBe("Hello **bold** and [link](https://example.com) world")
  })

  it("replaces the selected text", () => {
    const state = paste(open("Hello world", 7, 12), "`code`")
    expect(docToMarkdown(state!.doc)).toBe("Hello `code`")
  })

  it("splits a paragraph around pasted blocks", () => {
    const state = paste(open("Hello world", 7), "- a\n- b")
    expect(blockTypes(state!)).toEqual(["paragraph", "bulletList", "paragraph"])
    expect(docToMarkdown(state!.doc)).toBe("Hello \n\n- a\n- b\n\nworld")
  })

  it("leaves the blocks around the paste as they were read", () => {
    const source = "Setext\n======\n\n\n\n* * *\n"
    const state = paste(open(source, 9), "## New\n\n- item")
    const markdown = docToMarkdown(state!.doc)
    expect(markdown.startsWith("Setext\n======\n")).toBe(true)
    expect(markdown.endsWith("* * *")).toBe(true)
    expect(markdown).toContain("## New\n\n- item")
  })

  it("pastes into a running editor, whose schema is not the parser's own", () => {
    const editor = new Editor({ extensions: schemaExtensions, content: markdownToDoc("") })
    try {
      expect(editor.schema).not.toBe(editorSchema)
      const tr = pasteMarkdown(editor.state, "# Heading\n\n- a\n- b")
      expect(tr).not.toBeNull()
      editor.view.dispatch(tr!)
      expect(docToMarkdown(editor.state.doc)).toBe("# Heading\n\n- a\n- b")
      // And as text into a paragraph that already has some.
      editor.commands.setContent(markdownToDoc("Hello"), { emitUpdate: false })
      editor.commands.setTextSelection(6)
      editor.view.dispatch(pasteMarkdown(editor.state, " **bold**")!)
      expect(docToMarkdown(editor.state.doc)).toBe("Hello **bold**")
    } finally {
      editor.destroy()
    }
  })

  it("keeps Markdown pasted into a code block as text", () => {
    const state = open("```\ncode\n```", 3)
    expect(state.selection.$from.parent.type.name).toBe("codeBlock")
    expect(pasteMarkdown(state, "# Heading\n\n- a")).toBeNull()
  })

  it("accepts Windows line endings and surrounding blank lines", () => {
    const state = paste(open("", 1), "\r\n# A\r\n\r\n- b\r\n\r\n")
    expect(docToMarkdown(state!.doc)).toBe("# A\n\n- b")
  })
})
