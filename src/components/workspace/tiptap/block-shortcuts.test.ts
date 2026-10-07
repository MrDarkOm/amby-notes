// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state"

import {
  BlockShortcuts,
  OPEN_LINK_PANEL_EVENT,
  duplicateBlock,
  headingToParagraph,
  moveBlock,
} from "./block-shortcuts"
import { docToMarkdown, editorSchema, markdownToDoc, roundTripCheck } from "./markdown"
import { schemaExtensions } from "./schema"

const open = (markdown: string, anchor: number, head = anchor) => {
  const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
  const base = EditorState.create({ schema: editorSchema, doc })
  return base.apply(base.tr.setSelection(TextSelection.create(doc, anchor, head)))
}

type Command = (state: EditorState, dispatch?: (tr: EditorState["tr"]) => void) => boolean
const run = (command: Command, state: EditorState) => {
  let next = state
  const handled = command(state, (tr) => (next = state.apply(tr)))
  return { handled, state: next }
}

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function mount(markdown: string): Editor {
  editor = new Editor({
    extensions: [...schemaExtensions, BlockShortcuts],
    content: markdownToDoc(markdown),
  })
  return editor
}

/** Types text the way the browser reports it, so input rules run. */
function type(target: Editor, text: string) {
  for (const character of text) {
    const { from, to } = target.state.selection
    const handled = target.view.someProp("handleTextInput", (handler) =>
      handler(target.view, from, to, character, () =>
        target.state.tr.insertText(character, from, to),
      ),
    )
    if (!handled) target.view.dispatch(target.state.tr.insertText(character, from, to))
  }
}

/** `Mod` is Ctrl here: the test DOM does not report a Mac. */
function press(target: Editor, key: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers })
  return Boolean(target.view.someProp("handleKeyDown", (handler) => handler(target.view, event)))
}

describe("typing a task, a numbered list and a rule", () => {
  it("turns `- [ ] ` into a task instead of a bullet with `[ ] ` as text", () => {
    const target = mount("")
    type(target, "- [ ] buy milk")
    expect(target.state.doc.firstChild?.type.name).toBe("taskList")
    const markdown = docToMarkdown(target.state.doc)
    expect(markdown).toBe("- [ ] buy milk")
    expect(roundTripCheck(markdown).ok).toBe(true)
  })

  it("makes a checked task from `- [x] `", () => {
    const target = mount("")
    type(target, "- [x] done")
    expect(docToMarkdown(target.state.doc)).toBe("- [x] done")
  })

  it("cuts a bullet list around the item that became a task", () => {
    const target = mount("- one\n- two\n- three")
    // The start of "two".
    target.commands.setTextSelection(10)
    expect(target.state.selection.$from.parent.textContent).toBe("two")
    type(target, "[ ] ")
    const types: string[] = []
    target.state.doc.forEach((child) => types.push(child.type.name))
    expect(types).toEqual(["bulletList", "taskList", "bulletList"])
    expect(target.state.selection.$from.parent.textContent).toBe("two")
    expect(target.state.selection.$from.parentOffset).toBe(0)
    const markdown = docToMarkdown(target.state.doc)
    expect(markdown).toContain("- [ ] two")
    expect(markdown).toContain("- one")
    expect(markdown).toContain("- three")
    expect(roundTripCheck(markdown).ok).toBe(true)
  })

  it("keeps what is nested under the item", () => {
    const target = mount("- parent\n  - child")
    target.commands.setTextSelection(3)
    type(target, "[ ] ")
    expect(docToMarkdown(target.state.doc)).toBe("- [ ] parent\n  - child")
  })

  it("leaves `[ ] ` alone in the middle of an item and in a numbered list", () => {
    const middle = mount("- text")
    middle.commands.setTextSelection(7)
    type(middle, " [ ] ")
    expect(middle.state.doc.firstChild?.type.name).toBe("bulletList")
    middle.destroy()

    const numbered = mount("1. ")
    numbered.commands.focus("end")
    type(numbered, "[ ] x")
    expect(numbered.state.doc.firstChild?.type.name).toBe("orderedList")
  })

  it("starts a numbered list from `1) ` and from another number", () => {
    const target = mount("")
    type(target, "1) first")
    expect(target.state.doc.firstChild?.type.name).toBe("orderedList")
    expect(docToMarkdown(target.state.doc)).toBe("1. first")
    target.destroy()

    const fifth = mount("")
    type(fifth, "5) fifth")
    expect(docToMarkdown(fifth.state.doc)).toBe("5. fifth")
  })

  it("draws a rule from `*** `, `---` and `___ `", () => {
    for (const typed of ["*** ", "---", "___ "]) {
      const target = mount("")
      type(target, typed)
      expect(target.state.doc.firstChild?.type.name, typed).toBe("horizontalRule")
      target.destroy()
    }
  })
})

describe("Backspace at the start of a heading", () => {
  it("makes the heading a paragraph and keeps the paragraph above apart", () => {
    const state = open("Above\n\n## Title", 8)
    expect(state.selection.$from.parent.type.name).toBe("heading")
    const result = run(headingToParagraph, state)
    expect(result.handled).toBe(true)
    expect(docToMarkdown(result.state.doc)).toBe("Above\n\nTitle")
    expect(result.state.selection.$from.parentOffset).toBe(0)
    // The second Backspace is the ordinary one.
    expect(run(headingToParagraph, result.state).handled).toBe(false)
  })

  it("does nothing inside the heading text, with a selection, or in a paragraph", () => {
    expect(run(headingToParagraph, open("## Title", 3)).handled).toBe(false)
    expect(run(headingToParagraph, open("## Title", 1, 4)).handled).toBe(false)
    expect(run(headingToParagraph, open("Text", 1)).handled).toBe(false)
  })

  it("is what the Backspace key does in the editor", () => {
    const target = mount("Above\n\n# Title")
    target.commands.setTextSelection(8)
    expect(press(target, "Backspace")).toBe(true)
    expect(docToMarkdown(target.state.doc)).toBe("Above\n\nTitle")
  })
})

describe("duplicating and moving a block", () => {
  it("duplicates the block under itself with the cursor in the copy", () => {
    const state = open("One\n\nTwo\n\nThree", 7)
    const result = run(duplicateBlock, state)
    expect(result.handled).toBe(true)
    expect(docToMarkdown(result.state.doc)).toBe("One\n\nTwo\n\nTwo\n\nThree")
    expect(result.state.selection.from).toBe(12)
    expect(result.state.selection.$from.parent.textContent).toBe("Two")
  })

  it("keeps the source text of a duplicated and of a moved block", () => {
    const source = "Setext\n======\n\nPlain\n\n* * *"
    const duplicated = run(duplicateBlock, open(source, 2))
    expect(docToMarkdown(duplicated.state.doc)).toBe(
      "Setext\n======\n\nSetext\n======\n\nPlain\n\n* * *",
    )
    const moved = run(moveBlock("down"), open(source, 2))
    expect(docToMarkdown(moved.state.doc)).toBe("Plain\n\nSetext\n======\n\n* * *")
  })

  it("duplicates a whole list and a selected block without text", () => {
    const list = run(duplicateBlock, open("- a\n- b", 4))
    expect(docToMarkdown(list.state.doc)).toBe("- a\n- b\n\n\n- a\n- b")

    const base = open("One\n\n---\n\nTwo", 1)
    const rule = base.apply(base.tr.setSelection(NodeSelection.create(base.doc, 5)))
    expect((rule.selection as NodeSelection).node.type.name).toBe("horizontalRule")
    const result = run(duplicateBlock, rule)
    expect(docToMarkdown(result.state.doc)).toBe("One\n\n---\n\n---\n\nTwo")
  })

  it("moves a block up and down and keeps the cursor in it", () => {
    const state = open("One\n\nTwo\n\nThree", 8)
    const up = run(moveBlock("up"), state)
    expect(docToMarkdown(up.state.doc)).toBe("Two\n\nOne\n\nThree")
    expect(up.state.selection.$from.parent.textContent).toBe("Two")
    expect(up.state.selection.$from.parentOffset).toBe(2)

    const down = run(moveBlock("down"), state)
    expect(docToMarkdown(down.state.doc)).toBe("One\n\nThree\n\nTwo")
    expect(down.state.selection.$from.parent.textContent).toBe("Two")
  })

  it("takes the key at the edge of the note without changing anything", () => {
    const first = run(moveBlock("up"), open("One\n\nTwo", 2))
    expect(first.handled).toBe(true)
    expect(first.state.doc.eq(open("One\n\nTwo", 2).doc)).toBe(true)
    const last = run(moveBlock("down"), open("One\n\nTwo", 7))
    expect(last.handled).toBe(true)
    expect(docToMarkdown(last.state.doc)).toBe("One\n\nTwo")
  })

  it("moves a block inside its column, not the column set", () => {
    const columns = [
      "<!-- amby:columns -->",
      "<!-- amby:column -->",
      "",
      "A",
      "",
      "B",
      "",
      "<!-- amby:column -->",
      "",
      "C",
      "",
      "<!-- /amby:columns -->",
    ].join("\n")
    const doc = editorSchema.nodeFromJSON(markdownToDoc(columns))
    expect(doc.firstChild?.type.name).toBe("columnSet")
    let inB = 0
    doc.descendants((node, pos) => {
      if (node.isText && node.text === "B") inB = pos
    })
    const base = EditorState.create({ schema: editorSchema, doc })
    const state = base.apply(base.tr.setSelection(TextSelection.create(doc, inB)))
    const result = run(moveBlock("up"), state)
    const texts: string[] = []
    result.state.doc.descendants((node) => {
      if (node.isText) texts.push(node.text ?? "")
    })
    expect(texts).toEqual(["B", "A", "C"])
    expect(result.state.doc.childCount).toBe(1)
  })

  it("is bound to Mod-D and Mod-Shift-Arrow in the editor", () => {
    const target = mount("One\n\nTwo")
    target.commands.setTextSelection(7)
    expect(press(target, "d", { ctrlKey: true })).toBe(true)
    expect(docToMarkdown(target.state.doc)).toBe("One\n\nTwo\n\nTwo")
    expect(press(target, "ArrowUp", { ctrlKey: true, shiftKey: true })).toBe(true)
    expect(docToMarkdown(target.state.doc)).toBe("One\n\nTwo\n\nTwo")
    expect(target.state.selection.from).toBe(7)
  })
})

describe("Mod-K", () => {
  it("asks for the link panel", () => {
    const target = mount("Text")
    let asked = 0
    target.view.dom.addEventListener(OPEN_LINK_PANEL_EVENT, () => (asked += 1))
    expect(press(target, "k", { ctrlKey: true })).toBe(true)
    expect(asked).toBe(1)
  })
})
