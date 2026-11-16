// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react"
import { Editor } from "@tiptap/core"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import "@/lib/i18n"
import {
  clearSourceRewriteSnapshots,
  pendingSourceRewriteSnapshot,
} from "../autosave/source-rewrite"
import { flushEditorSerializations } from "./editor-serialization-lifecycle"
import { markEditorUserIntent } from "./editor-user-intent"
import { buildExtensions } from "./extensions"
import { markdownToDoc } from "./markdown"
import {
  SERIALIZE_DEBOUNCE_MS,
  useEditorSerialization,
  useEditorSerializationLifecycle,
  type EditorSerialization,
} from "./use-editor-serialization"

const editors: Editor[] = []

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  for (const editor of editors.splice(0)) editor.destroy()
  clearSourceRewriteSnapshots()
  vi.useRealTimers()
})

function setup(value: string, noteId?: string) {
  const onChange = vi.fn()
  const onContentDirty = vi.fn()
  const onContentClean = vi.fn()
  const hook = renderHook(
    (props: { value: string }) => {
      const serialization = useEditorSerialization({
        value: props.value,
        noteId,
        onChange,
        onContentDirty,
        onContentClean,
      })
      return serialization
    },
    { initialProps: { value } },
  )
  const serialization = (): EditorSerialization => hook.result.current
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: buildExtensions({ placeholder: "Start", callbacks: { current: {} as never } }),
    content: markdownToDoc(value),
    onTransaction: ({ transaction }) => serialization().handleTransaction(transaction),
    onUpdate: ({ editor: ed, transaction }) => serialization().handleUpdate(ed, transaction),
  })
  editors.push(editor)
  const lifecycle = renderHook(() => useEditorSerializationLifecycle(editor, serialization()))
  const insert = (text: string, position = 2) =>
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText(text, position))
    })
  return {
    ...hook,
    editor,
    serialization,
    lifecycle,
    insert,
    onChange,
    onContentDirty,
    onContentClean,
  }
}

it("ignores a change nobody asked for, and writes after the person's intent", () => {
  const { serialization, insert, onChange, onContentDirty } = setup("Hello")
  insert("!")
  vi.advanceTimersByTime(SERIALIZE_DEBOUNCE_MS + 50)
  expect(onContentDirty).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()

  serialization().markUserIntent()
  insert("?")
  expect(onContentDirty).toHaveBeenCalledTimes(1)
  expect(onChange).not.toHaveBeenCalled()
  vi.advanceTimersByTime(SERIALIZE_DEBOUNCE_MS + 50)
  expect(onChange).toHaveBeenCalledTimes(1)
  // The unrequested "!" was part of the document by then, so it is published with the edit.
  expect(onChange).toHaveBeenCalledWith("H?!ello")
})

it("treats a uiEvent or pointer transaction as the person's", () => {
  const { editor, onChange } = setup("Hello")
  act(() => {
    editor.view.dispatch(editor.state.tr.insertText("!", 2).setMeta("uiEvent", "paste"))
  })
  vi.advanceTimersByTime(SERIALIZE_DEBOUNCE_MS + 50)
  expect(onChange).toHaveBeenCalledWith("H!ello")
})

it("restarts the debounce on every edit and publishes once", () => {
  const { serialization, insert, onChange } = setup("Hello")
  serialization().markUserIntent()
  insert("a")
  vi.advanceTimersByTime(SERIALIZE_DEBOUNCE_MS - 50)
  insert("b")
  vi.advanceTimersByTime(SERIALIZE_DEBOUNCE_MS - 50)
  expect(onChange).not.toHaveBeenCalled()
  vi.advanceTimersByTime(100)
  expect(onChange).toHaveBeenCalledTimes(1)
})

it("flush publishes immediately, clears the timer, and a second flush writes nothing", () => {
  const { editor, serialization, insert, onChange } = setup("Hello")
  serialization().markUserIntent()
  insert("!")
  serialization().flush(editor)
  expect(onChange).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(SERIALIZE_DEBOUNCE_MS + 50)
  serialization().flush(editor)
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(serialization().currentValue()).toBe("H!ello")
})

it("does not flush a destroyed editor", () => {
  const { editor, serialization, insert, onChange } = setup("Hello")
  serialization().markUserIntent()
  insert("!")
  editor.destroy()
  serialization().flush(editor)
  expect(onChange).not.toHaveBeenCalled()
})

it("reports clean, and does not write, when the edit returns to the published text", () => {
  const { editor, serialization, onChange, onContentClean } = setup("Hello")
  serialization().markUserIntent()
  act(() => {
    editor.view.dispatch(editor.state.tr.insertText("!", 2))
    editor.view.dispatch(editor.state.tr.delete(2, 3))
  })
  vi.advanceTimersByTime(SERIALIZE_DEBOUNCE_MS + 50)
  expect(onChange).not.toHaveBeenCalled()
  expect(onContentClean).toHaveBeenCalledTimes(1)
})

it("asks for a history snapshot once per loaded text when a save may rewrite the source", () => {
  const { editor, serialization, insert, onChange } = setup("* * *\n\ntail", "note-1")
  serialization().markUserIntent()
  insert("!", 6)
  serialization().flush(editor)
  expect(onChange).toHaveBeenCalledWith("* * *\n\ntail!")
  expect(pendingSourceRewriteSnapshot("note-1")).not.toBeNull()
  clearSourceRewriteSnapshots()
  insert("?", 6)
  serialization().flush(editor)
  expect(pendingSourceRewriteSnapshot("note-1")).toBeNull()
})

it("acceptExternalValue forgets pending work and the person's intent", () => {
  const { editor, serialization, insert, onChange, rerender } = setup("Hello")
  serialization().markUserIntent()
  insert("!")
  expect(serialization().acceptExternalValue("Hello")).toBe(false)
  expect(serialization().acceptExternalValue("Loaded")).toBe(true)
  expect(serialization().currentValue()).toBe("Loaded")
  rerender({ value: "Loaded" })
  vi.advanceTimersByTime(SERIALIZE_DEBOUNCE_MS + 50)
  serialization().flush(editor)
  expect(onChange).not.toHaveBeenCalled()
  // The intent is gone too: a later change nobody asked for is not written.
  insert("?")
  vi.advanceTimersByTime(SERIALIZE_DEBOUNCE_MS + 50)
  expect(onChange).not.toHaveBeenCalled()
})

it("lets controls outside the editor mark the person's intent", () => {
  const { editor, insert, onChange } = setup("Hello")
  markEditorUserIntent(editor)
  insert("!")
  vi.advanceTimersByTime(SERIALIZE_DEBOUNCE_MS + 50)
  expect(onChange).toHaveBeenCalledWith("H!ello")
})

it("flushes through the lifecycle registry, and not after the lifecycle is torn down", () => {
  const { serialization, insert, onChange, lifecycle } = setup("Hello")
  serialization().markUserIntent()
  insert("!")
  flushEditorSerializations()
  expect(onChange).toHaveBeenCalledTimes(1)

  serialization().markUserIntent()
  insert("?")
  lifecycle.unmount()
  // Teardown flushes once (the unmount path), then the registry no longer reaches the editor.
  expect(onChange).toHaveBeenCalledTimes(2)
  insert("#")
  flushEditorSerializations()
  expect(onChange).toHaveBeenCalledTimes(2)
})

it("keeps a stable controller across renders", () => {
  const { serialization, rerender } = setup("Hello")
  const first = serialization()
  rerender({ value: "Hello" })
  expect(serialization()).toBe(first)
})
