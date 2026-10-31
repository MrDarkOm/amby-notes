// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { Composer } from "./composer"
import type { Chat } from "@/lib/storage"

const chat: Chat = {
  version: 1,
  id: "c",
  title: "T",
  createdAt: "2026-10-30T00:00:00Z",
  updatedAt: "2026-10-30T00:00:00Z",
  modelId: "m",
  searchEnabled: false,
  autoCurrent: true,
  context: [{ kind: "current", id: "note" }],
  messages: [],
}

function show(overrides: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const props: React.ComponentProps<typeof Composer> = {
    chat,
    flat: [{ id: "note", path: "/v/Note.md", name: "Note.md", type: "file" }],
    openDocs: { note: { title: "Note", content: "x" } },
    truncated: [],
    vault: "/v",
    currentDoc: { title: "Note", content: "x" },
    input: "",
    loading: false,
    switching: false,
    tools: true,
    mentionOpen: false,
    choices: [],
    models: [
      {
        value: "m",
        label: "Terra",
        providerId: "codex",
        providerLabel: "Codex (ChatGPT)",
        kind: "cloud",
      },
      { value: "n", label: "Home", providerId: "ollama", providerLabel: "Ollama", kind: "local" },
    ],
    activeModelId: "m",
    onChangeChat: vi.fn(),
    onAddCurrent: vi.fn(),
    onInput: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onPickMention: vi.fn(),
    onModel: vi.fn(),
    onManage: vi.fn(),
    ...overrides,
  }
  render(<Composer {...props} />)
  return props
}

const before = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

afterEach(cleanup)

describe("Composer layout", () => {
  it("puts the context chip and the search switch above the message line", () => {
    show()
    const field = screen.getByPlaceholderText("Сообщение…")
    const chipRemove = screen.getByRole("button", { name: "Убрать заметку из контекста" })
    const search = screen.getByRole("checkbox", { name: /Поиск по хранилищу/ })
    expect(before(chipRemove, field)).toBe(true)
    expect(before(search, field)).toBe(true)
  })

  it("keeps search, the note and the plus in one line outside the writing box, search first", () => {
    show()
    const field = screen.getByPlaceholderText("Сообщение…")
    const box = field.closest("[data-composer-box]")
    expect(box).not.toBeNull()
    const search = screen.getByRole("checkbox", { name: /Поиск по хранилищу/ })
    const chip = screen.getByRole("button", { name: "Убрать заметку из контекста" })
    const plus = screen.getByRole("button", { name: "Добавить заметку или папку" })
    for (const control of [search, chip, plus]) expect(box!.contains(control)).toBe(false)
    expect(before(search, chip)).toBe(true)
    expect(before(chip, plus)).toBe(true)
    const line = search.closest("[data-composer-line]")
    expect(line).not.toBeNull()
    expect(line!.contains(chip) && line!.contains(plus)).toBe(true)
    expect(line!.className).not.toContain("flex-wrap")
  })

  it("keeps the model and the send button below the message line", () => {
    show({ input: "hi" })
    const field = screen.getByPlaceholderText("Сообщение…")
    expect(before(field, screen.getByRole("button", { name: "Отправить" }))).toBe(true)
    expect(before(field, screen.getByLabelText("Активная модель"))).toBe(true)
  })

  it("has a plus that starts adding another note by typing @ at the end", () => {
    const props = show({ input: "Сравни" })
    fireEvent.click(screen.getByRole("button", { name: "Добавить заметку или папку" }))
    expect(props.onInput).toHaveBeenCalledWith("Сравни @")
  })

  it("does not double the space before @ and starts from nothing when the field is empty", () => {
    const withSpace = show({ input: "Сравни " })
    fireEvent.click(screen.getByRole("button", { name: "Добавить заметку или папку" }))
    expect(withSpace.onInput).toHaveBeenCalledWith("Сравни @")
    cleanup()
    const empty = show({ input: "" })
    fireEvent.click(screen.getByRole("button", { name: "Добавить заметку или папку" }))
    expect(empty.onInput).toHaveBeenCalledWith("@")
  })

  it("does not offer the plus while an answer is being written", () => {
    show({ loading: true })
    expect(screen.getByRole("button", { name: "Добавить заметку или папку" })).toHaveProperty(
      "disabled",
      true,
    )
  })

  it("shows the active model with its provider's mark on the closed control", () => {
    show()
    const closed = screen.getByRole("combobox", { name: "Активная модель" })
    expect(within(closed).getByRole("img", { name: "Codex (ChatGPT)" })).toBeTruthy()
    expect(closed.textContent).toContain("Terra")
  })

  it("opens the model list with the provider rail and leads to the model settings", async () => {
    const props = show()
    fireEvent.click(screen.getByRole("combobox", { name: "Активная модель" }))
    const tabs = await screen.findAllByRole("tab")
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual(["Codex (ChatGPT)", "Ollama"])
    fireEvent.click(screen.getByRole("button", { name: "Управлять моделями" }))
    expect(props.onManage).toHaveBeenCalledOnce()
  })

  it("anchors the model list to the whole composer, so it spans the panel above it", async () => {
    show()
    fireEvent.click(screen.getByRole("combobox", { name: "Активная модель" }))
    const content = (await screen.findByRole("listbox")).closest("[data-popover-content]")!
    expect(content.className).toContain("w-[var(--radix-popover-trigger-width)]")
  })
})
