// @vitest-environment happy-dom
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { expect, it } from "vitest"
import { headingHintsPlugin } from "./heading-hints"
import { notePagesPlugin, setNotePages } from "./note-pages"

it("decorates only empty sections and keeps the hint out of the document", () => {
  const editor = new Editor({
    extensions: [StarterKit],
    element: document.createElement("div"),
    content: "<h2>Details</h2><p></p><h2>History</h2><p>Some text.</p><h2>Appearance</h2>",
  })
  try {
    editor.registerPlugin(
      headingHintsPlugin(
        new Map([
          ["Details", "Age and habits"],
          ["History", "The past"],
          ["Appearance", "How they look"],
        ]),
      ),
    )
    expect(editor.view.dom.textContent).toContain("Age and habits")
    expect(editor.view.dom.textContent).toContain("How they look")
    expect(editor.view.dom.textContent).not.toContain("The past")
    expect(editor.getHTML()).not.toContain("Age and habits")
    editor.commands.setContent("<h2>Details</h2><p>Age 27</p>")
    expect(editor.view.dom.textContent).not.toContain("Age and habits")
  } finally {
    editor.destroy()
  }
})

it("shows one invitation on an empty note page: the section's hint instead of the generic line", () => {
  const hints = new Map([["History", "The past"]])
  const editor = new Editor({
    extensions: [StarterKit],
    element: document.createElement("div"),
    // The last page is not empty: the editor keeps a paragraph after a closing heading.
    content: "<h2>Details</h2><p>Age 27</p><h2>History</h2><h2>Other</h2><h2>End</h2><p>x</p>",
  })
  try {
    editor.registerPlugin(notePagesPlugin("top", "Start writing", hints))
    editor.registerPlugin(headingHintsPlugin(hints))
    // The page of a heading with a hint shows that hint once, as the empty page's line.
    setNotePages(editor, true, 1)
    const text = editor.view.dom.textContent ?? ""
    expect(text.split("The past")).toHaveLength(2)
    expect(text).not.toContain("Start writing")
    expect(editor.view.dom.querySelector("[data-note-page-empty]")?.textContent).toBe("The past")
    // A heading without a hint keeps the generic line.
    setNotePages(editor, true, 2)
    expect(editor.view.dom.querySelector("[data-note-page-empty]")?.textContent).toBe(
      "Start writing",
    )
    // Without pages the hint stays under its heading.
    setNotePages(editor, false)
    expect((editor.view.dom.textContent ?? "").split("The past")).toHaveLength(2)
    expect(editor.getHTML()).not.toContain("The past")
  } finally {
    editor.destroy()
  }
})
