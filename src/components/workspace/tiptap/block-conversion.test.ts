import { EditorState } from "@tiptap/pm/state"
import { describe, expect, it } from "vitest"

import {
  calloutToBlockquote,
  convertBlockToParagraph,
  convertBlockWrapper,
} from "./block-conversion"
import { docToMarkdown, editorSchema, markdownToDoc } from "./markdown"

describe("block conversion", () => {
  it("replaces a Callout with a quote instead of nesting it", () => {
    const doc = editorSchema.nodeFromJSON(
      markdownToDoc("> [!NOTE] 💡\n> First row\n>\n> **Second row**"),
    )
    const state = EditorState.create({ schema: editorSchema, doc })
    const transaction = calloutToBlockquote(state, 0)

    expect(transaction).not.toBeNull()
    expect(transaction!.doc.firstChild?.type.name).toBe("blockquote")
    expect(transaction!.doc.firstChild?.firstChild?.type.name).toBe("paragraph")
    expect(transaction!.doc.firstChild?.childCount).toBe(2)
    expect(docToMarkdown(transaction!.doc)).toBe("> First row\n>\n> **Second row**")
  })

  it("keeps paragraph text and marks when turning it into a quote", () => {
    const doc = editorSchema.nodeFromJSON(markdownToDoc("Keep **all** text"))
    const state = EditorState.create({ schema: editorSchema, doc })
    const transaction = convertBlockWrapper(state, 0, "blockquote")

    expect(transaction).not.toBeNull()
    expect(docToMarkdown(transaction!.doc)).toBe("> Keep **all** text")
  })

  it("keeps paragraph text and marks when turning it into a Callout", () => {
    const doc = editorSchema.nodeFromJSON(markdownToDoc("Keep **all** text"))
    const state = EditorState.create({ schema: editorSchema, doc })
    const transaction = convertBlockWrapper(state, 0, "callout")

    expect(transaction).not.toBeNull()
    expect(transaction!.doc.firstChild?.type.name).toBe("callout")
    expect(transaction!.doc.firstChild?.textContent).toBe("Keep all text")
    expect(docToMarkdown(transaction!.doc)).toContain("Keep **all** text")
  })

  it("keeps all quote blocks when turning it into a Callout", () => {
    const doc = editorSchema.nodeFromJSON(markdownToDoc("> First\n>\n> Second"))
    const state = EditorState.create({ schema: editorSchema, doc })
    const transaction = convertBlockWrapper(state, 0, "callout")

    expect(transaction).not.toBeNull()
    expect(transaction!.doc.firstChild?.type.name).toBe("callout")
    expect(transaction!.doc.firstChild?.childCount).toBe(2)
    expect(transaction!.doc.firstChild?.textContent).toBe("FirstSecond")
  })

  it("turns a heading into a paragraph without losing marks", () => {
    const doc = editorSchema.nodeFromJSON(markdownToDoc("## Keep **all** text"))
    const state = EditorState.create({ schema: editorSchema, doc })
    const transaction = convertBlockToParagraph(state, 0)

    expect(transaction).not.toBeNull()
    expect(transaction!.doc.firstChild?.type.name).toBe("paragraph")
    expect(docToMarkdown(transaction!.doc)).toBe("Keep **all** text")
  })

  it("unwraps a Callout into paragraphs without losing its content", () => {
    const doc = editorSchema.nodeFromJSON(markdownToDoc("> [!NOTE] 💡\n> First\n>\n> **Second**"))
    const state = EditorState.create({ schema: editorSchema, doc })
    const transaction = convertBlockToParagraph(state, 0)

    expect(transaction).not.toBeNull()
    expect(transaction!.doc.childCount).toBe(2)
    expect(transaction!.doc.firstChild?.type.name).toBe("paragraph")
    expect(docToMarkdown(transaction!.doc)).toBe("First\n\n**Second**")
  })

  it("unwraps a quote into ordinary paragraphs", () => {
    const doc = editorSchema.nodeFromJSON(markdownToDoc("> First\n>\n> Second"))
    const state = EditorState.create({ schema: editorSchema, doc })
    const transaction = convertBlockToParagraph(state, 0)

    expect(transaction).not.toBeNull()
    expect(docToMarkdown(transaction!.doc)).toBe("First\n\nSecond")
  })
})
