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
    openDocs: { note: { title: "Note" } },
    truncated: [],
    vault: "/v",
    currentDoc: { title: "Note" },
    currentClipped: false,
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
  it("keeps the context notes in a line above the writing box", () => {
    show({ input: "hi" })
    const field = screen.getByPlaceholderText("Сообщение…")
    const box = field.closest("[data-composer-box]")!
    const line = document.querySelector("[data-composer-line]")!
    const chip = screen.getByRole("button", { name: "Убрать заметку из контекста" })
    expect(line.contains(chip)).toBe(true)
    expect(box.contains(chip)).toBe(false)
    expect(before(line, box)).toBe(true)
    expect(line.className).not.toContain("flex-wrap")
  })

  it("has a paperclip left of the send button in the bottom line of the box", () => {
    show({ input: "hi" })
    const box = document.querySelector("[data-composer-box]")!
    const actions = box.querySelector("[data-composer-actions]")!
    const clip = screen.getByRole("button", { name: "Добавить заметку или папку" })
    const send = screen.getByRole("button", { name: "Отправить" })
    expect(clip.querySelector("svg.lucide-paperclip")).not.toBeNull()
    expect(actions.contains(clip) && actions.contains(send)).toBe(true)
    expect(actions.firstElementChild).toBe(clip)
    expect(before(clip, send)).toBe(true)
  })

  it("puts the model, the approval mode and the tree switch below the writing box, the tree last", () => {
    show({ onApprovalMode: vi.fn() })
    const box = document.querySelector("[data-composer-box]")!
    const model = screen.getByLabelText("Активная модель")
    const mode = screen.getByRole("button", { name: "Как применять правки ИИ" })
    const tree = screen.getByRole("checkbox", { name: /Поиск по хранилищу/ })
    for (const control of [model, mode, tree]) expect(box.contains(control)).toBe(false)
    expect(before(box, model)).toBe(true)
    expect(before(model, mode)).toBe(true)
    expect(before(mode, tree)).toBe(true)
  })

  it("has a paperclip that starts adding another note by typing @ at the end", () => {
    const onInput = vi.fn()
    show({ input: "hi", onInput })
    fireEvent.click(screen.getByRole("button", { name: "Добавить заметку или папку" }))
    expect(onInput).toHaveBeenCalledWith("hi @")
  })

  it("uses the tree icon, not a magnifier, for searching the vault", () => {
    show()
    const label = screen.getByRole("checkbox", { name: /Поиск по хранилищу/ }).closest("label")!
    expect(label.querySelector("svg.lucide-folder-tree")).not.toBeNull()
    expect(label.querySelector("svg.lucide-search")).toBeNull()
  })

  it("stretches the note across the whole context line", () => {
    show()
    const chip = screen.getByRole("button", { name: "Убрать заметку из контекста" }).parentElement!
    expect(chip.className).toContain("flex-1")
  })

  it("has no context line when nothing is attached", () => {
    show({ chat: { ...chat, context: [], autoCurrent: false }, currentDoc: null })
    expect(document.querySelector("[data-composer-line]")).toBeNull()
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
    openDocs: Object.fromEntries(notes.map((name, index) => [`n${index}`, { title: name }])),
    currentDoc: null,
    currentClipped: false,
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
    const panel = document.querySelector("[data-composer-root]")!
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

describe("Composer approval mode", () => {
  it("puts the model row under the writing box, with the mode button right of the picker", () => {
    const onApprovalMode = vi.fn()
    show({ onApprovalMode, approvalMode: "auto" })
    const box = document.querySelector("[data-composer-box]")!
    const picker = screen.getByRole("combobox")
    const mode = screen.getByRole("button", { name: "Как применять правки ИИ" })
    expect(box.contains(picker)).toBe(false)
    expect(before(box, picker)).toBe(true)
    expect(before(picker, mode)).toBe(true)
    expect(mode.getAttribute("title")).toBe("Автоматически")
  })
})

describe("Composer current note", () => {
  const detached: Chat = { ...chat, autoCurrent: false, context: [] }

  it("has no text button beside the plus; the plus list offers the current note", () => {
    const onAddCurrent = vi.fn()
    const onInput = vi.fn()
    show({
      chat: detached,
      onAddCurrent,
      onInput,
      input: "Привет @",
      mentionOpen: true,
      choices: [],
    })
    // Only the plus stays in the line; the words are inside its list.
    expect(screen.queryByRole("button", { name: "Добавить текущую заметку" })).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: /Добавить текущую заметку/ }))
    expect(onAddCurrent).toHaveBeenCalledTimes(1)
    expect(onInput).toHaveBeenCalledWith("Привет ")
  })

  it("does not offer it when the current note is already followed", () => {
    show({ input: "@", mentionOpen: true, choices: [] })
    expect(screen.queryByRole("option", { name: /Добавить текущую заметку/ })).toBeNull()
  })
})

describe("Composer plus list", () => {
  it("separates the current note from the other notes", () => {
    const detached: Chat = { ...chat, autoCurrent: false, context: [] }
    show({
      chat: detached,
      input: "@",
      mentionOpen: true,
      choices: [{ id: "x", path: "/v/X.md", name: "X.md", type: "file" }],
    })
    const current = screen.getByRole("option", { name: /Добавить текущую заметку/ })
    const other = screen.getByRole("option", { name: /X\.md/ })
    const divider = screen.getByRole("separator")
    expect(before(current, divider)).toBe(true)
    expect(before(divider, other)).toBe(true)
  })

  it("has no separate write switch: the tree switch is the only one for the whole vault", () => {
    show()
    expect(screen.queryByRole("checkbox", { name: /правки по всему хранилищу/ })).toBeNull()
    expect(screen.getAllByRole("checkbox")).toHaveLength(1)
  })
})

describe("Composer writing box", () => {
  it("starts as one line and keeps the box the same width in focus", () => {
    show({ input: "text" })
    const field = screen.getByPlaceholderText("Сообщение…") as HTMLTextAreaElement
    const box = document.querySelector("[data-composer-box]")!
    expect(field.getAttribute("rows")).toBe("1")
    fireEvent.focus(field)
    expect(box.className).not.toContain("-mx")
  })
})
