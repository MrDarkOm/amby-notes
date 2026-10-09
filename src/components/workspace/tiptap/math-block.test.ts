// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { history, undo } from "@tiptap/pm/history"
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state"

import { docToMarkdown, editorSchema, markdownToDoc, roundTripCheck } from "./markdown"
import { markdownMeaning } from "./markdown-meaning"
import {
  MATH_EDIT_EVENT,
  insertMathBlock,
  mathBlockOnEnter,
  mathBlockValue,
  removeEmptyMathBlock,
  setMathBlockTex,
} from "./math-block"
import { getSlashItems } from "./block-insert-items"
import { schemaExtensions } from "./schema"

const NOTE = "Before\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nAfter"

function stateOf(markdown: string): EditorState {
  return EditorState.create({
    schema: editorSchema,
    doc: editorSchema.nodeFromJSON(markdownToDoc(markdown)),
    plugins: [history()],
  })
}

function mathPos(state: EditorState): number {
  let at = -1
  state.doc.descendants((node, pos) => {
    if (node.type.name === "opaqueMarkdownBlock" && node.attrs.kind === "math") at = pos
  })
  expect(at).toBeGreaterThan(-1)
  return at
}

function run(
  state: EditorState,
  command: (state: EditorState, dispatch: (tr: EditorState["tr"]) => void) => boolean,
): EditorState {
  let next = state
  expect(command(state, (tr) => (next = state.apply(tr)))).toBe(true)
  return next
}

const mathBlocks = (markdown: string) => {
  const found: string[] = []
  editorSchema.nodeFromJSON(markdownToDoc(markdown)).descendants((node) => {
    if (node.type.name === "opaqueMarkdownBlock" && node.attrs.kind === "math")
      found.push(node.attrs.value)
  })
  return found
}

describe("the source of a display-math block", () => {
  it("puts the TeX between dollar lines, character for character", () => {
    expect(mathBlockValue("a_1 * b_2 * c")).toBe("$$\na_1 * b_2 * c\n$$")
    expect(mathBlockValue("\\int_0^1 x\\,dx \\\\ \\{a\\} \\# [x](y) `z`")).toBe(
      "$$\n\\int_0^1 x\\,dx \\\\ \\{a\\} \\# [x](y) `z`\n$$",
    )
    expect(mathBlockValue("\\begin{aligned}\n  a &= b \\\\\n  c &= d\n\\end{aligned}")).toBe(
      "$$\n\\begin{aligned}\n  a &= b \\\\\n  c &= d\n\\end{aligned}\n$$",
    )
  })

  it("writes its own line endings and drops blank lines around the TeX", () => {
    expect(mathBlockValue("\r\n\r\na\r\nb\r\n  \r\n")).toBe("$$\na\nb\n$$")
  })

  it("refuses TeX the file could not hold as one formula", () => {
    expect(mathBlockValue("")).toBeNull()
    expect(mathBlockValue("  \n ")).toBeNull()
    // A blank line ends a paragraph; these lines start another block.
    expect(mathBlockValue("a\n\nb")).toBeNull()
    expect(mathBlockValue("a\n- b")).toBeNull()
    expect(mathBlockValue("a\n+ b")).toBeNull()
    expect(mathBlockValue("a\n# b")).toBeNull()
    expect(mathBlockValue("a\n> b")).toBeNull()
    expect(mathBlockValue("a\n===")).toBeNull()
    expect(mathBlockValue("a\n---")).toBeNull()
    expect(mathBlockValue("a\n```\nb")).toBeNull()
    expect(mathBlockValue("a\n<div>")).toBeNull()
    expect(mathBlockValue("a | b\n--- | ---")).toBeNull()
  })

  it("accepts only what reads back as the same block for both readings", () => {
    for (const tex of [
      "x",
      "a\n+b",
      "a\n-b",
      "a = b\n= c",
      "1. x",
      "#x",
      "[a]: b",
      "a\n    + b",
      "x $$ y",
      "a\n$$\nb",
      "\\text{<b>} & |x|",
    ]) {
      const value = mathBlockValue(tex)
      if (value === null) continue
      expect(mathBlocks(value), tex).toEqual([value])
      expect(roundTripCheck(value), tex).toEqual({ ok: true, result: value })
      const plain = JSON.parse(markdownMeaning(value).content) as unknown[][]
      expect(plain.map((token) => token[0]).filter((kind) => typeof kind === "string")).toEqual([
        "paragraph_open",
        "paragraph_close",
      ])
      expect(markdownMeaning(value).hasDefinitions).toBe(false)
    }
    // Lines that only look like Markdown stay TeX.
    expect(mathBlockValue("a\n+b")).not.toBeNull()
    expect(mathBlockValue("#x")).not.toBeNull()
    // A link definition would vanish from the note: it is not taken.
    expect(mathBlockValue("[a]: b")).toBeNull()
  })
})

describe("changing a display-math block", () => {
  it("writes the new TeX for that block only and keeps the rest byte for byte", () => {
    const source = "Before\n===\n\n$$\na\n$$\n\n* * *\n\n1) After"
    const state = stateOf(source)
    const next = run(state, (s, d) => setMathBlockTex(s, mathPos(s), "\\frac{a_1}{b_2} * c", d))
    const written = docToMarkdown(next.doc)
    expect(written).toBe(source.replace("\na\n", "\n\\frac{a_1}{b_2} * c\n"))
    expect(roundTripCheck(written)).toEqual({ ok: true, result: written })
    expect(mathBlocks(written)).toEqual(["$$\n\\frac{a_1}{b_2} * c\n$$"])
  })

  it("is one step: a single undo gives the file back", () => {
    const state = stateOf(NOTE)
    const next = run(state, (s, d) => setMathBlockTex(s, mathPos(s), "x^2", d))
    expect(docToMarkdown(next.doc)).toBe("Before\n\n$$\nx^2\n$$\n\nAfter")
    const undone = run(next, undo)
    expect(docToMarkdown(undone.doc)).toBe(NOTE)
    expect(undo(undone)).toBe(false)
  })

  it("changes nothing when the TeX is the same or cannot be held", () => {
    const state = stateOf(NOTE)
    let dispatched = 0
    expect(setMathBlockTex(state, mathPos(state), "\\int_0^1 x\\,dx\n", () => dispatched++)).toBe(
      true,
    )
    expect(setMathBlockTex(state, mathPos(state), "a\n\nb", () => dispatched++)).toBe(false)
    expect(setMathBlockTex(state, 0, "x", () => dispatched++)).toBe(false)
    expect(dispatched).toBe(0)
  })

  it("writes the file's own line endings at the note boundary", () => {
    const crlf = NOTE.replace(/\n/g, "\r\n")
    expect(roundTripCheck(crlf)).toEqual({ ok: true, result: crlf })
    const state = stateOf(crlf)
    const next = run(state, (s, d) => setMathBlockTex(s, mathPos(s), "a\r\nb", d))
    expect(docToMarkdown(next.doc)).toBe("Before\n\n$$\na\nb\n$$\n\nAfter")
  })
})

describe("making a display-math block", () => {
  const typed = (markdown: string, text: string) => {
    const state = stateOf(markdown)
    let at = -1
    state.doc.descendants((node, pos) => {
      if (node.isText && node.text === text) at = pos + text.length
    })
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)))
  }

  it("turns a top-level line that is `$$` into an empty formula on Enter", () => {
    const next = run(typed("Before\n\n\\$\\$\n\nAfter", "$$"), mathBlockOnEnter)
    expect(next.doc.child(1).type.name).toBe("opaqueMarkdownBlock")
    expect(next.doc.child(1).attrs).toMatchObject({ kind: "math", value: "" })
    expect(next.selection).toBeInstanceOf(NodeSelection)
    const written = run(next, (s, d) => setMathBlockTex(s, mathPos(s), "E = mc^2", d))
    expect(docToMarkdown(written.doc)).toBe("Before\n\n$$\nE = mc^2\n$$\n\nAfter")
  })

  it("leaves Enter alone anywhere else", () => {
    expect(mathBlockOnEnter(typed("a \\$\\$", "a $$"))).toBe(false)
    expect(mathBlockOnEnter(typed("- \\$\\$", "$$"))).toBe(false)
    expect(mathBlockOnEnter(typed("> \\$\\$", "$$"))).toBe(false)
    const middle = typed("\\$\\$", "$$")
    expect(
      mathBlockOnEnter(middle.apply(middle.tr.setSelection(TextSelection.create(middle.doc, 2)))),
    ).toBe(false)
  })

  it("inserts at the top level: in place of an empty line, after any other block", () => {
    const empty = stateOf("Before\n\n\n\nAfter")
    expect(empty.doc.child(1).childCount).toBe(0)
    const replaced = run(empty, (s, d) => insertMathBlock(s, 9, d))
    expect(replaced.doc.childCount).toBe(empty.doc.childCount)
    expect(replaced.doc.child(1).attrs.kind).toBe("math")

    const list = stateOf("- one\n- two\n\nAfter")
    const after = run(list, (s, d) => insertMathBlock(s, 4, d))
    expect(after.doc.child(0).type.name).toBe("bulletList")
    expect(after.doc.child(1).attrs.kind).toBe("math")
    expect(after.doc.childCount).toBe(3)

    const table = stateOf("| a | b |\n| --- | --- |\n| c | d |")
    const afterTable = run(table, (s, d) => insertMathBlock(s, 5, d))
    expect(afterTable.doc.child(0).type.name).toBe("table")
    expect(afterTable.doc.child(1).attrs.kind).toBe("math")
  })

  it("takes an unwritten formula away and leaves a line to write on", () => {
    const made = run(stateOf("Before\n\n\n\nAfter"), (s, d) => insertMathBlock(s, 9, d))
    const removed = run(made, (s, d) => removeEmptyMathBlock(s, mathPos(s), d))
    expect(docToMarkdown(removed.doc)).toBe("Before\n\n\n\nAfter")
    // A written formula is never taken away like this.
    const written = stateOf(NOTE)
    expect(removeEmptyMathBlock(written, mathPos(written))).toBe(false)
  })

  it("an unwritten formula is an empty line in the file, never a broken block", () => {
    const made = run(stateOf("Before\n\nAfter"), (s, d) => insertMathBlock(s, 1, d))
    const written = docToMarkdown(made.doc)
    expect(written).not.toContain("$$")
    expect(mathBlocks(written)).toEqual([])
    const reread = editorSchema.nodeFromJSON(markdownToDoc(written))
    expect(reread.firstChild?.textContent).toBe("Before")
    expect(reread.lastChild?.textContent).toBe("After")
    expect(reread.textContent).toBe("BeforeAfter")
  })

  it("is in the slash menu", () => {
    expect(getSlashItems().map((item) => item.id)).toContain("math")
  })
})

describe("the text area of a display-math block", () => {
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
  const turn = () => new Promise((resolve) => setTimeout(resolve, 0))
  const area = (target: Editor) =>
    target.view.dom.querySelector<HTMLTextAreaElement>(".amby-math-input")
  const key = (init: KeyboardEventInit) =>
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })

  it("opens with the TeX without its dollar lines and applies with Mod-Enter", async () => {
    const target = mount(NOTE)
    const block = target.view.dom.querySelector<HTMLElement>(".amby-math-block")!
    block.dispatchEvent(new CustomEvent(MATH_EDIT_EVENT))
    await turn()
    expect(area(target)?.value).toBe("\\int_0^1 x\\,dx")
    // Opening it is not an edit.
    expect(docToMarkdown(target.state.doc)).toBe(NOTE)
    area(target)!.value = "a_1 * b_2 * c"
    area(target)!.dispatchEvent(new Event("input", { bubbles: true }))
    expect(docToMarkdown(target.state.doc)).toBe(NOTE)
    area(target)!.dispatchEvent(key({ key: "Enter", metaKey: true }))
    expect(area(target)).toBeNull()
    expect(docToMarkdown(target.state.doc)).toBe("Before\n\n$$\na_1 * b_2 * c\n$$\n\nAfter")
    expect(block.querySelector("pre")?.textContent).toBe("$$\na_1 * b_2 * c\n$$")
  })

  it("Escape leaves the block as it was read", async () => {
    const target = mount(NOTE)
    const before = target.state.doc
    target.view.dom
      .querySelector(".amby-math-block")!
      .dispatchEvent(new CustomEvent(MATH_EDIT_EVENT))
    await turn()
    area(target)!.value = "changed"
    area(target)!.dispatchEvent(key({ key: "Escape" }))
    expect(area(target)).toBeNull()
    expect(target.state.doc.eq(before)).toBe(true)
    expect(docToMarkdown(target.state.doc)).toBe(NOTE)
  })

  it("keeps TeX it cannot write open with a message and the note unchanged", async () => {
    const target = mount(NOTE)
    target.view.dom
      .querySelector(".amby-math-block")!
      .dispatchEvent(new CustomEvent(MATH_EDIT_EVENT))
    await turn()
    area(target)!.value = "a\n\nb"
    area(target)!.dispatchEvent(key({ key: "Enter", ctrlKey: true }))
    expect(area(target)).not.toBeNull()
    expect(target.view.dom.querySelector<HTMLElement>(".amby-math-error")?.hidden).toBe(false)
    expect(docToMarkdown(target.state.doc)).toBe(NOTE)
  })

  it("does not open in a note that cannot be edited", async () => {
    const target = mount(NOTE)
    target.setEditable(false)
    target.view.dom
      .querySelector<HTMLElement>(".amby-math-block")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await turn()
    expect(area(target)).toBeNull()
  })

  it("draws nothing with a title attribute", async () => {
    const target = mount(NOTE)
    target.view.dom
      .querySelector(".amby-math-block")!
      .dispatchEvent(new CustomEvent(MATH_EDIT_EVENT))
    await turn()
    expect(target.view.dom.querySelectorAll(".amby-math-block [title]")).toHaveLength(0)
  })
})
