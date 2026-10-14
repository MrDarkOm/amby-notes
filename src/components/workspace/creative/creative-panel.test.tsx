// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseRow, DatabaseSummary, ProjectCatalog } from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"
import { useDatabaseStore } from "../database/database-store"
import { CreativePanel } from "./creative-panel"
import { useCreativeNavStore } from "./creative-nav-store"
import { selectedText } from "@/lib/test-utils/amby-select"
import {
  catalog,
  project,
  section,
  storySummary,
  workshopSummary,
} from "./project-fixtures.test-support"
import { useProjectStore } from "./project-store"

const queryDatabase = vi.fn()
const createDatabaseRow = vi.fn()
const createWorkshopEntity = vi.fn()
const addStoryLinks = vi.fn()
const moveTextPage = vi.fn()
const createTextPage = vi.fn()
const listTextStats = vi.fn()
const resolveDatabaseAssetPaths = vi.fn()
const applyDatabaseValueBatch = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>()
  return {
    ...original,
    queryDatabase: (...args: unknown[]) => queryDatabase(...args),
    createDatabaseRow: (...args: unknown[]) => createDatabaseRow(...args),
    createWorkshopEntity: (...args: unknown[]) => createWorkshopEntity(...args),
    addStoryLinks: (...args: unknown[]) => addStoryLinks(...args),
    moveTextPage: (...args: unknown[]) => moveTextPage(...args),
    createTextPage: (...args: unknown[]) => createTextPage(...args),
    listTextStats: (...args: unknown[]) => listTextStats(...args),
    resolveDatabaseAssetPaths: (...args: unknown[]) => resolveDatabaseAssetPaths(...args),
    applyDatabaseValueBatch: (...args: unknown[]) => applyDatabaseValueBatch(...args),
  }
})
vi.mock("./create-project-dialog", () => ({
  CreateProjectDialog: (props: {
    open: boolean
    workshop?: { name: string } | null
    parent?: { name: string } | null
  }) =>
    props.open ? (
      <div data-testid="project-dialog">{props.workshop?.name ?? props.parent?.name ?? "root"}</div>
    ) : null,
}))
vi.mock("./create-section-dialog", () => ({
  CreateSectionDialog: (props: { workshop?: { name: string }; project?: { name: string } }) => (
    <div data-testid="section-dialog">{(props.workshop ?? props.project)?.name}</div>
  ),
}))

const props = (extra: Partial<PanelRenderProps> = {}) =>
  ({ databaseRuntimeEnabled: true, ...extra }) as PanelRenderProps

const selectScope = (projectId: string | null) =>
  act(() => useCreativeNavStore.setState({ scope: projectId }))

function row(noteId: string, title: string, values: Record<string, unknown> = {}): DatabaseRow {
  return {
    noteId,
    title,
    relativePath: `${noteId}.md`,
    parentNoteId: null,
    depth: 0,
    categoryPath: [],
    valuesJson: JSON.stringify(values),
    rowRevision: `rev-${noteId}`,
  }
}

const TEXT = {
  databaseId: "db_text",
  properties: {
    level: "lvl",
    parent: "par",
    order: "ord",
    format: null,
    status: null,
    anchors: null,
    arcs: null,
  },
  levels: [
    { id: "book", icon: null, name: "Книга", color: null, state: "ok" as const },
    { id: "chapter", icon: null, name: "Глава", color: null, state: "ok" as const },
  ],
  formats: [{ id: "ms", kind: "manuscript", name: "Рукопись", color: null, state: "ok" as const }],
  statusOptions: [],
}

/** A universe with shared characters, one story with its own, and a stand-alone story. */
function world(): ProjectCatalog {
  const universe = workshopSummary("verse", {
    name: "Verse",
    path: "Verse",
    sections: [
      section("chars", {
        role: "characters",
        name: "Персонажи",
        databaseId: "db_uc",
        databaseName: "Персонажи",
        storiesPropertyId: "stp",
      }),
      section("orgs", {
        role: "custom",
        name: "Организации",
        databaseId: "db_uo",
        databaseName: "Организации",
      }),
      section("notes", {
        role: "notes",
        name: "Заметки",
        databaseId: "db_notes",
        databaseName: "Заметки",
        storiesPropertyId: "stn",
      }),
      section("anchors", {
        role: "anchors",
        name: "Якоря",
        databaseId: "db_anchors",
        databaseName: "Якоря",
        storiesPropertyId: "sta",
      }),
    ],
    stories: [
      storySummary("hills", {
        workshopId: "verse",
        name: "MoleHills",
        folderPath: "Verse/MoleHills",
        databaseId: "db_text",
        text: TEXT,
      }),
      storySummary("river", {
        workshopId: "verse",
        name: "River",
        folderPath: "Verse/River",
        databaseId: "db_rc",
      }),
    ],
  })
  const other = workshopSummary("tale", {
    name: "Рассказ",
    path: "Рассказ",
    stories: [
      storySummary("tale_story", {
        workshopId: "tale",
        name: "Рассказ",
      }),
    ],
  })
  return catalog([universe, other])
}

const importance = { type: "select", optionId: "main" }
/** The "Stories" relation of a character: the cards of the stories it is in. */
const inStories = (...cards: string[]) => ({
  stp: { type: "relation", targetNoteIds: cards },
})
/** The "Stories" relation of an anchor. */
function inAnchorStories(...cards: string[]) {
  return { sta: { type: "relation", targetNoteIds: cards } }
}
const DATABASES: DatabaseSummary[] = [
  {
    databaseId: "db_uc",
    title: "Персонажи",
    icon: null,
    attachedNoteId: null,
    manifestRevision: "m",
    locked: false,
    properties: [
      {
        propertyId: "imp",
        name: "Значимость",
        propertyType: "select",
        configJson: "{}",
        options: [{ optionId: "main", name: "Главные", color: "#f00" }],
      },
    ],
    views: [
      {
        viewId: "g",
        title: "Галерея",
        layout: "gallery",
        revision: "r",
        groupField: { kind: "property", propertyId: "imp" },
      },
    ],
    templates: [],
    diagnostics: [],
  },
]

const ROWS: Record<string, DatabaseRow[]> = {
  db_uc: [
    // Zoya is only named in the text of MoleHills; the others say which story they are in.
    row("zoya", "Зоя"),
    row("anna", "Анна", { imp: importance, ...inStories("note_hills") }),
    row("boris", "Борис", inStories("note_hills", "note_river")),
    row("vera", "Вера", inStories("note_river")),
    row("eva", "Ева"),
  ],
  db_hc: [row("boris", "Борис")],
  db_rc: [row("vera", "Вера")],
  // A note is in a story when its "Stories" relation names the story's card.
  db_notes: [row("n1", "Идея", { stn: { type: "relation", targetNoteIds: ["note_hills"] } })],
  db_anchors: [row("a1", "Гибель наставника", inAnchorStories("note_hills"))],
  db_text: [
    row("b1", "Книга первая", {
      lvl: { type: "select", optionId: "book" },
      ord: { type: "text", value: "a0" },
    }),
    row("c1", "Глава первая", {
      lvl: { type: "select", optionId: "chapter" },
      par: { type: "relation", targetNoteIds: ["b1"] },
      // The chapter names Zoya, so Zoya appears in this story.
      cast: { type: "relation", targetNoteIds: ["zoya"] },
      ord: { type: "text", value: "a0" },
    }),
    row("b2", "Книга вторая", {
      lvl: { type: "select", optionId: "book" },
      ord: { type: "text", value: "a1" },
    }),
  ],
}

/** The text as it starts, for tests that empty it and put it back. */
const TEXT_ROWS = [...ROWS.db_text]

describe("CreativePanel", () => {
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
    createDatabaseRow.mockReset().mockResolvedValue({ noteId: "new-note" })
    createWorkshopEntity.mockReset().mockResolvedValue({ noteId: "new-note", linkedStoryId: null })
    addStoryLinks.mockReset().mockResolvedValue({ propertyId: "stp", link: "stories" })
    moveTextPage.mockReset().mockResolvedValue({})
    createTextPage.mockReset().mockResolvedValue({ noteId: "new-page" })
    listTextStats.mockReset().mockResolvedValue([])
    resolveDatabaseAssetPaths
      .mockReset()
      .mockImplementation(async ({ relativePaths }: { relativePaths: string[] }) => ({
        paths: relativePaths.map(() => null),
      }))
    applyDatabaseValueBatch.mockReset().mockResolvedValue({ revisions: [], warnings: [] })
    useProjectStore.getState().reset()
    useDatabaseStore.setState({ vaultGeneration: 1, databases: DATABASES, invalidationSeq: 0 })
    useCreativeNavStore.setState({
      sectionByProject: {},
      collapsed: {},
      scope: null,
      worksOpen: { text: true, anchors: false, notes: false },
      storyFilter: null,
      dataNonce: 0,
      search: "",
      pageRequest: null,
      entityRequest: null,
      createRequest: null,
    })
  })
  afterEach(cleanup)

  it("explains that databases are needed when the module is off", () => {
    render(<CreativePanel {...props({ databaseRuntimeEnabled: false })} />)
    expect(screen.getByText("Нужен модуль «Базы данных»")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Создать" })).toBeNull()
  })

  it("offers the first project when there is none, through the chooser", () => {
    act(() => useProjectStore.getState().setCatalog(catalog([])))
    render(<CreativePanel {...props()} />)
    expect(screen.getByText("Проектов пока нет")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Новый проект" }))
    expect(screen.getByTestId("project-dialog").textContent).toBe("root")
  })

  it("opens the module's settings from the header", () => {
    act(() => useProjectStore.getState().setCatalog(world()))
    const onOpenSettings = vi.fn()
    render(<CreativePanel {...props({ onOpenSettings })} />)
    fireEvent.click(screen.getByRole("button", { name: "Настройки мастерской" }))
    expect(onOpenSettings).toHaveBeenCalledWith({ section: "modules", moduleId: "creative" })
  })

  describe("works tab", () => {
    beforeEach(() => {
      act(() => useProjectStore.getState().setCatalog(world()))
      selectScope("verse")
    })

    /** A folding part's header button, by the name of the part. */
    const part = (name: RegExp) => screen.getByRole("button", { name })

    it("shows one story from a list of the stories, with its parts as folding sections", async () => {
      render(<CreativePanel {...props()} />)
      // The first story is chosen until another is picked; the others are in the list.
      expect(selectedText("История")).toContain("MoleHills")
      expect(screen.queryByRole("button", { name: "Рассказ" })).toBeNull()
      // The text is one part, whatever the levels of the schema are called.
      for (const name of [/Текст/, /Якоря/, /Заметки/]) {
        expect(part(name)).toBeTruthy()
      }
      expect(screen.queryByRole("button", { name: /Книги|Арки/ })).toBeNull()
      // The text is unfolded at first, with what is under it.
      expect(await screen.findByText("Книга первая")).toBeTruthy()
      expect(screen.getByText("Глава первая")).toBeTruthy()
      expect(screen.queryByText("Идея")).toBeNull()
    })

    it("unfolds the anchors and the notes of the story", async () => {
      const onSelect = vi.fn()
      render(<CreativePanel {...props({ onSelect })} />)
      fireEvent.click(part(/Заметки/))
      fireEvent.click(await screen.findByText("Идея"))
      expect(onSelect).toHaveBeenLastCalledWith("n1")

      fireEvent.click(part(/Якоря/))
      fireEvent.click(await screen.findByText("Гибель наставника"))
      expect(onSelect).toHaveBeenLastCalledWith("a1")
    })

    it("shows every page of the text once, even one without a parent or without a level", async () => {
      const withStrays = [
        ...ROWS.db_text,
        // A chapter made at the top of the text, and a page whose level was deleted.
        row("c0", "Глава без родителя", {
          lvl: { type: "select", optionId: "chapter" },
          ord: { type: "text", value: "a2" },
        }),
        row("x1", "Страница без уровня", { ord: { type: "text", value: "a3" } }),
      ]
      queryDatabase.mockImplementation(async ({ databaseId }: { databaseId: string }) => {
        const rows = databaseId === "db_text" ? withStrays : (ROWS[databaseId] ?? [])
        return { rows, nextCursor: null, totalCount: rows.length, diagnostics: [] }
      })
      render(<CreativePanel {...props()} />)
      for (const title of [
        "Книга первая",
        "Глава первая",
        "Книга вторая",
        "Глава без родителя",
        "Страница без уровня",
      ]) {
        expect(await screen.findAllByText(title)).toHaveLength(1)
      }
      // The count of the part is the number of pages of the text.
      expect(part(/Свернуть: Текст/).textContent).toContain("5")
    })

    const PAGE_FIELD = "Название страницы — Enter, чтобы создать"

    it("names a page at the top level on a row of its own and creates it on Enter", async () => {
      const onSelect = vi.fn()
      render(<CreativePanel {...props({ onSelect })} />)
      await screen.findByText("Книга первая")
      const header = part(/Свернуть: Текст/).parentElement as HTMLElement
      fireEvent.click(within(header).getByRole("button", { name: "Добавить" }))
      const field = await screen.findByRole("textbox", { name: PAGE_FIELD })
      fireEvent.change(field, { target: { value: "  Пролог  " } })
      fireEvent.keyDown(field, { key: "Enter" })
      await waitFor(() => expect(createTextPage).toHaveBeenCalledTimes(1))
      // The first level of the schema is the start; the format is the manuscript one, unasked.
      expect(createTextPage.mock.calls[0][0]).toMatchObject({
        storyId: "hills",
        title: "Пролог",
        parentNoteId: null,
        levelId: "book",
        formatId: "ms",
      })
      await waitFor(() => expect(onSelect).toHaveBeenCalledWith("new-page"))
      expect(screen.queryByRole("textbox", { name: PAGE_FIELD })).toBeNull()
    })

    it("puts a page under a page one level deeper, among its pages", async () => {
      render(<CreativePanel {...props()} />)
      await screen.findByText("Глава первая")
      const book = screen.getByText("Книга первая").closest("[data-text-page]") as HTMLElement
      fireEvent.click(within(book).getByRole("button", { name: "Добавить страницу внутрь" }))
      const field = await screen.findByRole("textbox", { name: PAGE_FIELD })
      // The row stands in the book's children, not at the top.
      expect(book.parentElement?.contains(field)).toBe(true)
      fireEvent.change(field, { target: { value: "Глава вторая" } })
      fireEvent.keyDown(field, { key: "Enter" })
      await waitFor(() => expect(createTextPage).toHaveBeenCalledTimes(1))
      expect(createTextPage.mock.calls[0][0]).toMatchObject({
        parentNoteId: "b1",
        levelId: "chapter",
      })
    })

    it("cancels with Escape or an empty field, creating nothing", async () => {
      render(<CreativePanel {...props()} />)
      await screen.findByText("Книга первая")
      const header = part(/Свернуть: Текст/).parentElement as HTMLElement
      fireEvent.click(within(header).getByRole("button", { name: "Добавить" }))
      const field = await screen.findByRole("textbox", { name: PAGE_FIELD })
      fireEvent.change(field, { target: { value: "Нечто" } })
      fireEvent.keyDown(field, { key: "Escape" })
      expect(screen.queryByRole("textbox", { name: PAGE_FIELD })).toBeNull()

      fireEvent.click(within(header).getByRole("button", { name: "Добавить" }))
      const empty = await screen.findByRole("textbox", { name: PAGE_FIELD })
      // A blur right after the row appears is the closing menu taking focus, not the author.
      fireEvent.blur(empty)
      expect(screen.getByRole("textbox", { name: PAGE_FIELD })).toBeTruthy()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 350))
      })
      fireEvent.blur(screen.getByRole("textbox", { name: PAGE_FIELD }))
      expect(screen.queryByRole("textbox", { name: PAGE_FIELD })).toBeNull()
      expect(createTextPage).not.toHaveBeenCalled()
    })

    it("keeps the typed name and shows the failure on the row", async () => {
      createTextPage.mockRejectedValue(new Error("Диск недоступен"))
      render(<CreativePanel {...props()} />)
      await screen.findByText("Книга первая")
      const header = part(/Свернуть: Текст/).parentElement as HTMLElement
      fireEvent.click(within(header).getByRole("button", { name: "Добавить" }))
      const field = await screen.findByRole("textbox", { name: PAGE_FIELD })
      fireEvent.change(field, { target: { value: "Пролог" } })
      fireEvent.keyDown(field, { key: "Enter" })
      const alert = await screen.findByRole("alert")
      expect(alert.textContent).toContain("Диск недоступен")
      expect((screen.getByRole("textbox", { name: PAGE_FIELD }) as HTMLInputElement).value).toBe(
        "Пролог",
      )
    })

    it("shows the add button of a part without hovering", async () => {
      render(<CreativePanel {...props()} />)
      await screen.findByText("Книга первая")
      const button = within(part(/Свернуть: Текст/).parentElement as HTMLElement).getByRole(
        "button",
        { name: "Добавить" },
      )
      expect(button.className).not.toContain("opacity-0")
    })

    it("marks the open page, unfolds its parents and shows its words", async () => {
      listTextStats.mockResolvedValue([{ noteId: "c1", wordCount: 1240, modified: 1_700_000_000 }])
      act(() => useCreativeNavStore.setState({ collapsed: { "page:b1": true } }))
      render(<CreativePanel {...props({ selectedId: "c1" })} />)
      // The book was folded; the open page is inside it, so it unfolds.
      const chapter = (await screen.findByText("Глава первая")).closest("button") as HTMLElement
      expect(chapter.getAttribute("aria-current")).toBe("true")
      expect(await within(chapter).findByText(/^1\D?240$/)).toBeTruthy()
      expect(
        (screen.getByText("Книга первая").closest("button") as HTMLElement).getAttribute(
          "aria-current",
        ),
      ).toBeNull()
    })

    it("offers the page changed last as the place to go on from, unless it is the open one", async () => {
      listTextStats.mockResolvedValue([
        { noteId: "b1", wordCount: 0, modified: 1_700_000_000, created: 1 },
        { noteId: "c1", wordCount: 240, modified: 1_700_000_500, created: 2 },
      ])
      const onSelect = vi.fn()
      const view = render(<CreativePanel {...props({ onSelect })} />)
      fireEvent.click(await screen.findByRole("button", { name: /Продолжить: Глава первая/ }))
      expect(onSelect).toHaveBeenCalledWith("c1")
      view.rerender(<CreativePanel {...props({ onSelect, selectedId: "c1" })} />)
      await waitFor(() => expect(screen.queryByRole("button", { name: /Продолжить:/ })).toBeNull())
    })

    it("heads the story with its name and one quiet line of its numbers, shown once read", async () => {
      listTextStats.mockResolvedValue([
        { noteId: "b1", wordCount: 100, modified: 1, created: 1 },
        { noteId: "c1", wordCount: 240, modified: 2, created: 2 },
      ])
      render(<CreativePanel {...props()} />)
      const header = screen.getByRole("combobox", { name: "История" })
      expect(header.textContent).toContain("MoleHills")
      // Three pages and 340 words, read from the text and the note index.
      await waitFor(() => expect(header.textContent).toContain("3 стр."))
      await waitFor(() => expect(header.textContent).toContain("340 сл."))
    })

    it("shows no numbers under the name until they are read, not a zero", async () => {
      queryDatabase.mockImplementation(() => new Promise(() => {}))
      listTextStats.mockImplementation(() => new Promise(() => {}))
      render(<CreativePanel {...props()} />)
      const header = screen.getByRole("combobox", { name: "История" })
      expect(header.textContent).toBe("MoleHills")
    })

    it("ends the list of stories with 'New story', the same action as in Create", async () => {
      render(<CreativePanel {...props()} />)
      fireEvent.click(screen.getByRole("combobox", { name: "История" }))
      const options = await screen.findAllByRole("option")
      expect(options[options.length - 1].textContent).toContain("Новая история")
      fireEvent.click(options[options.length - 1])
      expect(await screen.findByTestId("project-dialog")).toBeTruthy()
    })

    it("names the groups quietly: the story's parts and the world", async () => {
      render(<CreativePanel {...props()} />)
      await screen.findByText("Книга первая")
      expect(screen.getByText("История", { selector: "h3" })).toBeTruthy()
      expect(screen.getByText("Мир", { selector: "h3" })).toBeTruthy()
    })

    it("offers to add the first page where the text is empty, as a row you can press", async () => {
      ROWS.db_text.splice(0)
      try {
        render(<CreativePanel {...props()} />)
        fireEvent.click(await screen.findByRole("button", { name: "Добавить первую страницу" }))
        expect(await screen.findByRole("textbox", { name: PAGE_FIELD })).toBeTruthy()
      } finally {
        ROWS.db_text.push(...TEXT_ROWS)
      }
    })

    it("offers the first anchor and the first note the same way", async () => {
      ROWS.db_anchors.splice(0)
      ROWS.db_notes.splice(0)
      try {
        render(<CreativePanel {...props()} />)
        fireEvent.click(part(/Якоря/))
        fireEvent.click(await screen.findByRole("button", { name: "Добавить первый якорь" }))
        expect(
          await screen.findByRole("textbox", { name: "Название якоря — Enter, чтобы создать" }),
        ).toBeTruthy()
        fireEvent.click(part(/Заметки/))
        fireEvent.click(await screen.findByRole("button", { name: "Добавить первую заметку" }))
        expect(
          await screen.findByRole("textbox", { name: "Название заметки — Enter, чтобы создать" }),
        ).toBeTruthy()
      } finally {
        ROWS.db_anchors.push(row("a1", "Гибель наставника", inAnchorStories("note_hills")))
        ROWS.db_notes.push(
          row("n1", "Идея", { stn: { type: "relation", targetNoteIds: ["note_hills"] } }),
        )
      }
    })

    it("keeps the old words for a story that cannot be written to", async () => {
      ROWS.db_text.splice(0)
      try {
        const base = world()
        base.workshops.find((entry) => entry.workshopId === "verse")!.readOnly = true
        act(() => useProjectStore.getState().setCatalog(base))
        render(<CreativePanel {...props()} />)
        expect(await screen.findByText("Страниц пока нет.")).toBeTruthy()
        const text = part(/Свернуть: Текст/).closest("section") as HTMLElement
        expect(within(text).queryByRole("button", { name: "Добавить первую страницу" })).toBeNull()
      } finally {
        ROWS.db_text.push(...TEXT_ROWS)
      }
    })

    it("offers a page inside only where a deeper level exists", async () => {
      render(<CreativePanel {...props()} />)
      await screen.findByText("Глава первая")
      const book = screen.getByText("Книга первая").closest("[data-text-page]") as HTMLElement
      const chapter = screen.getByText("Глава первая").closest("[data-text-page]") as HTMLElement
      expect(within(book).getByRole("button", { name: "Добавить страницу внутрь" })).toBeTruthy()
      // The chapter is the last level of this schema: nothing can go under it.
      expect(within(chapter).queryByRole("button", { name: "Добавить страницу внутрь" })).toBeNull()
    })

    it("offers to make missing anchors section when the workshop lacks one", async () => {
      const base = world()
      base.workshops[0].sections = base.workshops[0].sections.filter((s) => s.role !== "anchors")
      act(() => useProjectStore.getState().setCatalog(base))
      render(<CreativePanel {...props()} />)
      fireEvent.click(part(/Якоря/))
      fireEvent.click(await screen.findByRole("button", { name: "Создать раздел «Якоря»" }))
      expect(screen.getByTestId("section-dialog").textContent).toBe("Verse")
    })

    it("adds an anchor from the header of its part", async () => {
      render(<CreativePanel {...props()} />)
      fireEvent.click(part(/Якоря/))
      await screen.findByText("Гибель наставника")
      const header = part(/Якоря/).parentElement as HTMLElement
      fireEvent.click(within(header).getByRole("button", { name: "Добавить" }))
      // Nothing is made until it has a name.
      expect(createWorkshopEntity).not.toHaveBeenCalled()
      const field = await screen.findByRole("textbox", {
        name: "Название якоря — Enter, чтобы создать",
      })
      fireEvent.change(field, { target: { value: "Свадьба" } })
      fireEvent.keyDown(field, { key: "Enter" })
      // An anchor made while a story is shown belongs to it from the first write.
      await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
      expect(createWorkshopEntity.mock.calls[0][0]).toMatchObject({
        workshopId: "verse",
        sectionId: "anchors",
        title: "Свадьба",
        storyId: "hills",
      })
    })

    it("opens the page of the chosen story and a text page", async () => {
      const onOpenProject = vi.fn()
      const onSelect = vi.fn()
      render(<CreativePanel {...props({ onOpenCreativeProject: onOpenProject, onSelect })} />)
      fireEvent.click(screen.getByRole("button", { name: "Открыть страницу истории" }))
      expect(onOpenProject).toHaveBeenCalledWith("hills", undefined)
      fireEvent.click(await screen.findByText("Глава первая"))
      expect(onSelect).toHaveBeenLastCalledWith("c1")
    })

    it("folds a page's children", async () => {
      render(<CreativePanel {...props()} />)
      await screen.findByText("Глава первая")
      const book = screen.getByText("Книга первая").closest("[data-text-page]") as HTMLElement
      fireEvent.click(within(book).getByRole("button", { name: "Свернуть" }))
      expect(screen.queryByText("Глава первая")).toBeNull()
    })

    it("moves a page by dropping it on another and writes parent and order in one call", async () => {
      render(<CreativePanel {...props()} />)
      await screen.findByText("Глава первая")
      const dragged = screen.getByText("Глава первая").closest("[data-text-page]") as HTMLElement
      const target = screen.getByText("Книга вторая").closest("[data-text-page]") as HTMLElement
      const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" }
      fireEvent.dragStart(dragged, { dataTransfer })
      fireEvent.dragOver(target, { dataTransfer })
      fireEvent.drop(target, { dataTransfer })
      await waitFor(() => expect(moveTextPage).toHaveBeenCalledTimes(1))
      expect(moveTextPage.mock.calls[0][0]).toMatchObject({
        storyId: "hills",
        noteId: "c1",
        newParentNoteId: "b2",
        expectedRevision: "rev-c1",
      })
    })

    it("does not move a book under a chapter", async () => {
      render(<CreativePanel {...props()} />)
      await screen.findByText("Глава первая")
      const dragged = screen.getByText("Книга вторая").closest("[data-text-page]") as HTMLElement
      const target = screen.getByText("Глава первая").closest("[data-text-page]") as HTMLElement
      const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" }
      fireEvent.dragStart(dragged, { dataTransfer })
      fireEvent.dragOver(target, { dataTransfer })
      fireEvent.drop(target, { dataTransfer })
      expect(moveTextPage).not.toHaveBeenCalled()
    })
  })

  describe("world", () => {
    beforeEach(() => {
      act(() => useProjectStore.getState().setCatalog(world()))
      selectScope("verse")
    })

    const title = (name: RegExp) => screen.findByRole("button", { name })

    it("sits under the story's parts, with a folding list for each category", async () => {
      render(<CreativePanel {...props()} />)
      // The world is a region with a quiet caption of its own; it does not fold.
      expect(screen.getByRole("region", { name: "Мир" })).toBeTruthy()
      expect(screen.getByText("Мир", { selector: "h3" })).toBeTruthy()
      expect(screen.queryByRole("button", { name: /(Свернуть|Развернуть): Мир/ })).toBeNull()
      expect(screen.getByRole("button", { name: /Свернуть: Персонажи/ })).toBeTruthy()
      expect(screen.getByRole("button", { name: /Свернуть: Организации/ })).toBeTruthy()
      // There is no row of tabs any more.
      expect(screen.queryByRole("tab")).toBeNull()
      await title(/Борис/)
    })

    it("shows the chosen story's pages and those its text names, not another story's", async () => {
      render(<CreativePanel {...props()} />)
      await title(/Борис/)
      expect(screen.getByRole("button", { name: /Зоя/ })).toBeTruthy()
      // River's own character belongs to another story.
      expect(screen.queryByRole("button", { name: /Вера/ })).toBeNull()
    })

    it("gives each page a round face where a category has pictures: initials where a page has none", async () => {
      const portrait = { type: "files", items: [{ relativePath: "img/zoya.png" }] }
      const original = ROWS.db_uc[0]
      ROWS.db_uc[0] = row("zoya", "Зоя Белая", { portrait })
      // Every row counts as near the viewport, so the lookup is the thing under test.
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          constructor(private readonly callback: (entries: unknown[]) => void) {}
          observe() {
            this.callback([{ isIntersecting: true }])
          }
          disconnect() {}
        },
      )
      try {
        render(<CreativePanel {...props()} />)
        const zoya = await title(/Зоя/)
        const boris = await title(/Борис/)
        expect(zoya.querySelector('[aria-hidden="true"]')?.textContent).toBe("ЗБ")
        expect(boris.querySelector('[aria-hidden="true"]')?.textContent).toBe("Б")
        // The picture is asked for once, through the batched resolver of its database.
        await waitFor(() => expect(resolveDatabaseAssetPaths).toHaveBeenCalledTimes(1))
        expect(resolveDatabaseAssetPaths.mock.calls[0][0]).toMatchObject({
          databaseId: "db_uc",
          relativePaths: ["img/zoya.png"],
        })
      } finally {
        vi.unstubAllGlobals()
        ROWS.db_uc[0] = original
      }
    })

    it("gives a character the initials of the name until a portrait is set, reading no file", async () => {
      render(<CreativePanel {...props()} />)
      const boris = await title(/Борис/)
      expect(boris.querySelector('[aria-hidden="true"]')?.textContent).toBe("Б")
      expect(resolveDatabaseAssetPaths).not.toHaveBeenCalled()
    })

    it("does not look pictures up for a category that is folded", async () => {
      const portrait = { type: "files", items: [{ relativePath: "img/zoya.png" }] }
      const original = ROWS.db_uc[0]
      ROWS.db_uc[0] = row("zoya", "Зоя", { portrait })
      act(() => useCreativeNavStore.setState({ collapsed: { "category:characters": true } }))
      try {
        render(<CreativePanel {...props()} />)
        await waitFor(() => expect(queryDatabase).toHaveBeenCalled())
        await act(async () => {})
        expect(screen.queryByRole("button", { name: /Зоя/ })).toBeNull()
        expect(resolveDatabaseAssetPaths).not.toHaveBeenCalled()
      } finally {
        ROWS.db_uc[0] = original
      }
    })

    it("lists characters under their category", async () => {
      render(<CreativePanel {...props()} />)
      await title(/Борис/)
      expect(await title(/Анна/)).toBeTruthy()
      expect(await title(/Зоя/)).toBeTruthy()
    })

    it("lists a character just made in the shared section right away", async () => {
      selectScope("verse")
      const base = world()
      act(() => useProjectStore.getState().setCatalog(base))
      render(<CreativePanel {...props()} />)
      await title(/Анна/)
      ROWS.db_uc.push(row("nina", "Нина", inStories("note_hills")))
      try {
        act(() => useCreativeNavStore.getState().bumpData())
        expect(await title(/Нина/)).toBeTruthy()
      } finally {
        ROWS.db_uc.pop()
      }
    })

    it("groups entities by the database's grouped view", async () => {
      render(<CreativePanel {...props()} />)
      await title(/Борис/)
      expect(screen.getByText("Главные")).toBeTruthy()
      expect(await title(/Анна/)).toBeTruthy()
      expect(await title(/Зоя/)).toBeTruthy()
    })

    it("has no switch without a shared world", async () => {
      selectScope(null)
      render(<CreativePanel {...props()} />)
      expect(screen.getByRole("region", { name: "Мир" })).toBeTruthy()
      expect(screen.queryByRole("button", { name: "Вселенная" })).toBeNull()
    })

    it("folds a category", async () => {
      render(<CreativePanel {...props()} />)
      await title(/Борис/)
      fireEvent.click(screen.getByRole("button", { name: /Свернуть: Персонажи/ }))
      expect(screen.queryByRole("button", { name: /Борис/ })).toBeNull()
    })

    it("opens a page", async () => {
      const onSelect = vi.fn()
      render(<CreativePanel {...props({ onSelect })} />)
      fireEvent.click(await title(/Борис/))
      expect(onSelect).toHaveBeenCalledWith("boris")
    })

    it("adds a page to a category from its row", async () => {
      const onSelect = vi.fn()
      render(<CreativePanel {...props({ onSelect })} />)
      await title(/Борис/)
      fireEvent.click(screen.getByRole("button", { name: "Добавить: Персонажи" }))
      const field = await screen.findByRole("textbox", { name: "Название — Персонажи" })
      fireEvent.change(field, { target: { value: "Марта" } })
      fireEvent.keyDown(field, { key: "Enter" })
      await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
      // Made while MoleHills is shown, the page is born linked to it.
      expect(createWorkshopEntity.mock.calls[0][0]).toMatchObject({
        workshopId: "verse",
        sectionId: "chars",
        title: "Марта",
        storyId: "hills",
      })
      await waitFor(() => expect(onSelect).toHaveBeenCalledWith("new-note"))
    })

    it("puts a page made from the chooser in the shared section", async () => {
      render(<CreativePanel {...props()} />)
      await title(/Борис/)
      fireEvent.click(screen.getByRole("button", { name: "Создать" }))
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: /Новая страница: Персонажи/,
        }),
      )
      const field = await screen.findByRole("textbox", { name: "Название — Персонажи" })
      fireEvent.change(field, { target: { value: "Нина" } })
      fireEvent.keyDown(field, { key: "Enter" })
      await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
      expect(createWorkshopEntity.mock.calls[0][0]).toMatchObject({
        sectionId: "chars",
        title: "Нина",
        storyId: "hills",
      })
    })

    it("offers the frequent things first in the chooser and the rare ones after a heading", async () => {
      render(<CreativePanel {...props()} />)
      await title(/Борис/)
      fireEvent.click(screen.getByRole("button", { name: "Создать" }))
      const dialog = within(screen.getByRole("dialog"))
      const names = dialog.getAllByRole("button").map((button) => button.textContent ?? "")
      const at = (pattern: RegExp) => names.findIndex((name) => pattern.test(name))
      expect(at(/^Новая страница(?!:)/)).toBeGreaterThanOrEqual(0)
      expect(at(/^Новая страница: Персонажи/)).toBeGreaterThanOrEqual(0)
      expect(dialog.getByText("Нужно реже")).toBeTruthy()
      // A story, a section and a universe come after the frequent ones.
      const rareIndices = [at(/(?:Новая )?История/), at(/^Раздел/), at(/^Вселенная/)].filter(
        (i) => i >= 0,
      )
      const rareStart = Math.min(...rareIndices)
      expect(Math.max(at(/^Новая страница(?!:)/), at(/^Новая страница: Персонажи/))).toBeLessThan(
        rareStart,
      )
    })

    it("has one search above everything that looks through every list at once", async () => {
      render(<CreativePanel {...props()} />)
      const search = screen.getByRole("textbox", { name: "Поиск" })
      const selector = screen.getByRole("combobox", { name: "История" })
      // Above the story list and the world, not under them.
      expect(
        search.compareDocumentPosition(selector) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()

      // It finds a page under the category it belongs to...
      fireEvent.change(search, { target: { value: "зоя" } })
      expect(await title(/Зоя/)).toBeTruthy()
      expect(screen.getByText("Персонажи", { selector: "h3 span" })).toBeTruthy()

      // ...and the pages of a story's text.
      fireEvent.change(search, { target: { value: "перв" } })
      expect(await title(/Книга первая/)).toBeTruthy()
      expect(screen.getByRole("button", { name: /Глава первая/ })).toBeTruthy()
      expect(screen.getByText("Истории", { selector: "h3 span" })).toBeTruthy()
      // Anchors and notes are searched too.
      fireEvent.change(search, { target: { value: "наставн" } })
      expect(await title(/Гибель наставника/)).toBeTruthy()

      // Cleared, the story and its parts come back.
      fireEvent.change(search, { target: { value: "" } })
      await waitFor(() => expect(selectedText("История")).toContain("MoleHills"))
    })

    it("says so when nothing is found", async () => {
      render(<CreativePanel {...props()} />)
      await title(/Борис/)
      fireEvent.change(screen.getByRole("textbox", { name: "Поиск" }), {
        target: { value: "нет такого" },
      })
      expect(await screen.findByText("Ничего не найдено.")).toBeTruthy()
    })
  })

  it("adds a section from the chooser to the workshop", () => {
    act(() => useProjectStore.getState().setCatalog(world()))
    selectScope("tale")
    const alone = render(<CreativePanel {...props()} />)
    fireEvent.click(screen.getByRole("button", { name: "Создать" }))
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Раздел/ }))
    expect(screen.getByTestId("section-dialog").textContent).toBe("Рассказ")
    alone.unmount()

    selectScope("verse")
    render(<CreativePanel {...props()} />)
    fireEvent.click(screen.getByRole("button", { name: "Создать" }))
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Раздел/ }))
    expect(screen.getByTestId("section-dialog").textContent).toBe("Verse")
  })

  it("has no plus beside the world: pages are added in the categories themselves", async () => {
    act(() => useProjectStore.getState().setCatalog(world()))
    selectScope("verse")
    render(<CreativePanel {...props()} />)
    await screen.findByRole("button", { name: /Борис/ })
    const region = screen.getByRole("region", { name: "Мир" })
    expect(within(region).queryByRole("button", { name: "Раздел" })).toBeNull()
  })

  describe("context menus", () => {
    beforeEach(() => {
      act(() => useProjectStore.getState().setCatalog(world()))
      selectScope("verse")
    })

    it("deletes a page of the world from its own menu, the way the file tree does", async () => {
      const onDelete = vi.fn()
      render(<CreativePanel {...props({ onDelete })} />)
      fireEvent.contextMenu(await screen.findByRole("button", { name: /Борис/ }))
      fireEvent.click(await screen.findByRole("menuitem", { name: "Удалить" }))
      expect(onDelete).toHaveBeenCalledWith("boris")
    })

    it("says a page's nested pages go with it, and asks for all of them at once", async () => {
      const onDelete = vi.fn()
      const onDeleteMany = vi.fn()
      render(<CreativePanel {...props({ onDelete, onDeleteMany })} />)
      // "Книга первая" holds one chapter; "Книга вторая" holds nothing.
      fireEvent.contextMenu(await screen.findByText("Книга первая"))
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Удалить вместе с вложенными (1)" }),
      )
      expect(onDeleteMany).toHaveBeenCalledWith(["b1", "c1"])
      expect(onDelete).not.toHaveBeenCalled()

      fireEvent.contextMenu(screen.getByText("Книга вторая"))
      fireEvent.click(await screen.findByRole("menuitem", { name: "Удалить" }))
      expect(onDelete).toHaveBeenCalledWith("b2")
    })

    it("renames a page in place, where its row is, and keeps the name only on Enter", async () => {
      const onRename = vi.fn()
      render(<CreativePanel {...props({ onRename })} />)
      fireEvent.contextMenu(await screen.findByRole("button", { name: /Борис/ }))
      fireEvent.click(await screen.findByRole("menuitem", { name: "Переименовать" }))
      const field = (await screen.findByRole("textbox", {
        name: "Переименовать",
      })) as HTMLInputElement
      // No dialog: the field takes the place of the row.
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(field.value).toBe("Борис")
      fireEvent.change(field, { target: { value: "Борис Громов" } })
      fireEvent.keyDown(field, { key: "Enter" })
      expect(onRename).toHaveBeenCalledWith("boris", "Борис Громов")
      await waitFor(() =>
        expect(screen.queryByRole("textbox", { name: "Переименовать" })).toBeNull(),
      )
      expect(screen.getByRole("button", { name: /Борис/ })).toBeTruthy()
    })

    it("leaves the name alone on Escape or when nothing was changed", async () => {
      const onRename = vi.fn()
      render(<CreativePanel {...props({ onRename })} />)
      fireEvent.contextMenu(await screen.findByRole("button", { name: /Борис/ }))
      fireEvent.click(await screen.findByRole("menuitem", { name: "Переименовать" }))
      const field = await screen.findByRole("textbox", { name: "Переименовать" })
      fireEvent.change(field, { target: { value: "Другое" } })
      fireEvent.keyDown(field, { key: "Escape" })
      expect(onRename).not.toHaveBeenCalled()

      fireEvent.contextMenu(await screen.findByRole("button", { name: /Борис/ }))
      fireEvent.click(await screen.findByRole("menuitem", { name: "Переименовать" }))
      fireEvent.keyDown(await screen.findByRole("textbox", { name: "Переименовать" }), {
        key: "Enter",
      })
      expect(onRename).not.toHaveBeenCalled()
    })

    it("has the same menu on a page of the text, and opens it in a new tab", async () => {
      const onOpenInNewTab = vi.fn()
      render(<CreativePanel {...props({ onOpenInNewTab })} />)
      fireEvent.contextMenu(await screen.findByText("Книга первая"))
      fireEvent.click(await screen.findByRole("menuitem", { name: "Открыть в новой вкладке" }))
      expect(onOpenInNewTab).toHaveBeenCalledWith("b1")
    })

    it("starts a named row from the menu of the empty space", async () => {
      render(<CreativePanel {...props()} />)
      await screen.findByRole("button", { name: /Борис/ })
      fireEvent.contextMenu(screen.getByRole("region", { name: "Мир" }))
      fireEvent.click(await screen.findByRole("menuitem", { name: /Новая страница: Персонажи/ }))
      const field = await screen.findByRole("textbox", { name: "Название — Персонажи" })
      fireEvent.change(field, { target: { value: "Лев" } })
      fireEvent.keyDown(field, { key: "Enter" })
      await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
      expect(createWorkshopEntity.mock.calls[0][0]).toMatchObject({
        sectionId: "chars",
        title: "Лев",
        storyId: "hills",
      })
    })

    it("opens only the menu of the row, not the menu of the empty space as well", async () => {
      render(<CreativePanel {...props({ onDelete: vi.fn() })} />)
      fireEvent.contextMenu(await screen.findByRole("button", { name: /Борис/ }))
      await screen.findByRole("menuitem", { name: "Удалить" })
      expect(screen.queryByRole("menuitem", { name: /Новая страница: / })).toBeNull()
    })

    it("changes a text page's status from its context menu when status is configured", async () => {
      const base = world()
      const verse = base.workshops.find((entry) => entry.workshopId === "verse")!
      const hills = verse.stories.find((entry) => entry.storyId === "hills")!
      hills.text = {
        ...TEXT,
        properties: { ...TEXT.properties, status: "stat" },
        statusOptions: [
          { id: "st_draft", name: "Черновик", color: "gray", group: "notStarted" },
          { id: "st_wip", name: "В работе", color: "amber", group: "inProgress" },
          { id: "st_done", name: "Готово", color: "green", group: "done" },
        ],
      }
      act(() => useProjectStore.getState().setCatalog(base))
      render(<CreativePanel {...props()} />)

      fireEvent.contextMenu(await screen.findByText("Глава первая"))
      fireEvent.click(await screen.findByRole("menuitem", { name: "Готово" }))

      await waitFor(() => expect(applyDatabaseValueBatch).toHaveBeenCalledTimes(1))
      expect(applyDatabaseValueBatch.mock.calls[0][0]).toMatchObject({
        databaseId: "db_text",
        cells: [
          {
            noteId: "c1",
            propertyId: "stat",
            valueJson: JSON.stringify({ type: "status", optionId: "st_done" }),
            expectedRevision: "rev-c1",
          },
        ],
      })
    })
  })

  it("offers no section to a read-only project", () => {
    const locked = project("locked", { readOnly: true, name: "Locked" })
    act(() => useProjectStore.getState().setCatalog(catalog([locked])))
    render(<CreativePanel {...props()} />)
    expect(screen.queryByRole("button", { name: "Раздел" })).toBeNull()
  })

  it("counts diagnostics and shows them on request", () => {
    act(() =>
      useProjectStore.getState().setCatalog(
        catalog([project("a")], {
          diagnostics: [
            {
              code: "duplicateWorkshopId",
              severity: "error",
              path: "B/amby-workshop.json",
              workshopId: "a",
              storyId: null,
              detail: null,
            },
            {
              code: "legacyProjectFormat",
              severity: "warning",
              path: "C/amby-workshop.json",
              workshopId: null,
              storyId: null,
              detail: null,
            },
          ],
        }),
      ),
    )
    render(<CreativePanel {...props()} />)
    fireEvent.click(screen.getByText("2 замечания к проектам"))
    expect(screen.getByText("B/amby-workshop.json")).toBeTruthy()
    expect(
      screen.getByText(
        "Проект прежнего формата: открыт как обычные папки и базы, модуль его не меняет",
      ),
    ).toBeTruthy()
  })

  it("switches the scope from the switcher and shows that scope's stories", async () => {
    act(() => useProjectStore.getState().setCatalog(world()))
    selectScope("verse")
    render(<CreativePanel {...props()} />)
    expect(await screen.findByText("MoleHills")).toBeTruthy()
  })

  it("remembers the scope and the chosen story per vault", async () => {
    localStorage.clear()
    act(() => useProjectStore.getState().setCatalog(world()))
    selectScope("verse")
    const first = render(<CreativePanel {...props({ vault: "/vaults/one" })} />)
    expect(await screen.findByRole("button", { name: /Анна/ })).toBeTruthy()

    // The workshop is chosen in the switcher; the story in the list of stories.
    const switchTo = async (name: RegExp) => {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Сменить мастерскую" }), {
        button: 0,
        ctrlKey: false,
      })
      fireEvent.click(await screen.findByRole("menuitem", { name }))
    }
    await switchTo(/Рассказ/)
    expect(JSON.parse(localStorage.getItem("amby:creative-scope") ?? "{}")).toEqual({
      "/vaults/one": "tale",
    })
    await switchTo(/Verse/)
    expect(JSON.parse(localStorage.getItem("amby:creative-scope") ?? "{}")).toEqual({
      "/vaults/one": "verse",
    })
    fireEvent.click(screen.getByRole("combobox", { name: "История" }))
    fireEvent.click(await screen.findByRole("option", { name: /River/ }))
    expect(JSON.parse(localStorage.getItem("amby:creative-workshop") ?? "{}")).toEqual({
      "/vaults/one": { story: "river" },
    })
    first.unmount()

    // The next time the vault opens, both are read back.
    act(() => useCreativeNavStore.setState({ scope: null, storyFilter: null }))
    render(<CreativePanel {...props({ vault: "/vaults/one" })} />)
    await waitFor(() => expect(selectedText("История")).toContain("River"))
    expect(useCreativeNavStore.getState().scope).toBe("verse")
  })

  it("offers a section in the chooser inside a workshop", () => {
    act(() => useProjectStore.getState().setCatalog(world()))
    selectScope("verse")
    render(<CreativePanel {...props()} />)
    fireEvent.click(screen.getByRole("button", { name: "Создать" }))
    const inside = screen.getByRole("dialog")
    fireEvent.click(within(inside).getByRole("button", { name: /Раздел/ }))
    expect(screen.getByTestId("section-dialog").textContent).toBe("Verse")
  })

  it("opens the dialog for a story or a universe asked for from the empty tab", async () => {
    act(() => useProjectStore.getState().setCatalog(world()))
    selectScope("verse")
    render(<CreativePanel {...props()} />)

    act(() => useCreativeNavStore.getState().requestCreate("story"))
    // A story goes into the collection the sidebar shows.
    expect((await screen.findByTestId("project-dialog")).textContent).toBe("Verse")
    expect(useCreativeNavStore.getState().createRequest).toBeNull()
  })

  it("keeps a request until the catalog is there, then consumes it once", async () => {
    act(() => useCreativeNavStore.getState().requestCreate("universe"))
    render(<CreativePanel {...props()} />)
    expect(screen.queryByTestId("project-dialog")).toBeNull()
    expect(useCreativeNavStore.getState().createRequest).toBe("universe")

    act(() => useProjectStore.getState().setCatalog(world()))
    expect((await screen.findByTestId("project-dialog")).textContent).toBe("Verse")
    expect(useCreativeNavStore.getState().createRequest).toBeNull()
  })

  it("shows a load failure with a retry", () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    act(() => {
      useProjectStore.getState().setRefresh(refresh)
      useProjectStore.getState().setError("boom")
    })
    render(<CreativePanel {...props()} />)
    expect(screen.getByText("boom")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }))
    expect(refresh).toHaveBeenCalledWith(true)
  })
})
