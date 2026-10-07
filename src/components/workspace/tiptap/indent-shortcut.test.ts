import { describe, expect, it } from "vitest"
import { EditorState, TextSelection } from "@tiptap/pm/state"

import { indentText, mergeAdjacentOrderedLists, outdentText } from "./indent-shortcut"
import { docToMarkdown, editorSchema, markdownToDoc, roundTripCheck } from "./markdown"

describe("ordered-list outdent normalization", () => {
  it("joins adjacent ordered lists so numbering continues", () => {
    const doc = editorSchema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }],
            },
          ],
        },
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Two" }] }],
            },
          ],
        },
      ],
    })
    let nextState = EditorState.create({ schema: editorSchema, doc })

    expect(mergeAdjacentOrderedLists(nextState, (tr) => (nextState = nextState.apply(tr)))).toBe(
      true,
    )
    expect(docToMarkdown(nextState.doc)).toBe("1. One\n2. Two")
  })
})

describe("Tab in text outside lists", () => {
  const open = (markdown: string, anchor: number, head = anchor) => {
    const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
    const base = EditorState.create({ schema: editorSchema, doc })
    return base.apply(base.tr.setSelection(TextSelection.create(doc, anchor, head)))
  }
  const run = (
    command: typeof indentText,
    state: EditorState,
  ): { handled: boolean; state: EditorState } => {
    let next = state
    const handled = command(state, (tr) => (next = state.apply(tr)))
    return { handled, state: next }
  }

  it("types a tab character at the caret and keeps the note readable", () => {
    const { handled, state } = run(indentText, open("Начало", 1))
    expect(handled).toBe(true)
    expect(state.doc.textContent).toBe("\tНачало")
    const markdown = docToMarkdown(state.doc)
    expect(markdown).toBe("&#9;Начало")
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
    // In the middle of a line the tab is plain text.
    const middle = run(indentText, open("Начало", 4))
    expect(docToMarkdown(middle.state.doc)).toBe("Нач\tало")
    expect(roundTripCheck("Нач\tало").ok).toBe(true)
  })

  it("indents every paragraph a selection touches instead of replacing it", () => {
    const state = open("Один\n\nДва\n\nТри", 1, 12)
    const { state: indented } = run(indentText, state)
    expect(indented.doc.textContent).toBe("\tОдин\tДва\tТри")
  })

  it("outdents with Shift+Tab and reports nothing to do on an unindented line", () => {
    const indented = run(indentText, open("Начало", 1)).state
    expect(run(outdentText, indented).state.doc.textContent).toBe("Начало")
    expect(run(outdentText, open("Начало", 1)).handled).toBe(false)
  })

  it("leaves tables to their own Tab handling and keeps Tab inside lists", () => {
    expect(run(indentText, open("| a | b |\n| - | - |\n| 1 | 2 |", 5)).handled).toBe(false)
    expect(run(indentText, open("- one", 4)).handled).toBe(true)
    expect(run(indentText, open("- one", 4)).state.doc.textContent).toBe("one")
  })
})
