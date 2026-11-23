// @vitest-environment happy-dom
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { expect, it } from "vitest"
import { headingHintsPlugin } from "./heading-hints"

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
