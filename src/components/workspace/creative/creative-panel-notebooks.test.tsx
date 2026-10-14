// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type {
  DatabaseRow,
  DatabaseSummary,
  Notebook,
  NotebookCatalog,
  ProjectCatalog,
} from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"
import { useDatabaseStore } from "../database/database-store"
import { selectedText } from "@/lib/test-utils/amby-select"
import { CreativePanel } from "./creative-panel"
import { useCreativeNavStore } from "./creative-nav-store"
import {
  catalog,
  workshopSection as section,
  storySummary,
  workshopSummary,
} from "./project-fixtures.test-support"
import { useProjectStore } from "./project-store"

const queryDatabase = vi.fn()
const createWorkshopEntity = vi.fn()
const listTextStats = vi.fn()
const resolveDatabaseAssetPaths = vi.fn()
const listNotebooks = vi.fn()
const createFolder = vi.fn()
const deleteItem = vi.fn()
const confirmAction = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>()
  return {
    ...original,
    queryDatabase: (...args: unknown[]) => queryDatabase(...args),
    createWorkshopEntity: (...args: unknown[]) => createWorkshopEntity(...args),
    listTextStats: (...args: unknown[]) => listTextStats(...args),
    resolveDatabaseAssetPaths: (...args: unknown[]) => resolveDatabaseAssetPaths(...args),
    listNotebooks: (...args: unknown[]) => listNotebooks(...args),
    createFolder: (...args: unknown[]) => createFolder(...args),
    deleteItem: (...args: unknown[]) => deleteItem(...args),
    confirmAction: (...args: unknown[]) => confirmAction(...args),
  }
})
vi.mock("./create-project-dialog", () => ({ CreateProjectDialog: () => null }))
vi.mock("./create-section-dialog", () => ({ CreateSectionDialog: () => null }))

const BASE = "/v/Мастерская/Заметки"

function row(
  noteId: string,
  title: string,
  categoryPath: string[],
  stories: string[] = [],
): DatabaseRow {
  return {
    noteId,
    title,
    relativePath: [...categoryPath, `${title}.md`].join("/"),
    parentNoteId: null,
    depth: 0,
    categoryPath,
    valuesJson: JSON.stringify(
      stories.length > 0 ? { stn: { type: "relation", targetNoteIds: stories } } : {},
    ),
    rowRevision: `rev-${noteId}`,
  }
}

function notebook(segments: string[], itemCount: number): Notebook {
  return { segments, path: `${BASE}/${segments.join("/")}`, itemCount }
}

function world(): ProjectCatalog {
  return catalog([
    workshopSummary("verse", {
      name: "Verse",
      path: "Verse",
      sections: [
        section("notes", {
          role: "notes",
          name: "Заметки",
          databaseId: "db_notes",
          databaseName: "Заметки",
          storiesPropertyId: "stn",
        }),
      ],
      stories: [
        storySummary("hills", { workshopId: "verse", name: "MoleHills", databaseId: "db_t_hills" }),
        storySummary("river", { workshopId: "verse", name: "River", databaseId: "db_t_river" }),
      ],
    }),
  ])
}

let rows: DatabaseRow[]
let listing: Notebook[]
let rootItems: number

function resetData() {
  rows = [
    row("n1", "Зарисовка", ["Идеи"], ["note_hills"]),
    row("n2", "Поворот", ["Идеи", "Сюжеты"], ["note_river"]),
    row("n3", "Корневая", [], ["note_hills"]),
    row("n4", "Ничья", ["Архив"]),
  ]
  listing = [
    notebook(["Архив"], 1),
    notebook(["Идеи"], 1),
    notebook(["Идеи", "Сюжеты"], 1),
    notebook(["Пустой"], 0),
  ]
  rootItems = 1
}
const notebookCatalog = (): NotebookCatalog => ({
  databaseId: "db_notes",
  containerPath: BASE,
  rootItemCount: rootItems,
  notebooks: listing,
  truncated: false,
})

const props = (extra: Partial<PanelRenderProps> = {}) =>
  ({ databaseRuntimeEnabled: true, vault: "/v", ...extra }) as PanelRenderProps

async function choose(name: RegExp) {
  fireEvent.click(screen.getByRole("combobox", { name: "История" }))
  fireEvent.click(await screen.findByRole("option", { name }))
}

/** Opens the notes part and waits for the notebooks to be read. */
async function openNotes() {
  fireEvent.click(await screen.findByRole("button", { name: /Заметки/ }))
  await screen.findByText("Пустой")
}

const notebookRow = (name: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-notebook]")).find(
    (element) => element.dataset.notebook === name,
  ) as HTMLElement
const notebookKeys = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-notebook]")).map(
    (element) => element.dataset.notebook,
  )
const noteRowOf = (noteId: string) =>
  document.querySelector<HTMLElement>(`[data-note-row="${noteId}"]`) as HTMLElement
const alertText = () => screen.getByRole("alert").textContent ?? ""
const dataTransfer = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" })

describe("CreativePanel: notebooks of the notes base", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    localStorage.clear()
    resetData()
    queryDatabase.mockReset().mockImplementation(async ({ databaseId }: { databaseId: string }) => {
      const list = databaseId === "db_notes" ? rows : []
      return { rows: list, nextCursor: null, totalCount: list.length, diagnostics: [] }
    })
    createWorkshopEntity.mockReset().mockResolvedValue({ noteId: "new-note", linkedStoryId: null })
    listTextStats.mockReset().mockResolvedValue([])
    resolveDatabaseAssetPaths.mockReset().mockResolvedValue({ paths: [] })
    listNotebooks.mockReset().mockImplementation(async () => notebookCatalog())
    createFolder.mockReset().mockImplementation(async (parent: string, name: string) => {
      return `${parent}/${name}`
    })
    deleteItem.mockReset().mockResolvedValue({ pathChanges: [], deletedPaths: [] })
    confirmAction.mockReset().mockResolvedValue(true)
    useProjectStore.getState().reset()
    useDatabaseStore.setState({
      vaultGeneration: 1,
      databases: [] as DatabaseSummary[],
      invalidationSeq: 0,
    })
    useCreativeNavStore.setState({
      sectionByProject: {},
      collapsed: {},
      scope: "verse",
      worksOpen: { text: false, anchors: false, notes: false },
      storyFilter: null,
      universeFilter: null,
      dataNonce: 0,
      search: "",
      pageRequest: null,
      entityRequest: null,
      createRequest: null,
    })
    act(() => useProjectStore.getState().setCatalog(world()))
  })
  afterEach(cleanup)

  it("shows every notebook as a tree, the empty ones dimmed, with the notes of no notebook last", async () => {
    render(<CreativePanel {...props()} />)
    await openNotes()
    // The story shown is MoleHills: it has two notes, one in "Идеи" and one with no notebook.
    expect(notebookKeys()).toEqual(["Архив", "Идеи", "Идеи/Сюжеты", "Пустой"])
    const counts = Object.fromEntries(
      notebookKeys().map((key) => [key, notebookRow(key!).textContent?.replace(/\D/gu, "")]),
    )
    expect(counts).toEqual({ Архив: "0", Идеи: "1", "Идеи/Сюжеты": "0", Пустой: "0" })
    expect(notebookRow("Пустой").dataset.muted).toBe("true")
    expect(notebookRow("Архив").dataset.muted).toBe("true")
    expect(notebookRow("Идеи/Сюжеты").dataset.muted).toBe("true")
    expect(notebookRow("Идеи").dataset.muted).toBeUndefined()
    expect(screen.getByText("Зарисовка")).toBeTruthy()
    expect(screen.queryByText("Поворот")).toBeNull()
    expect(screen.queryByText("Ничья")).toBeNull()

    // "No notebook" comes after the last notebook, with its note under it.
    const root = document.querySelector('[data-notebook-root="main"]') as HTMLElement
    expect(root.textContent).toContain("Без блокнота")
    const lastNotebook = notebookRow("Пустой")
    expect(
      lastNotebook.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    const rootNote = noteRowOf("n3")
    expect(root.compareDocumentPosition(rootNote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("counts under the filter that is on and shows the notes in no story as a group of their own", async () => {
    render(<CreativePanel {...props()} />)
    await openNotes()
    await choose(/River/)
    await waitFor(() => expect(screen.queryByText("Зарисовка")).toBeNull())
    expect(screen.getByText("Поворот")).toBeTruthy()
    expect(notebookRow("Идеи/Сюжеты").dataset.muted).toBeUndefined()
    expect(notebookRow("Идеи").textContent?.replace(/\D/gu, "")).toBe("1")
    expect(screen.queryByTestId("notes-without-story")).toBeNull()

    await choose(/Вся мастерская/)
    await waitFor(() => expect(selectedText("История")).toContain("Вся мастерская"))
    // All the notes in a story are shown, with the names of their stories.
    expect((await screen.findByText("Корневая")).closest("button")?.textContent).toContain(
      "MoleHills",
    )
    // The one in no story is in the group at the end, still in its notebook.
    const group = screen.getByTestId("notes-without-story")
    expect(within(group).getByText("Без истории")).toBeTruthy()
    expect(within(group).getByText("Архив")).toBeTruthy()
    expect(within(group).getByText("Ничья")).toBeTruthy()
    expect(within(group).queryByText("Пустой")).toBeNull()
    // The notebooks of the main tree are all still there.
    expect(notebookKeys().filter((key) => key === "Пустой")).toHaveLength(1)
  })

  it("makes a notebook on a row of its own, refuses a taken name before writing and a good one reads the folders again", async () => {
    const onCreativeChanged = vi.fn()
    render(<CreativePanel {...props({ onCreativeChanged })} />)
    await openNotes()
    fireEvent.click(screen.getByRole("button", { name: "Новый блокнот" }))
    const field = await screen.findByRole("textbox", {
      name: "Название блокнота — Enter, чтобы создать",
    })
    fireEvent.change(field, { target: { value: "идеи" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Блокнот с таким названием уже есть",
    )
    expect(createFolder).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: "a/b" } })
    fireEvent.keyDown(field, { key: "Enter" })
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("нельзя"))
    expect(createFolder).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: "Черновики" } })
    fireEvent.keyDown(field, { key: "Enter" })
    await waitFor(() => expect(createFolder).toHaveBeenCalledTimes(1))
    expect(createFolder).toHaveBeenCalledWith(BASE, "Черновики")
    await waitFor(() => expect(onCreativeChanged).toHaveBeenCalled())
  })

  it("makes a notebook inside a notebook", async () => {
    render(<CreativePanel {...props()} />)
    await openNotes()
    fireEvent.contextMenu(notebookRow("Идеи"))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Новый блокнот внутри" }))
    const field = await screen.findByRole("textbox", {
      name: "Название блокнота — Enter, чтобы создать",
    })
    fireEvent.change(field, { target: { value: "Герои" } })
    fireEvent.keyDown(field, { key: "Enter" })
    await waitFor(() => expect(createFolder).toHaveBeenCalledWith(`${BASE}/Идеи`, "Герои"))
  })

  it("makes a note in a notebook, linked to the story shown", async () => {
    render(<CreativePanel {...props()} />)
    await openNotes()
    fireEvent.click(screen.getByRole("button", { name: "Новая заметка в блокноте «Идеи»" }))
    const field = await screen.findByRole("textbox", {
      name: "Название заметки — Enter, чтобы создать",
    })
    fireEvent.change(field, { target: { value: "Новая" } })
    fireEvent.keyDown(field, { key: "Enter" })
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(createWorkshopEntity.mock.calls[0][0]).toMatchObject({
      workshopId: "verse",
      sectionId: "notes",
      title: "Новая",
      storyId: "hills",
      notebook: ["Идеи"],
    })
  })

  it("makes a note with no notebook from the part's own plus, and in the whole workshop with no story", async () => {
    render(<CreativePanel {...props()} />)
    await openNotes()
    const header = screen.getByRole("button", { name: /Заметки/ }).parentElement as HTMLElement
    fireEvent.click(within(header).getByRole("button", { name: "Добавить" }))
    const field = await screen.findByRole("textbox", {
      name: "Название заметки — Enter, чтобы создать",
    })
    fireEvent.change(field, { target: { value: "Первая" } })
    fireEvent.keyDown(field, { key: "Enter" })
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(createWorkshopEntity.mock.calls[0][0]).toMatchObject({
      sectionId: "notes",
      storyId: "hills",
      notebook: null,
    })
    createWorkshopEntity.mockClear()

    await choose(/Вся мастерская/)
    await waitFor(() => expect(selectedText("История")).toContain("Вся мастерская"))
    const wholeHeader = screen.getByRole("button", { name: /Заметки/ }).parentElement as HTMLElement
    fireEvent.click(within(wholeHeader).getByRole("button", { name: "Добавить" }))
    const next = await screen.findByRole("textbox", {
      name: "Название заметки — Enter, чтобы создать",
    })
    fireEvent.change(next, { target: { value: "Ничья новая" } })
    fireEvent.keyDown(next, { key: "Enter" })
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(createWorkshopEntity.mock.calls[0][0]).toMatchObject({ storyId: null })
  })

  it("moves a note by dragging it onto a notebook, with the tree's own move", async () => {
    const onMoveItem = vi.fn().mockResolvedValue("moved")
    render(<CreativePanel {...props({ onMoveItem })} />)
    await openNotes()
    const transfer = dataTransfer()
    fireEvent.dragStart(noteRowOf("n3"), { dataTransfer: transfer })
    fireEvent.dragOver(notebookRow("Пустой"), { dataTransfer: transfer })
    fireEvent.drop(notebookRow("Пустой"), { dataTransfer: transfer })
    await waitFor(() => expect(onMoveItem).toHaveBeenCalledTimes(1))
    expect(onMoveItem).toHaveBeenCalledWith(["n3"], `${BASE}/Пустой`)
  })

  it("moves a note out of its notebook by dragging it onto 'No notebook'", async () => {
    const onMoveItem = vi.fn().mockResolvedValue("moved")
    render(<CreativePanel {...props({ onMoveItem })} />)
    await openNotes()
    const transfer = dataTransfer()
    const root = document.querySelector('[data-notebook-root="main"]') as HTMLElement
    fireEvent.dragStart(noteRowOf("n1"), { dataTransfer: transfer })
    fireEvent.dragOver(root, { dataTransfer: transfer })
    fireEvent.drop(root, { dataTransfer: transfer })
    await waitFor(() => expect(onMoveItem).toHaveBeenCalledWith(["n1"], BASE))
  })

  it("moves a note from its menu, 'Move to notebook', with the same operation", async () => {
    const onMoveItem = vi.fn().mockResolvedValue("moved")
    render(<CreativePanel {...props({ onMoveItem })} />)
    await openNotes()
    fireEvent.contextMenu(noteRowOf("n3"))
    const trigger = await screen.findByRole("menuitem", { name: /Переместить в блокнот/ })
    fireEvent.keyDown(trigger, { key: "ArrowRight" })
    fireEvent.click(await screen.findByRole("menuitem", { name: "Пустой" }))
    await waitFor(() => expect(onMoveItem).toHaveBeenCalledWith(["n3"], `${BASE}/Пустой`))
  })

  it("refuses to move a note onto one of the same name, with nothing written", async () => {
    rows.push(row("n5", "Зарисовка", [], ["note_hills"]))
    const onMoveItem = vi.fn().mockResolvedValue("moved")
    render(<CreativePanel {...props({ onMoveItem })} />)
    await openNotes()
    const transfer = dataTransfer()
    const root = document.querySelector('[data-notebook-root="main"]') as HTMLElement
    fireEvent.dragStart(noteRowOf("n1"), { dataTransfer: transfer })
    fireEvent.drop(root, { dataTransfer: transfer })
    expect((await screen.findByRole("alert")).textContent).toContain("уже есть «Зарисовка»")
    expect(onMoveItem).not.toHaveBeenCalled()
  })

  describe("deleting a notebook", () => {
    const deleteFromMenu = async (name: string) => {
      fireEvent.contextMenu(notebookRow(name))
      fireEvent.click(await screen.findByRole("menuitem", { name: "Удалить блокнот…" }))
    }

    it("moves the notes up first and only then puts the empty folder in the trash", async () => {
      const calls: string[] = []
      const onMoveItem = vi.fn(async () => {
        calls.push("move")
        // The notes are out of the folder now.
        listing = listing.map((entry) =>
          entry.segments[0] === "Архив" ? { ...entry, itemCount: 0 } : entry,
        )
        rows = rows.map((entry) => (entry.noteId === "n4" ? { ...entry, categoryPath: [] } : entry))
        rootItems += 1
        return "moved" as const
      })
      confirmAction.mockImplementation(async () => {
        calls.push("confirm")
        return true
      })
      deleteItem.mockImplementation(async () => {
        calls.push("trash")
        return { pathChanges: [], deletedPaths: [] }
      })
      render(<CreativePanel {...props({ onMoveItem })} />)
      await openNotes()
      await deleteFromMenu("Архив")
      await waitFor(() => expect(deleteItem).toHaveBeenCalledTimes(1))
      expect(calls).toEqual(["confirm", "move", "trash"])
      expect(onMoveItem).toHaveBeenCalledWith(["n4"], BASE)
      expect(deleteItem.mock.calls[0][0]).toBe("/v")
      expect(deleteItem.mock.calls[0][1]).toBe(`${BASE}/Архив`)
      // Never a permanent deletion.
      expect(deleteItem.mock.calls[0][2]).not.toBe("permanent")
      expect(confirmAction.mock.calls[0][0]).toContain("Заметки не удаляются")
    })

    it("trashes an empty notebook without moving anything", async () => {
      const onMoveItem = vi.fn()
      render(<CreativePanel {...props({ onMoveItem })} />)
      await openNotes()
      await deleteFromMenu("Пустой")
      await waitFor(() => expect(deleteItem).toHaveBeenCalledTimes(1))
      expect(onMoveItem).not.toHaveBeenCalled()
      expect(deleteItem.mock.calls[0][1]).toBe(`${BASE}/Пустой`)
    })

    it("refuses before any write when moved notes would meet notes of the same name, and lists them", async () => {
      rows.push(row("n6", "Зарисовка", [], ["note_hills"]))
      rootItems += 1
      const onMoveItem = vi.fn()
      render(<CreativePanel {...props({ onMoveItem })} />)
      await openNotes()
      await deleteFromMenu("Идеи")
      expect((await screen.findByRole("alert")).textContent).toContain("Зарисовка")
      expect(alertText()).toContain("Ничего не изменено")
      expect(confirmAction).not.toHaveBeenCalled()
      expect(onMoveItem).not.toHaveBeenCalled()
      expect(deleteItem).not.toHaveBeenCalled()
    })

    it("refuses a notebook that holds more than notes", async () => {
      listing = listing.map((entry) =>
        entry.segments[0] === "Архив" ? { ...entry, itemCount: 2 } : entry,
      )
      const onMoveItem = vi.fn()
      render(<CreativePanel {...props({ onMoveItem })} />)
      await openNotes()
      await deleteFromMenu("Архив")
      expect((await screen.findByRole("alert")).textContent).toContain("не только заметки")
      expect(onMoveItem).not.toHaveBeenCalled()
      expect(deleteItem).not.toHaveBeenCalled()
    })

    it("does nothing when the author declines", async () => {
      confirmAction.mockResolvedValue(false)
      const onMoveItem = vi.fn()
      render(<CreativePanel {...props({ onMoveItem })} />)
      await openNotes()
      await deleteFromMenu("Архив")
      await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1))
      expect(onMoveItem).not.toHaveBeenCalled()
      expect(deleteItem).not.toHaveBeenCalled()
    })

    it("keeps the folder and says so when the move stops halfway: no note is lost", async () => {
      const onMoveItem = vi.fn().mockResolvedValue("failed")
      render(<CreativePanel {...props({ onMoveItem })} />)
      await openNotes()
      await deleteFromMenu("Архив")
      await waitFor(() => expect(onMoveItem).toHaveBeenCalledTimes(1))
      const text = (await screen.findByRole("alert")).textContent ?? ""
      expect(text).toContain("оборвался")
      expect(text).toContain("ни одна не потеряна")
      expect(deleteItem).not.toHaveBeenCalled()
    })

    it("keeps the folder when something is still in it after the move, even if the move says it is done", async () => {
      // The move reports success but the disk still shows a file in the folder.
      const onMoveItem = vi.fn().mockResolvedValue("moved")
      render(<CreativePanel {...props({ onMoveItem })} />)
      await openNotes()
      await deleteFromMenu("Архив")
      await waitFor(() => expect(onMoveItem).toHaveBeenCalledTimes(1))
      expect((await screen.findByRole("alert")).textContent).toContain("остались файлы")
      expect(deleteItem).not.toHaveBeenCalled()
    })
  })

  describe("renaming a notebook", () => {
    const startRename = async (name: string) => {
      fireEvent.contextMenu(notebookRow(name))
      fireEvent.click(await screen.findByRole("menuitem", { name: "Переименовать" }))
      return (await screen.findByRole("textbox", { name: "Переименовать" })) as HTMLInputElement
    }

    it("renames the folder with the tree's own rename, in place", async () => {
      const onRename = vi.fn(async () => {
        listing = listing.map((entry) =>
          entry.segments[0] === "Пустой" ? { ...entry, segments: ["Новый"] } : entry,
        )
      })
      render(<CreativePanel {...props({ onRename })} />)
      await openNotes()
      const field = await startRename("Пустой")
      expect(field.value).toBe("Пустой")
      fireEvent.change(field, { target: { value: "Новый" } })
      fireEvent.keyDown(field, { key: "Enter" })
      await waitFor(() => expect(onRename).toHaveBeenCalledWith(`${BASE}/Пустой`, "Новый"))
      expect(screen.queryByRole("alert")).toBeNull()
    })

    it("refuses a name that a sibling has, whatever the case, before asking the tree", async () => {
      const onRename = vi.fn()
      render(<CreativePanel {...props({ onRename })} />)
      await openNotes()
      const field = await startRename("Пустой")
      fireEvent.change(field, { target: { value: "архив" } })
      fireEvent.keyDown(field, { key: "Enter" })
      expect((await screen.findByRole("alert")).textContent).toContain("уже есть")
      expect(onRename).not.toHaveBeenCalled()
    })

    it("says so when the folder was not renamed", async () => {
      const onRename = vi.fn().mockResolvedValue(undefined)
      render(<CreativePanel {...props({ onRename })} />)
      await openNotes()
      const field = await startRename("Пустой")
      fireEvent.change(field, { target: { value: "Другой" } })
      fireEvent.keyDown(field, { key: "Enter" })
      expect((await screen.findByRole("alert")).textContent).toContain("не переименован")
    })
  })

  it("offers to link a notes base made before the links existed", async () => {
    const base = world()
    base.workshops[0].sections[0].storiesPropertyId = null
    act(() => useProjectStore.getState().setCatalog(base))
    render(<CreativePanel {...props()} />)
    fireEvent.click(await screen.findByRole("button", { name: /Заметки/ }))
    expect(await screen.findByRole("button", { name: "Связать с историями" })).toBeTruthy()
  })
})
