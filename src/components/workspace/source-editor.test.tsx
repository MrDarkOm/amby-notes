// @vitest-environment happy-dom
import * as React from "react"
import { act, cleanup, render } from "@testing-library/react"
import { EditorView } from "@codemirror/view"
import { afterEach, expect, it, vi } from "vitest"
import { SourceEditor } from "./source-editor"
import { flushAutosaveGeneration } from "./autosave/autosave-lifecycle"
import type { EditorHandle } from "./tiptap/constants"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it("publishes pending Source text during a global flush without blur", async () => {
  vi.useFakeTimers()
  const onChange = vi.fn()
  const editorRef = React.createRef<EditorHandle>() as React.RefObject<EditorHandle>
  const { container } = render(
    <SourceEditor value="original" onChange={onChange} editorRef={editorRef} />,
  )
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!
  act(() =>
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "latest unsaved source" },
    }),
  )
  expect(onChange).not.toHaveBeenCalled()

  await act(async () => {
    await flushAutosaveGeneration(71)
  })
  expect(onChange).toHaveBeenCalledWith("latest unsaved source")
})

it("Tab types a tab character and Shift+Tab takes it back", () => {
  const { container } = render(<SourceEditor value="word" onChange={vi.fn()} />)
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!
  view.focus()
  act(() => view.dispatch({ selection: { anchor: 0 } }))
  const press = (shiftKey: boolean) =>
    act(() => {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", code: "Tab", shiftKey, bubbles: true }),
      )
    })
  press(false)
  expect(view.state.doc.toString()).toBe("\tword")
  press(true)
  expect(view.state.doc.toString()).toBe("word")
})

it("keeps the same editor, its text and its history when the lock changes", () => {
  const props = { value: "text", onChange: vi.fn() }
  const { container, rerender } = render(<SourceEditor {...props} editable={false} />)
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!
  expect(view.state.readOnly).toBe(true)

  rerender(<SourceEditor {...props} editable />)
  expect(EditorView.findFromDOM(container.querySelector(".cm-editor")!)).toBe(view)
  expect(view.state.readOnly).toBe(false)
  expect(view.contentDOM.getAttribute("contenteditable")).toBe("true")

  act(() => view.dispatch({ changes: { from: 4, insert: " typed" } }))
  rerender(<SourceEditor {...props} editable={false} />)
  expect(EditorView.findFromDOM(container.querySelector(".cm-editor")!)).toBe(view)
  expect(view.state.readOnly).toBe(true)
  expect(view.state.doc.toString()).toBe("text typed")
})
