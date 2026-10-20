// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { chooseOption, selectedText } from "@/lib/test-utils/amby-select"
import type { DatabaseRow, DatabaseSummary, ProjectTextSummary, TextPageStat } from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import { useViewStateStore } from "../../use-view-state-store"
import { useCreativeNavStore } from "../creative-nav-store"
import { readWorkshopPrefs } from "../creative-scope-storage"
import {
  catalog,
  storySummary,
  workshopSection as section,
  workshopSummary,
} from "../project-fixtures.test-support"
import { ProjectPage } from "../project-page"
import { useProjectStore } from "../project-store"

const queryDatabase = vi.hoisted(() => vi.fn())
const listTextStats = vi.hoisted(() => vi.fn())
const listNotebooks = vi.hoisted(() => vi.fn())
const createWorkshopEntity = vi.hoisted(() => vi.fn())

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  queryDatabase: (...args: unknown[]) => queryDatabase(...args),
  listTextStats: (...args: unknown[]) => listTextStats(...args),
  listNotebooks: (...args: unknown[]) => listNotebooks(...args),
  createWorkshopEntity: (...args: unknown[]) => createWorkshopEntity(...args),
  resolveDatabaseAssetPaths: async () => ({ paths: [] }),
}))
vi.mock("../create-section-dialog", () => ({ CreateSectionDialog: () => null }))
vi.mock("../create-project-dialog", () => ({
  CreateProjectDialog: () => <div data-testid="story-dialog" />,
}))

const NOW = Math.floor(Date.now() / 1000)
const VAULT = "/vaults/test"

function row(
  noteId: string,
  title: string,
  values: Record<string, unknown> = {},
  categoryPath: string[] = [],
): DatabaseRow {
  return {
    noteId,
    title,
    relativePath: `${noteId}.md`,
    parentNoteId: null,
    depth: 0,
    categoryPath,
    valuesJson: JSON.stringify(values),
    rowRevision: `rev-${noteId}`,
  }
}
const rel = (...ids: string[]) => ({ type: "relation", targetNoteIds: ids })
const status = (optionId: string) => ({ type: "status", optionId })
const stat = (noteId: string, wordCount: number, modified: number): TextPageStat => ({
  noteId,
  wordCount,
  modified,
  created: modified - 1000,
})

const text: ProjectTextSummary = {
  databaseId: "db_t_hills",
  properties: {
    level: "lv",
    parent: "pa",
    order: "or",
    format: "fm",
    status: "pst",
    anchors: null,
    arcs: null,
  },
  levels: [],
  formats: [],
  statusOptions: [
    { id: "todo", name: "Черновик", color: "gray", group: "notStarted" },
    { id: "fin", name: "Готово", color: "green", group: "done" },
  ],
}

const storiesSummary: DatabaseSummary = {
  databaseId: "db_stories",
  title: "Истории",
  icon: null,
  attachedNoteId: null,
  manifestRevision: "m",
  locked: false,
  properties: [
    {
      propertyId: "sst",
      name: "Статус",
      propertyType: "status",
      configJson: JSON.stringify({
        options: [
          { id: "draft", group: "notStarted" },
          { id: "ready", group: "done" },
        ],
      }),
      options: [
        { optionId: "draft", name: "Черновик", color: "#aaaaaa" },
        { optionId: "ready", name: "Готово", color: "#00aa00" },
      ],
    },
  ],
  views: [],
  templates: [],
  diagnostics: [],
}

const workshop = workshopSummary("verse", {
  name: "Verse",
  sections: [
    section("stories", { role: "stories", databaseId: "db_stories", universePropertyId: "up" }),
    section("universes", { role: "universes", name: "Вселенные", databaseId: "db_univ" }),
    section("notes", {
      role: "notes",
      name: "Заметки",
      databaseId: "db_notes",
      databaseName: "Заметки",
      storiesPropertyId: "nst",
    }),
  ],
  stories: [
    storySummary("hills", {
      workshopId: "verse",
      name: "MoleHills",
      cardPath: "hills/hills.md",
      cardNoteId: "note_hills",
      databaseId: "db_t_hills",
      text,
    }),
    storySummary("lone", {
      workshopId: "verse",
      name: "Одиночка",
      cardPath: "lone/lone.md",
      cardNoteId: "note_lone",
      databaseId: "db_t_lone",
      text: { ...text, databaseId: "db_t_lone" },
    }),
  ],
})

const ROWS: Record<string, DatabaseRow[]> = {
  db_stories: [
    row("note_hills", "MoleHills", { up: rel("u1"), sst: status("draft") }),
    row("note_lone", "Одиночка", { sst: status("ready") }),
  ],
  db_univ: [row("u1", "Палуверс")],
  db_t_hills: [
    row("h1", "Глава 1", { pst: status("fin") }),
    row("h2", "Глава 2", { pst: status("todo") }),
  ],
  db_t_lone: [row("l1", "Пролог", { pst: status("fin") })],
  db_notes: [row("n1", "Идея", { nst: rel("note_hills") }, ["Идеи"]), row("n2", "Факт", {}, [])],
}
const STATS: Record<string, TextPageStat[]> = {
  db_t_hills: [stat("h1", 100, NOW - 3600), stat("h2", 50, NOW - 7200)],
  db_t_lone: [stat("l1", 30, NOW - 3 * 86400)],
  db_notes: [stat("n1", 5, NOW - 60)],
}

function mount() {
  const handlers = {
    onOpenProject: vi.fn(),
    onOpenNote: vi.fn(),
    onOpenDatabase: vi.fn(),
  }
  render(<ProjectPage projectId="verse" vaultPath={VAULT} {...handlers} />)
  return handlers
}

/** The names of the story cards on screen, in order (the stars are not cards). */
const storyNames = () =>
  within(screen.getByRole("region", { name: "Истории" }))
    .getAllByRole("button", { name: /MoleHills|Одиночка/ })
    .filter((button) => button.getAttribute("aria-pressed") === null)
    .map((button) => (button.textContent?.includes("MoleHills") ? "MoleHills" : "Одиночка"))

const filterGroup = () => screen.getByRole("group", { name: "Фильтр историй" })

describe("the page of the workshop", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    localStorage.clear()
    queryDatabase
      .mockReset()
      .mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
        rows: ROWS[databaseId] ?? [],
        nextCursor: null,
        totalCount: (ROWS[databaseId] ?? []).length,
        diagnostics: [],
      }))
    listTextStats.mockReset().mockImplementation(async (id: string) => STATS[id] ?? [])
    listNotebooks.mockReset().mockResolvedValue({
      databaseId: "db_notes",
      containerPath: "notes",
      rootItemCount: 0,
      notebooks: [{ segments: ["Идеи"], path: "notes/Идеи", itemCount: 1 }],
    })
    createWorkshopEntity.mockReset().mockResolvedValue({ noteId: "new" })
    useProjectStore.getState().reset()
    useDatabaseStore.getState().reset(1)
    useViewStateStore.setState({ favorites: new Set() })
    useCreativeNavStore.setState({ sectionByProject: {}, collapsed: {}, dataNonce: 0 })
    act(() => {
      useDatabaseStore.getState().setCatalog([storiesSummary])
      useProjectStore.getState().setCatalog(catalog([workshop]))
    })
  })
  afterEach(cleanup)

  it("counts worlds, stories and the words written under the name", async () => {
    mount()
    const numbers = screen.getByText("Миров").closest("dl") as HTMLElement
    await waitFor(() =>
      expect(within(numbers).getByText("Написано слов").nextSibling?.textContent).toBe(
        (180).toLocaleString(),
      ),
    )
    expect(within(numbers).getByText("Миров").nextSibling?.textContent).toBe("1")
    expect(within(numbers).getByText("Историй").nextSibling?.textContent).toBe("2")
  })

  it("offers the page changed last and opens it with 'Write'", async () => {
    const { onOpenNote } = mount()
    const band = await screen.findByRole("region", { name: "Продолжить" })
    await within(band).findByText(/Глава 1/)
    expect(band.textContent).toContain("MoleHills")
    expect(band.textContent).toContain("100 сл.")
    fireEvent.click(within(band).getByRole("button", { name: "Писать" }))
    expect(onOpenNote).toHaveBeenCalledWith("h1")
  })

  it("shows each story with its world, its progress and whether it is finished", async () => {
    const { onOpenProject } = mount()
    const hills = await screen.findByRole("button", { name: /MoleHills/ })
    await waitFor(() => expect(hills.textContent).toContain("Готово: 1 из 2"))
    expect(hills.textContent).toContain("Палуверс")
    expect(hills.textContent).toContain("150 сл.")
    const lone = screen.getByRole("button", { name: /Одиночка/ })
    expect(lone.textContent).toContain("Отдельная история")
    expect(lone.textContent).toContain("Закончена")
    fireEvent.click(hills)
    expect(onOpenProject).toHaveBeenCalledWith("hills")
  })

  it("filters the stories and remembers the filter and the sort in this vault", async () => {
    mount()
    await screen.findByRole("button", { name: /MoleHills/ })
    fireEvent.click(within(filterGroup()).getByRole("button", { name: /Законченные/ }))
    expect(storyNames()).toEqual(["Одиночка"])
    await chooseOption("Сортировка", "Название")
    expect(readWorkshopPrefs(VAULT)).toMatchObject({ storyFilter: "finished", storySort: "name" })
    // A page opened later starts where this one was left.
    cleanup()
    mount()
    await screen.findByRole("button", { name: /Одиночка/ })
    expect(storyNames()).toEqual(["Одиночка"])
    expect(selectedText("Сортировка")).toBe("Название")
    fireEvent.click(within(filterGroup()).getByRole("button", { name: /В работе/ }))
    expect(storyNames()).toEqual(["MoleHills"])
  })

  it("says so when the filter holds no story", async () => {
    mount()
    await screen.findByRole("button", { name: /MoleHills/ })
    fireEvent.click(within(filterGroup()).getByRole("button", { name: /Избранные/ }))
    expect(screen.getByText("Нет историй под этот фильтр")).toBeTruthy()
  })

  it("stars a story as the same favorite the Favorites panel keeps", async () => {
    mount()
    await screen.findByRole("button", { name: /MoleHills/ })
    const star = screen.getAllByRole("button", { name: "В избранное" })[0]
    expect(star.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(star)
    expect(useViewStateStore.getState().favorites.has("note_hills")).toBe(true)
    const pressed = await screen.findByRole("button", { name: "Убрать из избранного" })
    expect(pressed.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(within(filterGroup()).getByRole("button", { name: /Избранные/ }))
    expect(storyNames()).toEqual(["MoleHills"])
    fireEvent.click(pressed)
    expect(useViewStateStore.getState().favorites.size).toBe(0)
  })

  it("narrows the stories to a world", async () => {
    mount()
    await screen.findByRole("button", { name: /MoleHills/ })
    await screen.findByRole("combobox", { name: "Мир" })
    await chooseOption("Мир", "Отдельные истории")
    expect(storyNames()).toEqual(["Одиночка"])
    await chooseOption("Мир", "Палуверс")
    expect(storyNames()).toEqual(["MoleHills"])
  })

  it("opens a new story from the dashed card", async () => {
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Новая история" }))
    expect(screen.getByTestId("story-dialog")).toBeTruthy()
  })

  it("shows the notes under their notebooks and makes one in the notebook shown", async () => {
    const { onOpenNote } = mount()
    const notes = await screen.findByRole("region", { name: "Заметки" })
    await within(notes).findByText("Идея")
    const tabs = within(notes)
      .getAllByRole("tab")
      .map((tab) => tab.textContent)
    expect(tabs).toEqual(["Все2", "Идеи1", "Без блокнота1"])
    fireEvent.click(within(notes).getByRole("tab", { name: /Идеи/ }))
    expect(within(notes).queryByText("Факт")).toBeNull()
    fireEvent.click(within(notes).getByText("Идея"))
    expect(onOpenNote).toHaveBeenCalledWith("n1")

    fireEvent.click(within(notes).getByRole("button", { name: "Заметка" }))
    const field = within(notes).getByLabelText("Название заметки")
    fireEvent.change(field, { target: { value: "Новая" } })
    fireEvent.submit(field.closest("form") as HTMLFormElement)
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(createWorkshopEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "verse",
        sectionId: "notes",
        title: "Новая",
        notebook: ["Идеи"],
      }),
    )
  })

  it("says the notes are empty when there are none", async () => {
    const saved = ROWS.db_notes
    ROWS.db_notes = []
    try {
      mount()
      expect(await screen.findByText("Пока пусто.")).toBeTruthy()
    } finally {
      ROWS.db_notes = saved
    }
  })
})
