// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { Composer } from "./composer"
import type { Chat } from "@/lib/storage"

const dictation = vi.hoisted(() => vi.fn())
vi.mock("@/lib/ai", () => ({ startSystemDictation: dictation }))

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
  it("puts the attached context note and context usage above the writing box, with no plus button or search switch there", () => {
    show({ onApprovalMode: vi.fn(), contextBytes: 64 * 1024 })
    const field = screen.getByPlaceholderText("Сообщение…")
    const box = field.closest("[data-composer-box]")!
    const chip = screen.getByRole("button", { name: "Убрать заметку из контекста" })
    const usage = document.querySelector("[data-context-usage]")!
    const search = screen.getByRole("checkbox", { name: /Поиск по хранилищу/ })
    expect(box.contains(chip)).toBe(false)
    expect(box.contains(usage)).toBe(false)
    expect(screen.queryByRole("button", { name: "Добавить заметку или папку" })).toBeNull()
    const line = chip.closest("[data-composer-line]")!
    expect(line.contains(usage)).toBe(true)
    expect(before(chip, usage)).toBe(true)
    expect(usage.textContent).toBe("13%")
    expect(line.contains(search)).toBe(false)
    expect(before(line, box)).toBe(true)
    expect(line.className).not.toContain("flex-wrap")
  })

  it("hides the context line when nothing is attached and context is empty", () => {
    show({ chat: { ...chat, context: [], autoCurrent: false }, currentDoc: null })
    expect(document.querySelector("[data-composer-line]")).toBeNull()
  })

  it("keeps the text on its own line, with the paperclip and the send button in a line under it", () => {
    show({ input: "hi" })
    const box = document.querySelector("[data-composer-box]")!
    const field = screen.getByPlaceholderText("Сообщение…")
    const actions = box.querySelector("[data-composer-actions]")!
    const clip = screen.getByRole("button", { name: "Прикрепить" })
    const send = screen.getByRole("button", { name: "Отправить" })
    expect(actions.contains(field)).toBe(false)
    expect(before(field, actions)).toBe(true)
    expect(actions.contains(clip) && actions.contains(send)).toBe(true)
    expect(before(clip, send)).toBe(true)
  })

  it("draws send as a plain icon without a circle around it", () => {
    show({ input: "hi" })
    const send = screen.getByRole("button", { name: "Отправить" })
    expect(send.className).not.toContain("rounded-full")
    expect(send.className).not.toContain("bg-primary")
  })

  it("puts the model, approval mode and search vault switch below the writing box in that order", () => {
    show({ onApprovalMode: vi.fn() })
    const box = document.querySelector("[data-composer-box]")!
    const model = screen.getByLabelText("Активная модель")
    const mode = screen.getByRole("button", { name: "Как применять правки ИИ" })
    const search = screen.getByRole("checkbox", { name: /Поиск по хранилищу/ })
    for (const control of [model, mode, search]) expect(box.contains(control)).toBe(false)
    expect(before(box, model)).toBe(true)
    expect(before(model, mode)).toBe(true)
    expect(before(mode, search)).toBe(true)
  })

  it("uses the search magnifier icon for searching the vault", () => {
    show()
    const label = screen.getByRole("checkbox", { name: /Поиск по хранилищу/ }).closest("label")!
    expect(label.querySelector("svg.lucide-search")).not.toBeNull()
    expect(label.querySelector("svg.lucide-folder-tree")).toBeNull()
  })

  it("stretches the single context chip across the full context line", () => {
    show()
    const line = document.querySelector("[data-composer-line]")!
    expect(line.className).toContain("w-full")
    const chip = screen.getByRole("button", { name: "Убрать заметку из контекста" }).parentElement!
    expect(line.firstElementChild).toBe(chip)
    expect(chip.className).toContain("flex-1")
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

describe("Composer attachments", () => {
  it("opens a submenu from the paperclip with text file and note/folder choices", async () => {
    show()
    const box = document.querySelector("[data-composer-box]")!
    const clip = screen.getByRole("button", { name: "Прикрепить" })
    expect(box.contains(clip)).toBe(true)
    expect(clip.querySelector("svg.lucide-paperclip")).not.toBeNull()
    expect(before(screen.getByPlaceholderText("Сообщение…"), clip)).toBe(true)

    fireEvent.click(clip)
    const menu = await screen.findByRole("menu", { name: "Прикрепить" })
    const fileChoice = within(menu).getByRole("menuitem", { name: "Текстовый файл" })
    const noteChoice = within(menu).getByRole("menuitem", { name: "Заметка или папка" })
    expect(before(fileChoice, noteChoice)).toBe(true)

    const input = box.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.multiple).toBe(true)
    expect(input.accept).toContain(".md")
    const clickSpy = vi.spyOn(input, "click").mockImplementation(() => {})
    fireEvent.click(fileChoice)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    clickSpy.mockRestore()
  })

  it("opens a note tree popup where both a folder and a nested note can be selected", async () => {
    const emptyChat: Chat = { ...chat, autoCurrent: false, context: [] }
    const roadmap = {
      id: "note-roadmap",
      path: "/v/Projects/Roadmap.md",
      name: "Roadmap.md",
      type: "file" as const,
    }
    const projects = {
      id: "folder-projects",
      path: "/v/Projects",
      name: "Projects",
      type: "folder" as const,
      children: [roadmap],
    }
    const inbox = {
      id: "note-root",
      path: "/v/Inbox.md",
      name: "Inbox.md",
      type: "file" as const,
    }
    const props = show({
      chat: emptyChat,
      treeItems: [projects, inbox],
      flat: [projects, roadmap, inbox],
      openDocs: { "note-roadmap": { title: "Roadmap" } },
      currentDoc: null,
    })

    fireEvent.click(screen.getByRole("button", { name: "Прикрепить" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Заметка или папка" }))
    const tree = await screen.findByRole("tree", { name: "Дерево заметок" })

    // Selecting a whole folder attaches it as a folder context item.
    fireEvent.click(within(tree).getByRole("treeitem", { name: "Projects" }))
    expect(props.onChangeChat).toHaveBeenCalledWith({
      ...emptyChat,
      context: [{ kind: "folder", id: "Projects" }],
    })

    // Expanding the folder reveals nested notes; clicking a note attaches it.
    fireEvent.click(within(tree).getByRole("button", { name: "Раскрыть папку" }))
    fireEvent.click(within(tree).getByRole("treeitem", { name: "Roadmap" }))
    expect(props.onChangeChat).toHaveBeenCalledWith({
      ...emptyChat,
      context: [{ kind: "note", id: "note-roadmap" }],
    })
  })

  it("filters the note tree and auto-expands matching folders", async () => {
    const emptyChat: Chat = { ...chat, autoCurrent: false, context: [] }
    const spec = {
      id: "note-spec",
      path: "/v/Work/Spec.md",
      name: "Spec.md",
      type: "file" as const,
    }
    const work = {
      id: "folder-work",
      path: "/v/Work",
      name: "Work",
      type: "folder" as const,
      children: [spec],
    }
    const other = {
      id: "note-other",
      path: "/v/Other.md",
      name: "Other.md",
      type: "file" as const,
    }
    show({
      chat: emptyChat,
      treeItems: [work, other],
      flat: [work, spec, other],
      openDocs: {},
      currentDoc: null,
    })

    fireEvent.click(screen.getByRole("button", { name: "Прикрепить" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Заметка или папка" }))
    const search = await screen.findByPlaceholderText("Поиск заметок и папок…")
    fireEvent.change(search, { target: { value: "Spec" } })

    const tree = screen.getByRole("tree", { name: "Дерево заметок" })
    expect(within(tree).getByRole("treeitem", { name: "Spec.md" })).toBeTruthy()
    expect(within(tree).queryByRole("treeitem", { name: "Other.md" })).toBeNull()
  })

  it("places current-note action above the bottom search bar and back button below the tree", async () => {
    const emptyChat: Chat = { ...chat, autoCurrent: false, context: [] }
    show({ chat: emptyChat, currentDoc: { title: "Current" } })
    fireEvent.click(screen.getByRole("button", { name: "Прикрепить" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Заметка или папка" }))
    const tree = await screen.findByRole("tree", { name: "Дерево заметок" })
    const addCurrent = screen.getByRole("button", { name: "Добавить текущую заметку" })
    const back = screen.getByRole("button", { name: "Назад" })
    const search = screen.getByPlaceholderText("Поиск заметок и папок…")
    expect(before(tree, addCurrent)).toBe(true)
    expect(before(addCurrent, back)).toBe(true)
    expect(before(addCurrent, search)).toBe(true)
  })

  it("lists attached files and removes one", async () => {
    const { useAttachmentStore } = await import("./attachments")
    useAttachmentStore.getState().clear("c")
    useAttachmentStore.getState().add("c", [{ name: "plan.md", text: "x", size: 1 }])
    show()
    expect(screen.getByText("plan.md")).toBeTruthy()
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Убрать файл plan.md" })),
    )
    expect(screen.queryByText("plan.md")).toBeNull()
  })
})

describe("Composer dictation and send", () => {
  afterEach(() => vi.restoreAllMocks())

  it("shows the microphone left of send on a Mac and starts the system dictation in the field", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel")
    dictation.mockResolvedValue(true)
    show()
    const mic = screen.getByRole("button", { name: "Диктовка (системная)" })
    expect(before(mic, screen.getByRole("button", { name: "Отправить" }))).toBe(true)
    await act(async () => fireEvent.click(mic))
    expect(dictation).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Сообщение…"))
  })

  it("says so when the system did not start dictation, and has no microphone elsewhere", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel")
    dictation.mockRejectedValue(new Error("notStarted"))
    show()
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Диктовка (системная)" })),
    )
    expect(screen.getByRole("status").textContent).toMatch(/Диктовка/)
    cleanup()
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32")
    show()
    expect(screen.queryByRole("button", { name: "Диктовка (системная)" })).toBeNull()
  })

  it("sends with the return arrow", () => {
    show({ input: "hi" })
    const send = screen.getByRole("button", { name: "Отправить" })
    expect(send.querySelector("svg.lucide-corner-down-left")).not.toBeNull()
  })
})
