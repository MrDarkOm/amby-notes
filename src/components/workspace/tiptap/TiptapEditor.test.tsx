// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import type { Editor } from "@tiptap/core"
import { afterEach, expect, it, vi } from "vitest"
import {
  clearSourceRewriteSnapshots,
  pendingSourceRewriteSnapshot,
} from "../autosave/source-rewrite"
import { TiptapEditor } from "./TiptapEditor"

vi.mock("./BlockHandles", () => ({ BlockHandles: () => null }))
vi.mock("./BubbleToolbar", () => ({ BubbleToolbar: () => null }))
vi.mock("./BlockInsertPanel", () => ({ BlockInsertPanel: () => null }))
vi.mock("./WikiLinkContextMenu", () => ({ WikiLinkContextMenu: () => null }))

afterEach(() => {
  cleanup()
  clearSourceRewriteSnapshots()
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

// A note with text the editor would spell differently is opened in Live Preview. Its
// blocks keep their source; the first edit that is published asks for a history
// snapshot of the file about to be replaced, once per loaded text.
async function typeInto(value: string, noteId: string | undefined, text: string, at: number) {
  vi.useFakeTimers()
  const onChange = vi.fn()
  const { container, rerender } = render(
    <TiptapEditor value={value} onChange={onChange} noteId={noteId} />,
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  const editable = container.querySelector<HTMLElement>(".ProseMirror")!
  const editor = (editable as HTMLElement & { editor: Editor }).editor
  const type = async (typed: string, position: number) => {
    act(() => {
      editor.view.focus()
      editor.commands.setTextSelection(position)
      fireEvent.keyDown(editable, { key: "x" })
      editor.commands.insertContent(typed)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
  }
  await type(text, at)
  return { onChange, type, rerender }
}

it("asks for a history snapshot before the first save that may rewrite a block's source", async () => {
  const source = "* * *\n\n1) one\n2) two\n\ntail"
  const { onChange, type } = await typeInto(source, "note-1", "!", 7)
  // Only the edited list is rewritten; the rule and the paragraph keep their bytes.
  expect(onChange).toHaveBeenLastCalledWith("* * *\n\n1. one!\n2. two\n\ntail")
  const request = pendingSourceRewriteSnapshot("note-1")
  expect(request).not.toBeNull()

  // Later edits of the same loaded text do not ask again.
  clearSourceRewriteSnapshots()
  await type("?", 7)
  expect(onChange).toHaveBeenCalledTimes(2)
  expect(pendingSourceRewriteSnapshot("note-1")).toBeNull()
})

it("asks again after the note is loaded anew", async () => {
  const source = "* * *\n\ntail"
  const { type, rerender, onChange } = await typeInto(source, "note-1", "!", 4)
  expect(pendingSourceRewriteSnapshot("note-1")).not.toBeNull()
  clearSourceRewriteSnapshots()
  rerender(<TiptapEditor value={"___\n\nother"} onChange={onChange} noteId="note-1" />)
  await type("!", 4)
  expect(pendingSourceRewriteSnapshot("note-1")).not.toBeNull()
})

it("does not ask for a snapshot when the note is already in the editor's own form", async () => {
  const { onChange } = await typeInto("---\n\n1. one\n2. two\n\ntail", "note-1", "!", 7)
  expect(onChange).toHaveBeenLastCalledWith("---\n\n1. one!\n2. two\n\ntail")
  expect(pendingSourceRewriteSnapshot("note-1")).toBeNull()
})
