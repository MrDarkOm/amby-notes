// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"

import {
  FindInNote,
  OPEN_FIND_EVENT,
  clearFind,
  findMatches,
  readFind,
  setFindQuery,
  stepFind,
} from "./find-in-note"
import { docToMarkdown, editorSchema, markdownToDoc } from "./markdown"
import { schemaExtensions } from "./schema"

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

const NOTE = [
  "# Finnish notes",
  "",
  "The word **talo** means house; Talo is also a name.",
  "",
  "- talossa",
  "- another item",
  "",
  "| word | meaning |",
  "| --- | --- |",
  "| talo | house |",
].join("\n")

function mount(markdown = NOTE): Editor {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [...schemaExtensions, FindInNote],
    content: markdownToDoc(markdown),
  })
  return editor
}

const found = (target: Editor) =>
  readFind(target.state).matches.map((match) => target.state.doc.textBetween(match.from, match.to))

describe("find in note", () => {
  it("finds every occurrence, whatever its case, in text, lists and tables", () => {
    const doc = editorSchema.nodeFromJSON(markdownToDoc(NOTE))
    const matches = findMatches(doc, "talo")
    expect(matches.map((match) => doc.textBetween(match.from, match.to))).toEqual([
      "talo",
      "Talo",
      "talo",
      "talo",
    ])
    expect(findMatches(doc, "")).toEqual([])
    expect(findMatches(doc, "absent")).toEqual([])
  })

  it("finds text that runs across bold and plain", () => {
    const doc = editorSchema.nodeFromJSON(markdownToDoc("The **wo**rd here"))
    const matches = findMatches(doc, "word")
    expect(matches).toHaveLength(1)
    expect(doc.textBetween(matches[0].from, matches[0].to)).toBe("word")
  })

  it("keeps positions right after an image inside the paragraph", () => {
    const doc = editorSchema.nodeFromJSON(markdownToDoc("Before ![a](x.png) after word"))
    const [match] = findMatches(doc, "word")
    expect(doc.textBetween(match.from, match.to)).toBe("word")
  })

  it("marks the matches and starts at the first one after the cursor", () => {
    const target = mount()
    // Into the list, past both matches of the paragraph.
    let inList = 0
    target.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "talossa") inList = pos
    })
    target.commands.setTextSelection(inList)
    setFindQuery(target.view, "talo")
    expect(found(target)).toHaveLength(4)
    expect(readFind(target.state).current).toBe(2)
    expect(target.view.dom.querySelectorAll(".amby-find-match")).toHaveLength(4)
    expect(target.view.dom.querySelector(".amby-find-current")?.textContent).toBe("talo")
  })

  it("steps forward and back around the ends", () => {
    const target = mount()
    target.commands.setTextSelection(1)
    setFindQuery(target.view, "talo")
    expect(readFind(target.state).current).toBe(0)
    stepFind(target.view, -1)
    expect(readFind(target.state).current).toBe(3)
    stepFind(target.view, 1)
    stepFind(target.view, 1)
    expect(readFind(target.state).current).toBe(1)
  })

  it("follows the note while it is edited and never changes it", () => {
    const target = mount()
    const before = docToMarkdown(target.state.doc)
    setFindQuery(target.view, "talo")
    stepFind(target.view, 1)
    expect(docToMarkdown(target.state.doc)).toBe(before)

    target.commands.insertContentAt(1, "talo ")
    expect(found(target)).toHaveLength(5)
    expect(found(target).every((text) => text.toLowerCase() === "talo")).toBe(true)
  })

  it("ends with the cursor at the current match and nothing marked", () => {
    const target = mount()
    target.commands.setTextSelection(1)
    setFindQuery(target.view, "talo")
    stepFind(target.view, 1)
    const at = readFind(target.state).matches[1].from
    clearFind(target.view)
    expect(readFind(target.state).matches).toEqual([])
    expect(target.view.dom.querySelector(".amby-find-match")).toBeNull()
    expect(target.state.selection.from).toBe(at)
    expect(target.state.selection.empty).toBe(true)
  })

  it("asks for the find bar on Mod-F", () => {
    const target = mount()
    let asked = 0
    target.view.dom.addEventListener(OPEN_FIND_EVENT, () => (asked += 1))
    const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true })
    target.view.someProp("handleKeyDown", (handler) => handler(target.view, event))
    expect(asked).toBe(1)
  })
})
