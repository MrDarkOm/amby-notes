// @vitest-environment happy-dom
import { Editor } from "@tiptap/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"

const calls = vi.hoisted(() => ({
  fetchPageInfo:
    vi.fn<(address: string) => Promise<{ title: string; description: string | null }>>(),
  openWebAddress: vi.fn<(address: string) => Promise<void>>(),
  showErrorMessage: vi.fn<(message: string) => Promise<void>>(),
}))

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  ...calls,
  isTauri: () => true,
}))

import { BookmarkCards } from "./bookmark-card"
import { docToMarkdown, markdownToDoc } from "./markdown"
import { schemaExtensions } from "./schema"

const NOTE = 'Before\n\n[example.com](https://example.com/a "example.com")\n\nAfter\n'
const editors: Editor[] = []

function open(markdown = NOTE) {
  const element = document.createElement("div")
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [...schemaExtensions, BookmarkCards],
    content: markdownToDoc(markdown),
  })
  editors.push(editor)
  const buttons = () =>
    Array.from(editor.view.dom.querySelectorAll<HTMLButtonElement>(".amby-bookmark-actions button"))
  return { editor, buttons }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
  document.body.innerHTML = ""
  vi.clearAllMocks()
})

describe("the buttons of a bookmark card", () => {
  it("offers Open and Fetch title on a card", () => {
    const { buttons } = open()
    expect(buttons().map((button) => button.textContent)).toEqual([
      "Открыть",
      "Подтянуть заголовок",
    ])
  })

  it("opens the address of the link it stands in, whatever the note says elsewhere", async () => {
    calls.openWebAddress.mockResolvedValue()
    const { buttons } = open(`${NOTE}\n[other](https://other.example/ "x")\n`)
    buttons()[0].click()
    await settle()
    expect(calls.openWebAddress).toHaveBeenCalledWith("https://example.com/a")
  })

  it("puts the title and the description of the page into the note, once per press", async () => {
    let answer!: (value: { title: string; description: string | null }) => void
    calls.fetchPageInfo.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const { editor, buttons } = open()
    const fetchButton = buttons()[1]
    fetchButton.click()
    fetchButton.click()
    fetchButton.click()
    expect(fetchButton.disabled).toBe(true)
    answer({ title: "The  Page\n[x](http://evil)", description: "What it is <b>about</b>" })
    await settle()
    expect(calls.fetchPageInfo).toHaveBeenCalledTimes(1)
    expect(calls.fetchPageInfo).toHaveBeenCalledWith("https://example.com/a")
    expect(docToMarkdown(editor.state.doc)).toBe(
      'Before\n\n[The Page (x)(http://evil)](https://example.com/a "What it is <b>about</b>")\n\nAfter',
    )
    expect(editor.state.doc.childCount).toBe(3)
    expect(fetchButton.disabled).toBe(false)
  })

  it("leaves the note alone and says why when the page is refused", async () => {
    calls.fetchPageInfo.mockRejectedValue(new Error("PrivateAddress"))
    calls.showErrorMessage.mockResolvedValue()
    const { editor, buttons } = open()
    const before = docToMarkdown(editor.state.doc)
    buttons()[1].click()
    await settle()
    expect(docToMarkdown(editor.state.doc)).toBe(before)
    expect(calls.showErrorMessage).toHaveBeenCalledTimes(1)
    expect(calls.showErrorMessage.mock.calls[0][0]).toMatch(/локальной сети/u)
  })

  it("does not write the answer into text that was edited while it was on its way", async () => {
    let answer!: (value: { title: string; description: string | null }) => void
    calls.fetchPageInfo.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const { editor, buttons } = open()
    buttons()[1].click()
    // The person renames the link before the answer arrives.
    const start = editor.state.doc.child(0).nodeSize + 1
    editor.view.dispatch(editor.state.tr.insertText("my ", start))
    expect(editor.state.doc.child(1).textContent).toBe("my example.com")
    const edited = docToMarkdown(editor.state.doc)
    answer({ title: "New", description: null })
    await settle()
    expect(docToMarkdown(editor.state.doc)).toBe(edited)
  })
})
