// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

  it("draws the search switch as the file tree icon the sidebar uses, not a magnifier", () => {
    show()
    const label = screen.getByRole("checkbox", { name: /Поиск по хранилищу/ }).closest("label")!
    expect(label.querySelector("svg.lucide-folder-tree")).not.toBeNull()
    expect(label.querySelector("svg.lucide-search")).toBeNull()
  })

  it("stretches the line: the tree at the left edge, the plus at the right edge, the note between", () => {
    show()
    const line = document.querySelector("[data-composer-line]")!
    const tree = screen.getByRole("checkbox", { name: /Поиск по хранилищу/ }).closest("label")!
    const plus = screen.getByRole("button", { name: "Добавить заметку или папку" })
    expect(line.firstElementChild).toBe(tree)
    expect(line.lastElementChild).toBe(plus)
    expect(line.className).toContain("w-full")
    const chip = screen.getByRole("button", { name: "Убрать заметку из контекста" }).parentElement!
    expect(chip.className).toContain("flex-1")
  })

  it("keeps the plus at the right edge when nothing is attached", () => {
    show({ chat: { ...chat, context: [], autoCurrent: false }, currentDoc: null })
    const line = document.querySelector("[data-composer-line]")!
    const plus = screen.getByRole("button", { name: "Добавить заметку или папку" })
    expect(line.lastElementChild).toBe(plus)
    expect(plus.previousElementSibling?.className).toContain("flex-1")
  })
})

describe("Attached notes", () => {
  const notes = ["Alpha", "Beta", "Gamma"]
  const many: Chat = {
    ...chat,
    autoCurrent: false,
    context: notes.map((_, index) => ({ kind: "note" as const, id: `n${index}` })),
  }
  const extras = {
    flat: notes.map((name, index) => ({
      id: `n${index}`,
      path: `/v/${name}.md`,
      name: `${name}.md`,
      type: "file" as const,
    })),
    openDocs: Object.fromEntries(
      notes.map((name, index) => [`n${index}`, { title: name, content: "x" }]),
    ),
    currentDoc: null,
  }
  const group = () => document.querySelector("[data-context-group]")!

  it("shows a single attached note in full, with its own remove button and no counter", () => {
    const one = { ...many, context: [many.context[0]] }
    const props = show({ chat: one, ...extras })
    expect(screen.getByText("Alpha")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Убрать заметку из контекста" }))
    expect(props.onChangeChat).toHaveBeenCalledWith({ ...one, context: [] })
    expect(screen.queryByText(/^\+\d/)).toBeNull()
  })

  it("pushes a lone note's remove cross to the right edge of the stretched chip", () => {
    const one = { ...many, context: [many.context[0]] }
    show({ chat: one, ...extras })
    const remove = screen.getByRole("button", { name: "Убрать заметку из контекста" })
    const chip = remove.parentElement!
    expect(chip.lastElementChild).toBe(remove)
    expect(screen.getByText("Alpha").className).toContain("flex-1")
  })

  it("stretches the group of many over the line, the counter at its right end", () => {
    show({ chat: many, ...extras })
    expect(group().className).toContain("flex-1")
    expect(group().lastElementChild?.textContent).toBe("+2")
  })

  it("shows only the first of many, with a counter for the rest", () => {
    show({ chat: many, ...extras })
    expect(screen.getByText("Alpha")).toBeTruthy()
    expect(screen.queryByText("Beta")).toBeNull()
    expect(screen.queryByText("Gamma")).toBeNull()
    expect(screen.getByText("+2")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Убрать заметку из контекста" })).toBeNull()
  })

  it("lists every attached note on hover, each with a button to detach it", async () => {
    const props = show({ chat: many, ...extras })
    fireEvent.mouseEnter(group())
    const list = await screen.findByRole("list", { name: "Прикреплённые заметки" })
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(notes)
    const removes = within(list).getAllByRole("button", { name: "Убрать заметку из контекста" })
    expect(removes).toHaveLength(3)
    fireEvent.click(removes[1])
    expect(props.onChangeChat).toHaveBeenCalledWith({
      ...many,
      context: [many.context[0], many.context[2]],
    })
  })

  describe("while the cursor moves", () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())
    const LIST = { name: "Прикреплённые заметки" }

    async function openList() {
      show({ chat: many, ...extras })
      await act(async () => {
        fireEvent.mouseEnter(group())
      })
      return screen.getByRole("list", LIST)
    }

    it("keeps the list open as long as the cursor is over the chip or over the list", async () => {
      const list = await openList()
      fireEvent.mouseLeave(group())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
      fireEvent.mouseEnter(list)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(screen.queryByRole("list", LIST)).not.toBeNull()
    })

    it("closes shortly after the cursor leaves both", async () => {
      const list = await openList()
      fireEvent.mouseLeave(group())
      fireEvent.mouseEnter(list)
      fireEvent.mouseLeave(list)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      expect(screen.queryByRole("list", LIST)).toBeNull()
    })
  })

  it("sizes the list exactly like the model list: the panel's whole width from its left edge", async () => {
    show({ chat: many, ...extras })
    const panel = document.querySelector("[data-composer-line]")!.parentElement!
    const rect = (left: number, width: number) =>
      ({
        left,
        width,
        right: left + width,
        top: 0,
        bottom: 20,
        height: 20,
        x: left,
        y: 0,
      }) as DOMRect
    panel.getBoundingClientRect = () => rect(100, 300)
    group().getBoundingClientRect = () => rect(140, 200)
    await act(async () => {
      fireEvent.mouseEnter(group())
    })
    const content = screen
      .getByRole("list", { name: "Прикреплённые заметки" })
      .closest<HTMLElement>("[data-popover-content]")!
    expect(content.style.width).toBe("300px")
    expect(content.getAttribute("data-align")).toBe("start")
  })

  it("does not open the list while an answer is being written, so nothing is detached then", () => {
    show({ chat: many, loading: true, ...extras })
    fireEvent.mouseEnter(group())
    expect(screen.queryByRole("list", { name: "Прикреплённые заметки" })).toBeNull()
  })
})
