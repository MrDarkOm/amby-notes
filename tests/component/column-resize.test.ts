// @vitest-environment happy-dom
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ColumnResize } from "@/components/workspace/tiptap/column-resize"
import { Column, ColumnSet } from "@/components/workspace/tiptap/columns-node"

describe("ColumnResize plugin lifecycle", () => {
  let editor: Editor | undefined
  let host: HTMLDivElement | undefined

  afterEach(() => {
    editor?.destroy()
    editor = undefined
    host?.remove()
    host = undefined
    vi.restoreAllMocks()
  })

  it.each(["mousemove", "pointermove"])(
    "destroy cancels pending %s work and removes the live session before pointer release",
    (moveType) => {
      host = document.createElement("div")
      document.body.appendChild(host)
      editor = new Editor({
        element: host,
        extensions: [StarterKit, Column, ColumnSet, ColumnResize],
        content: {
          type: "doc",
          content: [
            {
              type: "columnSet",
              attrs: { widths: "0.5000,0.5000" },
              content: ["Left", "Right"].map((text) => ({
                type: "column",
                content: [{ type: "paragraph", content: [{ type: "text", text }] }],
              })),
            },
            { type: "paragraph", content: [{ type: "text", text: "After columns" }] },
          ],
        },
      })
      const view = editor.view
      const initialDocument = view.state.doc
      const set = host.querySelector<HTMLElement>(".amby-column-set")!
      const columns = set.querySelectorAll<HTMLElement>(":scope > .amby-column")
      vi.spyOn(set, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 600, 100))
      vi.spyOn(columns[0], "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 280, 100))
      vi.spyOn(columns[1], "getBoundingClientRect").mockReturnValue(new DOMRect(420, 100, 280, 100))
      const addListener = vi.spyOn(document, "addEventListener")
      const removeListener = vi.spyOn(document, "removeEventListener")
      const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(123)
      const cancelFrame = vi.spyOn(window, "cancelAnimationFrame")
      const move = (type: string, clientX = 400) =>
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 120 })

      columns[1].dispatchEvent(move("mousemove"))
      expect(columns[1].classList.contains("is-resize-edge")).toBe(true)
      columns[1].dispatchEvent(move("mousedown"))

      expect(document.body.classList.contains("amby-resizing-columns")).toBe(true)
      expect(document.querySelector(".amby-column-resize-label")?.textContent).toBe("50% · 50%")
      expect(document.querySelector(".amby-column-resize-guide")).not.toBeNull()
      document.dispatchEvent(move(moveType, 460))
      expect(requestFrame).toHaveBeenCalledTimes(1)
      const sessionListeners = addListener.mock.calls.filter(([type]) =>
        ["mousemove", "mouseup", "pointermove", "pointerup", "pointercancel"].includes(type),
      )
      expect(sessionListeners).toHaveLength(5)
      const dispatch = vi.spyOn(view, "dispatch")

      editor.destroy()

      expect(cancelFrame).toHaveBeenCalledWith(123)
      for (const [type, listener] of sessionListeners) {
        expect(removeListener).toHaveBeenCalledWith(type, listener)
      }
      expect(document.body.classList.contains("amby-resizing-columns")).toBe(false)
      expect(document.querySelector(".amby-column-resize-label")).toBeNull()
      expect(document.querySelector(".amby-column-resize-guide")).toBeNull()
      expect(set.classList.contains("is-resizing")).toBe(false)
      expect(columns[0].classList.contains("is-resizing-before")).toBe(false)
      expect(columns[1].classList.contains("is-resizing-after")).toBe(false)
      expect(columns[1].classList.contains("is-resize-edge")).toBe(false)
      expect(view.dom.style.cursor).toBe("")
      expect(view.state.doc.eq(initialDocument)).toBe(true)

      for (const type of ["mousemove", "mouseup", "pointermove", "pointerup", "pointercancel"]) {
        document.dispatchEvent(move(type, 500))
      }
      expect(dispatch).not.toHaveBeenCalled()
      expect(requestFrame).toHaveBeenCalledTimes(1)
      editor.destroy()
      expect(cancelFrame).toHaveBeenCalledTimes(1)
    },
  )
})
