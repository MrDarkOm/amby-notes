// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import type { Editor } from "@tiptap/core"
import { afterEach, expect, it, vi } from "vitest"
import { TiptapEditor } from "./TiptapEditor"

vi.mock("./BlockHandles", () => ({ BlockHandles: () => null }))
vi.mock("./BubbleToolbar", () => ({ BubbleToolbar: () => null }))
vi.mock("./BlockInsertPanel", () => ({ BlockInsertPanel: () => null }))
vi.mock("./WikiLinkContextMenu", () => ({ WikiLinkContextMenu: () => null }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it("keeps the Live editor, caret and undo history when autosave rerenders its parent", async () => {
  vi.useFakeTimers()
  const onChange = vi.fn()
  const props = { value: "Original text", onChange }
  const { container, rerender } = render(<TiptapEditor {...props} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  const editable = container.querySelector<HTMLElement>(".ProseMirror")!
  const editor = (editable as HTMLElement & { editor: Editor }).editor
  act(() => {
    editor.view.focus()
    editor.commands.setTextSelection(5)
    fireEvent.keyDown(editable, { key: "x" })
    editor.commands.insertContent("x")
  })
  const selection = editor.state.selection.from
  const setOptions = vi.spyOn(editor, "setOptions")

  // Revision, modified timestamp and properties change parent props after a
  // save. Its Markdown value is still the editor's last published text.
  rerender(<TiptapEditor {...props} onChange={(text) => onChange(text)} />)
  expect(setOptions).not.toHaveBeenCalled()
  expect(container.querySelector(".ProseMirror")).toBe(editable)
  expect(document.activeElement).toBe(editable)
  expect(editor.state.selection.from).toBe(selection)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(onChange).toHaveBeenCalledWith("Origxinal text")
  rerender(<TiptapEditor {...props} value="Origxinal text" />)
  expect(document.activeElement).toBe(editable)
  expect(editor.state.selection.from).toBe(selection)
  act(() => {
    editor.commands.insertContent("y")
  })
  expect(editor.getText()).toBe("Origxyinal text")
  act(() => {
    editor.commands.undo()
  })
  expect(editor.getText()).toBe("Original text")
})

it("still applies external text and Live/Read changes to the mounted editor", async () => {
  vi.useFakeTimers()
  const onChange = vi.fn()
  const { container, rerender } = render(<TiptapEditor value="Original text" onChange={onChange} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  const editable = container.querySelector<HTMLElement>(".ProseMirror")!
  const editor = (editable as HTMLElement & { editor: Editor }).editor
  rerender(<TiptapEditor value="Loaded from disk" onChange={onChange} editable={false} />)
  expect(editor.getText()).toBe("Loaded from disk")
  expect(editor.isEditable).toBe(false)
  expect(onChange).not.toHaveBeenCalled()

  rerender(<TiptapEditor value="Loaded from disk" onChange={onChange} />)
  expect(container.querySelector(".ProseMirror")).toBe(editable)
  expect(editor.isEditable).toBe(true)
})
