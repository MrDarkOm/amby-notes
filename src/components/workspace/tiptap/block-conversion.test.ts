import { EditorState } from "@tiptap/pm/state"
import { describe, expect, it } from "vitest"

import {
  calloutToBlockquote,
  convertBlockToParagraph,
  convertBlockWrapper,
  convertList,
  findListParent,
  splitParagraphIntoBlocks,
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

describe("splitting a paragraph into blocks", () => {
  const stateOf = (markdown: string) =>
    EditorState.create({
      schema: editorSchema,
      doc: editorSchema.nodeFromJSON(markdownToDoc(markdown)),
    })

  it("makes one paragraph per visual line and keeps the marks", () => {
    const { paragraph, hardBreak } = editorSchema.nodes
    const bold = editorSchema.marks.bold
    const doc = editorSchema.node("doc", null, [
      paragraph.create(null, [
        editorSchema.text("one"),
        hardBreak.create(),
        editorSchema.text("two", [bold.create()]),
        editorSchema.text("\nthree"),
      ]),
    ])
    const transaction = splitParagraphIntoBlocks(
      EditorState.create({ schema: editorSchema, doc }),
      0,
    )

    expect(transaction).not.toBeNull()
    expect(transaction!.doc.childCount).toBe(3)
    expect(docToMarkdown(transaction!.doc)).toBe("one\n\n**two**\n\nthree")
  })

  it("does nothing for a single line or a block that is not a paragraph", () => {
    expect(splitParagraphIntoBlocks(stateOf("One line"), 0)).toBeNull()
    expect(splitParagraphIntoBlocks(stateOf("# Heading"), 0)).toBeNull()
  })
})

describe("switching the kind of a list", () => {
  const stateOf = (markdown: string) =>
    EditorState.create({
      schema: editorSchema,
      doc: editorSchema.nodeFromJSON(markdownToDoc(markdown)),
    })

  it("finds the list around a position", () => {
    const state = stateOf("- a\n- b\n\nAfter")
    expect(findListParent(state, 0)?.type).toBe("bulletList")
    expect(findListParent(state, state.doc.content.size - 1)).toBeNull()
  })

  it("turns a bullet list into a numbered list and keeps the item text", () => {
    const state = stateOf("- a\n- **b**")
    const transaction = convertList(state, 0, "ordered")
    expect(transaction).not.toBeNull()
    expect(docToMarkdown(transaction!.doc)).toBe("1. a\n2. **b**")
  })

  it("turns a numbered list into a task list with unchecked items", () => {
    const state = stateOf("1. a\n2. b")
    const transaction = convertList(state, 0, "task")
    expect(transaction).not.toBeNull()
    expect(docToMarkdown(transaction!.doc)).toBe("- [ ] a\n- [ ] b")
  })

  it("does nothing when the list already is of that kind or there is no list", () => {
    expect(convertList(stateOf("- a"), 0, "bullet")).toBeNull()
    expect(convertList(stateOf("Text"), 0, "ordered")).toBeNull()
  })
})
