// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseRow, DatabaseSummary, ProjectCatalog } from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"
import { useDatabaseStore } from "../database/database-store"
import { CreativePanel } from "./creative-panel"
import { useCreativeNavStore } from "./creative-nav-store"
import { chooseOption, selectedText } from "@/lib/test-utils/amby-select"
import { catalog, project, section } from "./project-fixtures.test-support"
import { useProjectStore } from "./project-store"

const queryDatabase = vi.fn()
const createDatabaseRow = vi.fn()
const moveTextPage = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>()
  return {
    ...original,
    queryDatabase: (...args: unknown[]) => queryDatabase(...args),
    createDatabaseRow: (...args: unknown[]) => createDatabaseRow(...args),
    moveTextPage: (...args: unknown[]) => moveTextPage(...args),
  }
})
vi.mock("./create-project-dialog", () => ({
  CreateProjectDialog: (props: { open: boolean; parent?: { name: string } | null }) =>
    props.open ? <div data-testid="project-dialog">{props.parent?.name ?? "root"}</div> : null,
}))
vi.mock("./create-section-dialog", () => ({
  CreateSectionDialog: (props: { project: { name: string } }) => (
    <div data-testid="section-dialog">{props.project.name}</div>
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
  properties: { level: "lvl", parent: "par", order: "ord", format: null },
  levels: [
    { id: "book", icon: null, name: "Книга", color: null, state: "ok" as const },
    { id: "chapter", icon: null, name: "Глава", color: null, state: "ok" as const },
  ],
  formats: [{ id: "ms", kind: "manuscript", name: "Рукопись", color: null, state: "ok" as const }],
}

/** A universe with shared characters, one story with its own, and a stand-alone story. */
function world(): ProjectCatalog {
  const universe = project("verse", {
    kind: "collection",
    name: "Verse",
    path: "Verse",
    groups: [{ id: "world", name: "Мир" }],
    sections: [
      section("chars", {
        role: "characters",
        groupId: "world",
        databaseId: "db_uc",
        databaseName: "Персонажи",
      }),
      section("orgs", { role: null, databaseId: "db_uo", databaseName: "Организации" }),
    ],
  })
  const story = project("hills", {
    name: "MoleHills",
    path: "Verse/MoleHills",
    collectionId: "verse",
    text: TEXT,
    sections: [
      section("text", { role: "text", databaseId: "db_text", databaseName: "Текст" }),
      section("notes", { role: "notes", databaseId: "db_notes", databaseName: "Заметки" }),
      section("chars", { role: "characters", databaseId: "db_hc", databaseName: "Персонажи" }),
      section("anchors", { role: "anchors", databaseId: "db_anchors", databaseName: "Якоря" }),
    ],
  })
  const other = project("river", {
    name: "River",
    path: "Verse/River",
    collectionId: "verse",
    sections: [
      section("chars", { role: "characters", databaseId: "db_rc", databaseName: "Персонажи" }),
    ],
  })
  return catalog([universe, story, other, project("tale", { name: "Рассказ" })])
}

const importance = { type: "select", optionId: "main" }
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
  db_uc: [row("zoya", "Зоя"), row("anna", "Анна", { imp: importance })],
  db_hc: [row("boris", "Борис")],
  db_rc: [row("vera", "Вера")],
  db_notes: [row("n1", "Идея")],
  db_anchors: [row("a1", "Гибель наставника")],
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
    moveTextPage.mockReset().mockResolvedValue({})
    useProjectStore.getState().reset()
    useDatabaseStore.setState({ vaultGeneration: 1, databases: DATABASES, invalidationSeq: 0 })
    useCreativeNavStore.setState({
      sectionByProject: {},
      collapsed: {},
      scope: null,
      worksOpen: { books: true, arcs: false, anchors: false, notes: false },
      storyFilter: null,
      worldScope: "story",
      dataNonce: 0,
      search: "",
      pageRequest: null,
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
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Вселенная/ }))
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
      expect(selectedText("Произведение")).toContain("MoleHills")
      expect(screen.queryByRole("button", { name: "Рассказ" })).toBeNull()
      // The template's level names read as plurals; the author's own are shown as they are.
      for (const name of [/Книги/, /Глава/, /Якоря/, /Заметки/]) {
        expect(part(name)).toBeTruthy()
      }
      // Books are unfolded at first, with what is under them.
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

    it("lists the pages of the second level wherever they sit", async () => {
      render(<CreativePanel {...props()} />)
      fireEvent.click(part(/Свернуть: Книги/))
      fireEvent.click(part(/Глава/))
      expect(await screen.findByText("Глава первая")).toBeTruthy()
      expect(screen.queryByText("Книга первая")).toBeNull()
    })

    it("switches to another story and offers to make its missing anchors section", async () => {
      render(<CreativePanel {...props()} />)
      await chooseOption("Произведение", "River")
      expect(selectedText("Произведение")).toContain("River")
      expect(screen.queryByText("Книга первая")).toBeNull()
      fireEvent.click(part(/Якоря/))
      fireEvent.click(await screen.findByRole("button", { name: "Создать раздел «Якоря»" }))
      expect(screen.getByTestId("section-dialog").textContent).toBe("River")
    })

    it("adds an anchor from the header of its part", async () => {
      render(<CreativePanel {...props()} />)
      fireEvent.click(part(/Якоря/))
      await screen.findByText("Гибель наставника")
      const header = part(/Якоря/).parentElement as HTMLElement
      fireEvent.click(within(header).getByRole("button", { name: "Добавить" }))
      await waitFor(() => expect(createDatabaseRow).toHaveBeenCalledTimes(1))
      expect(createDatabaseRow.mock.calls[0][0]).toMatchObject({
        databaseId: "db_anchors",
        template: { kind: "default" },
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
        projectId: "hills",
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
      // The world has no visible name and does not fold; it is a region for screen readers.
      expect(screen.getByRole("region", { name: "Мир" })).toBeTruthy()
      expect(screen.queryByText("Мир", { selector: "h3" })).toBeNull()
      expect(screen.queryByRole("button", { name: /(Свернуть|Развернуть): Мир/ })).toBeNull()
      expect(screen.getByRole("button", { name: /Свернуть: Персонажи/ })).toBeTruthy()
      expect(screen.getByRole("button", { name: /Свернуть: Организации/ })).toBeTruthy()
      // There is no row of tabs any more.
      expect(screen.queryByRole("tab")).toBeNull()
      await title(/Борис/)
    })

    it("shows only the chosen story's pages: its own and those its text names", async () => {
      render(<CreativePanel {...props()} />)
      await title(/Борис/)
      expect(screen.getByRole("button", { name: /Зоя/ })).toBeTruthy()
      expect(screen.queryByRole("button", { name: /Вера/ })).toBeNull()
      expect(screen.queryByRole("button", { name: /Анна/ })).toBeNull()
    })

    it("widens to the whole universe with the switch beside it, and labels the stories", async () => {
      render(<CreativePanel {...props()} />)
      await title(/Борис/)
      fireEvent.click(screen.getByRole("button", { name: "Вселенная" }))
      for (const name of [/Анна/, /Зоя/, /Борис/, /Вера/]) {
        expect(await title(name)).toBeTruthy()
      }
      // Importance groups come from the database's grouped view.
      expect(screen.getByText("Главные")).toBeTruthy()
      // Boris lives in MoleHills; Zoya is named in its text, so she is in it too.
      expect(
        within(screen.getByRole("button", { name: /Борис/ })).getByText("MoleHills"),
      ).toBeTruthy()
      expect(
        within(screen.getByRole("button", { name: /Зоя/ })).getByText("MoleHills"),
      ).toBeTruthy()

      fireEvent.click(screen.getByRole("button", { name: "История" }))
      expect(screen.queryByRole("button", { name: /Вера/ })).toBeNull()
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

    it("adds a page to a category from its row, in the chosen story's section", async () => {
      const onSelect = vi.fn()
      render(<CreativePanel {...props({ onSelect })} />)
      await title(/Борис/)
      fireEvent.click(screen.getByRole("button", { name: "Добавить: Персонажи" }))
      await waitFor(() => expect(createDatabaseRow).toHaveBeenCalledTimes(1))
      expect(createDatabaseRow.mock.calls[0][0]).toMatchObject({
        databaseId: "db_hc",
        template: { kind: "default" },
      })
      await waitFor(() => expect(onSelect).toHaveBeenCalledWith("new-note"))
    })

    it("puts a page made from the chooser in the shared section when the world shows the universe", async () => {
      render(<CreativePanel {...props()} />)
      await title(/Борис/)
      fireEvent.click(screen.getByRole("button", { name: "Вселенная" }))
      fireEvent.click(screen.getByRole("button", { name: "Создать" }))
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: /Новая запись: Персонажи/ }),
      )
      await waitFor(() => expect(createDatabaseRow).toHaveBeenCalledTimes(1))
      expect(createDatabaseRow.mock.calls[0][0]).toMatchObject({ databaseId: "db_uc" })
    })

    it("has one search above everything that looks through every list at once", async () => {
      render(<CreativePanel {...props()} />)
      const search = screen.getByRole("textbox", { name: "Поиск" })
      const selector = screen.getByRole("combobox", { name: "Произведение" })
      // Above the story list and the world, not under them.
      expect(
        search.compareDocumentPosition(selector) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()

      // It finds a page the world does not show (River's), under the category it belongs to...
      fireEvent.change(search, { target: { value: "вера" } })
      expect(await title(/Вера/)).toBeTruthy()
      expect(screen.getByText("Персонажи", { selector: "h3 span" })).toBeTruthy()

      // ...and the pages of a story's text.
      fireEvent.change(search, { target: { value: "перв" } })
      expect(await title(/Книга первая/)).toBeTruthy()
      expect(screen.getByRole("button", { name: /Глава первая/ })).toBeTruthy()
      expect(screen.getByText("Произведения", { selector: "h3 span" })).toBeTruthy()
      // Anchors and notes are searched too.
      fireEvent.change(search, { target: { value: "наставн" } })
      expect(await title(/Гибель наставника/)).toBeTruthy()

      // Cleared, the story and its parts come back.
      fireEvent.change(search, { target: { value: "" } })
      await waitFor(() => expect(selectedText("Произведение")).toContain("MoleHills"))
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

  it("adds a section from the chooser: to the shown story, and to the collection when inside one", () => {
    act(() => useProjectStore.getState().setCatalog(world()))
    selectScope(null)
    const alone = render(<CreativePanel {...props()} />)
    fireEvent.click(screen.getByRole("button", { name: "Создать" }))
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^Раздел в «Рассказ»/ }),
    )
    expect(screen.getByTestId("section-dialog").textContent).toBe("Рассказ")
    alone.unmount()

    selectScope("verse")
    render(<CreativePanel {...props()} />)
    fireEvent.click(screen.getByRole("button", { name: "Создать" }))
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^Раздел в «MoleHills»/ }),
    )
    expect(screen.getByTestId("section-dialog").textContent).toBe("MoleHills")
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

    it("creates on the spot from the menu of the empty space", async () => {
      render(<CreativePanel {...props()} />)
      await screen.findByRole("button", { name: /Борис/ })
      fireEvent.contextMenu(screen.getByRole("region", { name: "Мир" }))
      fireEvent.click(await screen.findByRole("menuitem", { name: /Новая запись: Персонажи/ }))
      await waitFor(() => expect(createDatabaseRow).toHaveBeenCalledTimes(1))
      expect(createDatabaseRow.mock.calls[0][0]).toMatchObject({ databaseId: "db_hc" })
    })

    it("opens only the menu of the row, not the menu of the empty space as well", async () => {
      render(<CreativePanel {...props({ onDelete: vi.fn() })} />)
      fireEvent.contextMenu(await screen.findByRole("button", { name: /Борис/ }))
      await screen.findByRole("menuitem", { name: "Удалить" })
      expect(screen.queryByRole("menuitem", { name: /Новая запись/ })).toBeNull()
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
              code: "duplicateProjectId",
              severity: "error",
              path: "B/amby-project.json",
              projectId: "a",
              detail: null,
            },
            {
              code: "nestedCollection",
              severity: "warning",
              path: "C/amby-project.json",
              projectId: null,
              detail: null,
            },
          ],
        }),
      ),
    )
    render(<CreativePanel {...props()} />)
    fireEvent.click(screen.getByText("2 замечания к проектам"))
    expect(screen.getByText("B/amby-project.json")).toBeTruthy()
    expect(screen.getByText("Сборник внутри сборника не поддерживается")).toBeTruthy()
  })

  it("switches the scope from the switcher and shows that scope's stories", async () => {
    act(() => useProjectStore.getState().setCatalog(world()))
    render(<CreativePanel {...props()} />)
    expect(selectedText("Произведение")).toContain("Рассказ")

    fireEvent.pointerDown(screen.getByRole("button", { name: "Сменить вселенную или сборник" }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.click(screen.getByRole("menuitem", { name: /Verse/ }))
    expect(selectedText("Произведение")).toContain("MoleHills")
    expect(selectedText("Произведение")).not.toContain("Рассказ")
  })

  it("remembers the scope, the chosen story and what the world shows per vault", async () => {
    act(() => useProjectStore.getState().setCatalog(world()))
    const first = render(<CreativePanel {...props({ vault: "/vaults/one" })} />)
    fireEvent.pointerDown(screen.getByRole("button", { name: "Сменить вселенную или сборник" }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.click(screen.getByRole("menuitem", { name: /Verse/ }))
    fireEvent.click(screen.getByRole("button", { name: "Вселенная" }))
    expect(JSON.parse(localStorage.getItem("amby:creative-scope") ?? "{}")).toEqual({
      "/vaults/one": "verse",
    })
    expect(JSON.parse(localStorage.getItem("amby:creative-workshop") ?? "{}")).toEqual({
      "/vaults/one": { world: "universe" },
    })
    first.unmount()

    act(() => useCreativeNavStore.setState({ scope: null, worldScope: "story" }))
    render(<CreativePanel {...props({ vault: "/vaults/one" })} />)
    expect(await screen.findByRole("button", { name: /Анна/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Вселенная", pressed: true })).toBeTruthy()
  })

  it("offers a section in the chooser only inside a collection", () => {
    act(() => useProjectStore.getState().setCatalog(world()))
    const view = render(<CreativePanel {...props()} />)
    fireEvent.click(screen.getByRole("button", { name: "Создать" }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByRole("button", { name: /^История/ })).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: /^Раздел\s*Общий/ })).toBeNull()
    fireEvent.click(within(dialog).getByRole("button", { name: /^Вселенная/ }))
    view.unmount()

    selectScope("verse")
    render(<CreativePanel {...props()} />)
    fireEvent.click(screen.getByRole("button", { name: "Создать" }))
    const inside = screen.getByRole("dialog")
    fireEvent.click(within(inside).getByRole("button", { name: /^Раздел\s*Общий/ }))
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
    expect((await screen.findByTestId("project-dialog")).textContent).toBe("root")
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
