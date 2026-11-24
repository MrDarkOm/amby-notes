// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Editor } from "@tiptap/core"
import { afterEach, expect, it, vi } from "vitest"
import { NotePagesSlotContext } from "../editor/note-pages-context"
import { useConfirmStore } from "@/lib/confirm"
import {
  clearSourceRewriteSnapshots,
  pendingSourceRewriteSnapshot,
} from "../autosave/source-rewrite"
import { TiptapEditor } from "./TiptapEditor"
import { markEditorUserIntent } from "./editor-user-intent"
import { flushEditorSerializations } from "./editor-serialization-lifecycle"
import type { EditorHandle } from "./constants"

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

// EDIT-02: block controls (the grip menu: delete, duplicate, turn into, colours) are clicked with the
// mouse outside the editor's DOM, so no key or ProseMirror pointer event marks the change as the
// person's. Their change must still be saved; a change nobody asked for must still not be written.
it("saves a change made through block controls with the mouse only", async () => {
  vi.useFakeTimers()
  const onChange = vi.fn()
  const { container } = render(<TiptapEditor value={"First\n\nSecond"} onChange={onChange} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  const editor = (container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor })
    .editor
  const firstBlockEnd = editor.state.doc.firstChild!.nodeSize

  // A change without the person: no write.
  act(() => {
    editor.view.dispatch(editor.state.tr.insertText("!", 1))
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(onChange).not.toHaveBeenCalled()

  // The person deletes the first block from the block menu.
  act(() => {
    markEditorUserIntent(editor)
    editor.view.dispatch(editor.state.tr.delete(0, firstBlockEnd + 1))
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(onChange).toHaveBeenCalledWith("Second")
})

// Serialization lifecycle (EDIT-05): the path "edit -> deferred serialization -> onChange -> flush
// on blur, unmount, window lifecycle or an explicit handle call" is pinned here, so it can move
// out of the component without changing.
async function mountEdited(
  onChange = vi.fn(),
  extra: Partial<React.ComponentProps<typeof TiptapEditor>> = {},
) {
  vi.useFakeTimers()
  const utils = render(<TiptapEditor value="Original text" onChange={onChange} {...extra} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  const editable = utils.container.querySelector<HTMLElement>(".ProseMirror")!
  const editor = (editable as HTMLElement & { editor: Editor }).editor
  const edit = (text = "x") =>
    act(() => {
      editor.view.focus()
      editor.commands.setTextSelection(5)
      fireEvent.keyDown(editable, { key: "x" })
      editor.commands.insertContent(text)
    })
  return { ...utils, editable, editor, edit, onChange }
}

it("publishes an edit only after the debounce, and reports the dirty state at once", async () => {
  const onContentDirty = vi.fn()
  const { edit, onChange } = await mountEdited(vi.fn(), { onContentDirty })
  edit()
  expect(onContentDirty).toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onChange).toHaveBeenCalledWith("Origxinal text")
})

it("flushes a pending edit when the editor loses focus", async () => {
  const { edit, editor, onChange } = await mountEdited()
  edit()
  expect(onChange).not.toHaveBeenCalled()
  act(() => {
    editor.emit("blur", { editor, event: new FocusEvent("blur"), transaction: editor.state.tr })
  })
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onChange).toHaveBeenCalledWith("Origxinal text")
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(onChange).toHaveBeenCalledTimes(1)
})

it("flushes a pending edit when the editor unmounts", async () => {
  const { edit, unmount, onChange } = await mountEdited()
  edit()
  expect(onChange).not.toHaveBeenCalled()
  unmount()
  expect(onChange).toHaveBeenCalledWith("Origxinal text")
})

it("flushes through the lifecycle registry before autosave and through the editor handle", async () => {
  const handle = { current: undefined as unknown as EditorHandle }
  const { edit, onChange } = await mountEdited(vi.fn(), { editorRef: handle })
  edit()
  flushEditorSerializations()
  expect(onChange).toHaveBeenCalledTimes(1)
  edit("y")
  handle.current!.flush()
  expect(onChange).toHaveBeenCalledTimes(2)
  // Nothing pending: another flush writes nothing.
  flushEditorSerializations()
  expect(onChange).toHaveBeenCalledTimes(2)
})

it("never writes for an untouched editor, and reports it clean when an edit round-trips", async () => {
  const onContentClean = vi.fn()
  const { editor, edit, onChange } = await mountEdited(vi.fn(), { onContentClean })
  flushEditorSerializations()
  expect(onChange).not.toHaveBeenCalled()
  edit("x")
  act(() => {
    editor.commands.undo()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(onChange).not.toHaveBeenCalled()
  expect(onContentClean).toHaveBeenCalled()
})

it("drops a pending edit when an external value replaces the text", async () => {
  const { edit, rerender, onChange, editor } = await mountEdited()
  edit()
  rerender(<TiptapEditor value="Loaded from disk" onChange={onChange} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(editor.getText()).toBe("Loaded from disk")
  flushEditorSerializations()
  expect(onChange).not.toHaveBeenCalled()
})

it("stops flushing through the registry after unmount", async () => {
  const { unmount, onChange } = await mountEdited()
  unmount()
  flushEditorSerializations()
  expect(onChange).not.toHaveBeenCalled()
})

it("switches H1 pages without saving, preserves other source bytes, and remembers the view", async () => {
  vi.useFakeTimers()
  const value = "# Details\n\n* * *\n\n# Media\n\nDraft"
  const onChange = vi.fn()
  const props = {
    value,
    onChange,
    notePages: { mode: "flagged", flag: true } as const,
    noteId: "pages-test",
    vaultPath: "/pages-test",
  }
  const { container, unmount } = render(<TiptapEditor {...props} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  const editable = container.querySelector<HTMLElement>(".ProseMirror")!
  const editor = (editable as HTMLElement & { editor: Editor }).editor
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Media" }), { button: 0 })
  expect(screen.getByRole("tab", { name: "Media" }).getAttribute("aria-selected")).toBe("true")
  expect(container.querySelector(".ProseMirror")).toBe(editable)
  expect(onChange).not.toHaveBeenCalled()
  expect(editable.querySelector("[data-note-page-hidden]")?.textContent).toBe("Details")

  act(() => {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    fireEvent.keyDown(editable, { key: "!" })
    editor.commands.insertContent("!")
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(onChange).toHaveBeenLastCalledWith(value + "!")
  unmount()

  const second = render(<TiptapEditor {...props} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  expect(screen.getByRole("tab", { name: "Details" })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Вся заметка" }))
  expect(screen.queryByRole("tab", { name: "Details" })).toBeNull()
  second.unmount()

  render(<TiptapEditor {...props} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  expect(screen.queryByRole("tab", { name: "Details" })).toBeNull()
  expect(screen.getByRole("button", { name: "Показать страницы" })).toBeTruthy()
  localStorage.removeItem('amby:note-pages:v1:["/pages-test","pages-test"]')
})

it("offers no pages when the setting or the note does not ask for them", async () => {
  vi.useFakeTimers()
  const value = "# Details\n\nA\n\n# Media\n\nB"
  for (const notePages of [
    { mode: "off", flag: true },
    { mode: "flagged", flag: null },
    { mode: "always", flag: false },
  ] as const) {
    const { unmount } = render(
      <TiptapEditor value={value} onChange={vi.fn()} notePages={notePages} noteId="no-pages" />,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(screen.queryByRole("tab")).toBeNull()
    expect(screen.queryByRole("button", { name: "Показать страницы" })).toBeNull()
    unmount()
  }
})

it("puts the pages switch into the title row slot when the note offers one", async () => {
  vi.useFakeTimers()
  const slot = document.createElement("div")
  document.body.append(slot)
  render(
    <NotePagesSlotContext.Provider value={slot}>
      <TiptapEditor
        value={"# Details\n\nA\n\n# Media\n\nB"}
        onChange={vi.fn()}
        notePages={{ mode: "always", flag: null }}
        noteId="slot-test"
      />
    </NotePagesSlotContext.Provider>,
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  expect(slot.querySelector("button")?.textContent).toBe("Вся заметка")
  fireEvent.click(slot.querySelector("button")!)
  expect(slot.querySelector("button")?.textContent).toBe("Показать страницы")
  slot.remove()
  localStorage.removeItem('amby:note-pages:v1:["","slot-test"]')
})

it("adds a page from the plus button and renames a page from its tab menu", async () => {
  vi.useFakeTimers()
  const onChange = vi.fn()
  const { container } = render(
    <TiptapEditor
      value={"# Goals\n\nA\n\n# Plans\n\nB"}
      onChange={onChange}
      notePages={{ mode: "always", flag: null }}
      noteId="add-rename-test"
    />,
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  // Tabs carry no page icon.
  expect(screen.getByRole("tab", { name: "Goals" }).querySelector("svg")).toBeNull()

  fireEvent.pointerDown(screen.getByRole("button", { name: "Добавить" }), {
    button: 0,
    ctrlKey: false,
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  fireEvent.click(screen.getByRole("menuitem", { name: "Добавить страницу" }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  // The new page opens with its name ready to type.
  const field = screen.getByRole("textbox", { name: "Название страницы" }) as HTMLInputElement
  expect(field.value).toBe("Страница 3")
  fireEvent.change(field, { target: { value: "Ideas" } })
  fireEvent.keyDown(field, { key: "Enter" })
  expect(screen.getByRole("tab", { name: "Ideas" }).getAttribute("aria-selected")).toBe("true")

  fireEvent.contextMenu(screen.getByRole("tab", { name: "Goals" }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  fireEvent.click(screen.getByRole("menuitem", { name: "Переименовать" }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  const rename = screen.getByRole("textbox", { name: "Название страницы" }) as HTMLInputElement
  expect(rename.value).toBe("Goals")
  fireEvent.change(rename, { target: { value: "Aims" } })
  fireEvent.keyDown(rename, { key: "Enter" })
  expect(screen.getByRole("tab", { name: "Aims" })).toBeTruthy()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(onChange).toHaveBeenLastCalledWith("# Aims\n\nA\n\n# Plans\n\nB\n\n# Ideas")
  expect(container.querySelector(".ProseMirror")).toBeTruthy()
  localStorage.removeItem('amby:note-pages:v1:["","add-rename-test"]')
})

it("deletes a page from its tab menu after asking, keeping the text when asked to move it", async () => {
  vi.useFakeTimers()
  const onChange = vi.fn()
  render(
    <TiptapEditor
      value={"# Goals\n\nA\n\n# Plans\n\nB"}
      onChange={onChange}
      notePages={{ mode: "always", flag: null }}
      noteId="delete-page-test"
    />,
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  fireEvent.contextMenu(screen.getByRole("tab", { name: "Plans" }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  fireEvent.click(screen.getByRole("menuitem", { name: "Удалить страницу" }))
  const question = useConfirmStore.getState().queue[0]
  expect(question.title).toBe("Удалить страницу «Plans»?")
  expect([question.confirmLabel, question.alternativeLabel]).toEqual(["Удалить всё", "Перенести"])
  await act(async () => {
    useConfirmStore.getState().settle(question.id, "alternative")
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(onChange).toHaveBeenLastCalledWith("# Goals\n\nA\n\nB")
  localStorage.removeItem('amby:note-pages:v1:["","delete-page-test"]')
})

it("offers a page or a database view from the plus menu and lets a new page be taken back", async () => {
  vi.useFakeTimers()
  const onChange = vi.fn()
  render(
    <TiptapEditor
      value={"# Goals\n\nA\n\n# Plans\n\nB"}
      onChange={onChange}
      notePages={{ mode: "always", flag: null }}
      noteId="plus-menu-test"
    />,
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  const open = async () => {
    fireEvent.pointerDown(screen.getByRole("button", { name: "Добавить" }), {
      button: 0,
      ctrlKey: false,
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })
  }
  await open()
  expect(screen.getByRole("menuitem", { name: "Добавить представление базы" })).toBeTruthy()
  fireEvent.click(screen.getByRole("menuitem", { name: "Добавить страницу" }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
  const field = screen.getByRole("textbox", { name: "Название страницы" })
  expect(screen.getByRole("tab", { name: "Goals" })).toBeTruthy()
  // Escape while naming a page just added takes the page back.
  fireEvent.keyDown(field, { key: "Escape" })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(screen.queryByRole("textbox", { name: "Название страницы" })).toBeNull()
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Goals", "Plans"])
  const saved = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0]
  expect(saved === undefined || saved === "# Goals\n\nA\n\n# Plans\n\nB").toBe(true)
  localStorage.removeItem('amby:note-pages:v1:["","plus-menu-test"]')
})
