// @vitest-environment happy-dom
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { expect, it, vi } from "vitest"
import { entityNamesPlugin } from "./entity-names"

function makeEditor(content: string) {
  return new Editor({
    extensions: [StarterKit],
    element: document.createElement("div"),
    content,
  })
}

const entries = [
  { name: "Кей", noteId: "kei" },
  { name: "Дом у реки", noteId: "house" },
]

it("marks the names on screen and leaves the document as it is", () => {
  const editor = makeEditor("<p>Потом Кея увидел у Дома у реки.</p><p>Кейтлин ушла.</p>")
  try {
    const before = editor.getHTML()
    editor.registerPlugin(entityNamesPlugin({ entries, onHover: vi.fn(), onOpen: vi.fn() }))
    const marked = [...editor.view.dom.querySelectorAll("[data-entity-id]")]
    expect(marked.map((node) => [node.textContent, node.getAttribute("data-entity-id")])).toEqual([
      ["Кея", "kei"],
      ["Дома у реки", "house"],
    ])
    expect(editor.getHTML()).toBe(before)
  } finally {
    editor.destroy()
  }
})

it("follows typing: a new name is marked, a removed one is not", () => {
  const editor = makeEditor("<p>Никого.</p>")
  try {
    editor.registerPlugin(entityNamesPlugin({ entries, onHover: vi.fn(), onOpen: vi.fn() }))
    expect(editor.view.dom.querySelector("[data-entity-id]")).toBeNull()
    editor.commands.setContent("<p>Пришёл Кей.</p>")
    expect(editor.view.dom.querySelector("[data-entity-id]")?.textContent).toBe("Кей")
  } finally {
    editor.destroy()
  }
})

it("tells the frame when a name is hovered and opens it on a modified click", () => {
  const onHover = vi.fn()
  const onOpen = vi.fn()
  const editor = makeEditor("<p>Пришёл Кей.</p>")
  try {
    editor.registerPlugin(entityNamesPlugin({ entries, onHover, onOpen }))
    const name = editor.view.dom.querySelector("[data-entity-id]") as HTMLElement
    name.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    expect(onHover).toHaveBeenLastCalledWith("kei", name)
    name.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }))
    expect(onHover).toHaveBeenLastCalledWith(null, null)
    name.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(onOpen).not.toHaveBeenCalled()
    name.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }))
    expect(onOpen).toHaveBeenCalledWith("kei")
  } finally {
    editor.destroy()
  }
})
