import { describe, expect, it } from "vitest"
import { EditorState } from "@tiptap/pm/state"

import { mergeAdjacentOrderedLists } from "./indent-shortcut"
import { editorSchema } from "./markdown"
import { docToMarkdown } from "./markdown"

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
