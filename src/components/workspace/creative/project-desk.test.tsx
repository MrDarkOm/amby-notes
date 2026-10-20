// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseRow } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import {
  storySummary,
  workshopSection as section,
  workshopSummary,
} from "./project-fixtures.test-support"
import type { DeskItem } from "./desk/desk-layout-model"
import { ProjectDesk } from "./project-desk"

const queryDatabase = vi.fn()
const createWorkshopEntity = vi.fn()
const listTextStats = vi.fn()
const readNote = vi.fn()
const exportTextFile = vi.fn()
const createTextPage = vi.fn()
const moveTextPage = vi.fn()
const listNotebooks = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>()
  return {
    ...original,
    queryDatabase: (...args: unknown[]) => queryDatabase(...args),
    listTextStats: (...args: unknown[]) => listTextStats(...args),
    readNote: (...args: unknown[]) => readNote(...args),
    exportTextFile: (...args: unknown[]) => exportTextFile(...args),
    createWorkshopEntity: (...args: unknown[]) => createWorkshopEntity(...args),
    createTextPage: (...args: unknown[]) => createTextPage(...args),
    moveTextPage: (...args: unknown[]) => moveTextPage(...args),
    listNotebooks: (...args: unknown[]) => listNotebooks(...args),
    resolveDatabaseAssetPaths: async () => ({ paths: [] }),
  }
})

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

const story = storySummary("hills", {
  name: "MoleHills",
  workshopId: "w_hills",
  databaseId: "db_text",
  text: {
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
    formats: [],
    statusOptions: [],
  },
})

const workshop = workshopSummary("w_hills", {
  name: "MoleHills Workshop",
  stories: [story],
  sections: [section("text", { role: "text", databaseId: "db_text", databaseName: "Текст" })],
})

const ROWS = [
  row("b1", "Книга первая", {
    lvl: { type: "select", optionId: "book" },
    ord: { type: "text", value: "a0" },
  }),
  row("c1", "Глава первая", {
    lvl: { type: "select", optionId: "chapter" },
    par: { type: "relation", targetNoteIds: ["b1"] },
    ord: { type: "text", value: "a0" },
  }),
  row("c2", "Глава вторая", {
    lvl: { type: "select", optionId: "chapter" },
    par: { type: "relation", targetNoteIds: ["b1"] },
    ord: { type: "text", value: "a1" },
  }),
  row("b2", "Книга вторая", {
    lvl: { type: "select", optionId: "book" },
    ord: { type: "text", value: "a1" },
  }),
]

const NOW = Math.floor(Date.now() / 1000)
const STATS = [
  { noteId: "c1", wordCount: 1200, modified: NOW - 60 * 60 * 5, created: 1 },
  { noteId: "c2", wordCount: 300, modified: NOW - 60 * 5, created: 2 },
  { noteId: "b1", wordCount: 0, modified: NOW - 60 * 60 * 24 * 3, created: 0 },
  { noteId: "b2", wordCount: 80, modified: NOW - 60 * 60 * 24 * 9, created: 3 },
]

const NOTES: Record<string, string> = {
  b1: "---\ntitle: Книга\n---\n",
  c1: "---\nstatus: draft\n---\nНачало пути.",
  c2: "Дорога дальше.",
  b2: "Эпилог.",
}

function renderDesk(onOpenNote = vi.fn(), vaultPath: string | null = "/vault") {
  render(
    <ProjectDesk story={story} workshop={workshop} vaultPath={vaultPath} onOpenNote={onOpenNote} />,
  )
  return onOpenNote
}

describe("ProjectDesk", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    queryDatabase.mockReset().mockResolvedValue({
      rows: ROWS,
      nextCursor: null,
      totalCount: ROWS.length,
      diagnostics: [],
    })
    listTextStats.mockReset().mockResolvedValue(STATS)
    readNote.mockReset().mockImplementation(async (_vault: string, noteId: string) => ({
      content: NOTES[noteId] ?? "",
      revision: "r",
      source: "disk",
    }))
    exportTextFile.mockReset().mockResolvedValue("/home/me/MoleHills.md")
    createTextPage.mockReset().mockResolvedValue({ noteId: "new" })
    moveTextPage.mockReset().mockResolvedValue({})
    listNotebooks.mockReset().mockResolvedValue({
      databaseId: "db_notes",
      containerPath: "notes",
      rootItemCount: 0,
      notebooks: [{ segments: ["Идеи"], path: "notes/Идеи", itemCount: 1 }],
    })
    useDatabaseStore.setState({ vaultGeneration: 1, invalidationSeq: 0 })
  })
  afterEach(cleanup)

  it("offers the page changed last to continue with, and only that one", async () => {
    const onOpenNote = renderDesk()
    const widget = await screen.findByRole("region", { name: "Продолжить" })
    await within(widget).findByText("Глава вторая")
    expect(widget.textContent).toContain("Глава")
    expect(widget.textContent).toContain("300 сл.")
    // The older pages are not listed here any more: the outline has them.
    expect(within(widget).queryByText("Глава первая")).toBeNull()
    fireEvent.click(within(widget).getByRole("button", { name: "Писать" }))
    expect(onOpenNote).toHaveBeenCalledWith("c2")
  })

  it("shows the progress: pages and words, with no bar when the story keeps no page status", async () => {
    renderDesk()
    const widget = await screen.findByRole("region", { name: "Прогресс" })
    await waitFor(() => expect(widget.textContent).toContain("Страниц: 4"))
    expect(widget.textContent).toContain((1580).toLocaleString())
    expect(within(widget).queryByRole("progressbar")).toBeNull()
  })

  it("outlines the text with the words of each page and of what is below it, and opens a page", async () => {
    const onOpenNote = renderDesk()
    const outline = await screen.findByRole("region", { name: "Главы" })
    const book = await within(outline).findByRole("button", { name: "Книга первая" })
    const bookRow = book.closest("[data-text-page]") as HTMLElement
    expect(bookRow.textContent).toContain((1500).toLocaleString())
    expect(
      (
        within(outline)
          .getByRole("button", { name: "Книга вторая" })
          .closest("[data-text-page]") as HTMLElement
      ).textContent,
    ).toContain("80")
    fireEvent.click(within(outline).getByRole("button", { name: "Глава первая" }))
    expect(onOpenNote).toHaveBeenCalledWith("c1")
  })

  it("makes a page at the top of the text with the first level's name, and opens it", async () => {
    const onOpenNote = renderDesk()
    const outline = await screen.findByRole("region", { name: "Главы" })
    await within(outline).findByRole("button", { name: "Книга первая" })
    fireEvent.click(within(outline).getByRole("button", { name: "Книга" }))
    const field = within(outline).getByPlaceholderText(/Название страницы/)
    fireEvent.change(field, { target: { value: "Книга третья" } })
    fireEvent.keyDown(field, { key: "Enter" })
    await waitFor(() => expect(createTextPage).toHaveBeenCalledTimes(1))
    expect(createTextPage).toHaveBeenCalledWith(
      expect.objectContaining({
        storyId: "hills",
        title: "Книга третья",
        parentNoteId: null,
        levelId: "book",
      }),
    )
    await waitFor(() => expect(onOpenNote).toHaveBeenCalledWith("new"))
  })

  it("moves a page with the panel's own moves, from the page's menu", async () => {
    renderDesk()
    const outline = await screen.findByRole("region", { name: "Главы" })
    await within(outline).findByRole("button", { name: "Глава вторая" })
    fireEvent.keyDown(
      within(outline).getByRole("button", { name: "Действия со страницей «Глава вторая»" }),
      { key: "Enter" },
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "Выше" }))
    await waitFor(() => expect(moveTextPage).toHaveBeenCalledTimes(1))
    expect(moveTextPage).toHaveBeenCalledWith(
      expect.objectContaining({
        storyId: "hills",
        noteId: "c2",
        newParentNoteId: "b1",
        expectedRevision: "rev-c2",
      }),
    )
    const { orderKey } = moveTextPage.mock.calls[0][0] as { orderKey: string }
    expect(orderKey < "a0").toBe(true)
  })

  it("greys out a move the page cannot make", async () => {
    renderDesk()
    const outline = await screen.findByRole("region", { name: "Главы" })
    await within(outline).findByRole("button", { name: "Глава первая" })
    fireEvent.keyDown(
      within(outline).getByRole("button", { name: "Действия со страницей «Глава первая»" }),
      { key: "Enter" },
    )
    const up = await screen.findByRole("menuitem", { name: "Выше" })
    expect(up.getAttribute("aria-disabled")).toBe("true")
    expect(screen.getByRole("menuitem", { name: "Ниже" }).getAttribute("aria-disabled")).toBeNull()
  })

  it("shows the widgets in their default order and widths", async () => {
    renderDesk()
    await screen.findByRole("region", { name: "Главы" })
    const titles = screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))
    expect(titles).toEqual(["Продолжить", "Прогресс", "Главы"])
    const widths = screen
      .getAllByRole("region")
      .map((region) => (region as HTMLElement).style.gridColumn)
    expect(widths).toEqual(["span 2 / span 2", "span 1 / span 1", "span 2 / span 2"])
  })

  it("follows its own width: two columns when medium, one when narrow", async () => {
    const original = Element.prototype.getBoundingClientRect
    const widthOf = (width: number) =>
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
        width,
        height: 100,
        top: 0,
        left: 0,
        right: width,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      })
    try {
      const spy = widthOf(700)
      renderDesk()
      const outline = await screen.findByRole("region", { name: "Главы" })
      expect(outline.parentElement?.className).toContain("grid-cols-2")
      expect(outline.style.gridColumn).toBe("span 2 / span 2")
      cleanup()
      spy.mockRestore()
      widthOf(400)
      renderDesk()
      const narrow = await screen.findByRole("region", { name: "Главы" })
      expect(narrow.parentElement?.className).toContain("grid-cols-1")
      expect(narrow.style.gridColumn).toBe("span 1 / span 1")
    } finally {
      vi.restoreAllMocks()
      Element.prototype.getBoundingClientRect = original
    }
  })

  describe("customizing the desk", () => {
    const layout: DeskItem[] = [
      { id: "continue", span: 2, hidden: false },
      { id: "progress", span: 1, hidden: false },
      { id: "chapters", span: 2, hidden: false },
    ]

    function mountEditing(onLayoutChange = vi.fn(), items = layout) {
      render(
        <ProjectDesk
          story={story}
          workshop={workshop}
          vaultPath="/vault"
          onOpenNote={vi.fn()}
          layout={items}
          editing
          onLayoutChange={onLayoutChange}
        />,
      )
      return onLayoutChange
    }

    it("explains the mode and gives every widget its controls, off outside the mode", async () => {
      mountEditing()
      await screen.findByRole("region", { name: "Главы" })
      expect(screen.getByText(/Раскладка одна для всех историй/)).toBeTruthy()
      for (const name of ["Продолжить", "Прогресс", "Главы"]) {
        expect(screen.getByRole("button", { name: `Выше: «${name}»` })).toBeTruthy()
        expect(screen.getByRole("button", { name: `Ниже: «${name}»` })).toBeTruthy()
        expect(screen.getByRole("button", { name: `Скрыть виджет «${name}»` })).toBeTruthy()
      }
      // The first cannot go up and the last cannot go down.
      expect(
        (screen.getByRole("button", { name: "Выше: «Продолжить»" }) as HTMLButtonElement).disabled,
      ).toBe(true)
      expect(
        (screen.getByRole("button", { name: "Ниже: «Главы»" }) as HTMLButtonElement).disabled,
      ).toBe(true)
      cleanup()
      renderDesk()
      await screen.findByRole("region", { name: "Главы" })
      expect(screen.queryByRole("button", { name: /Скрыть виджет/ })).toBeNull()
      expect(screen.queryByText(/Раскладка одна для всех историй/)).toBeNull()
    })

    it("moves a widget and changes its width, handing the whole layout on", async () => {
      const onLayoutChange = mountEditing()
      await screen.findByRole("region", { name: "Главы" })
      fireEvent.click(screen.getByRole("button", { name: "Ниже: «Продолжить»" }))
      expect(onLayoutChange).toHaveBeenLastCalledWith([
        { id: "progress", span: 1, hidden: false },
        { id: "continue", span: 2, hidden: false },
        { id: "chapters", span: 2, hidden: false },
      ])
      fireEvent.click(screen.getByRole("button", { name: /^Ширина «Прогресс»: треть строки/ }))
      expect(onLayoutChange).toHaveBeenLastCalledWith([
        { id: "continue", span: 2, hidden: false },
        { id: "progress", span: 2, hidden: false },
        { id: "chapters", span: 2, hidden: false },
      ])
    })

    it("hides a widget into the tray, and the tray brings it back", async () => {
      const onLayoutChange = mountEditing()
      await screen.findByRole("region", { name: "Главы" })
      expect(screen.getByText("Все виджеты на столе.")).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "Скрыть виджет «Прогресс»" }))
      expect(onLayoutChange).toHaveBeenLastCalledWith([
        { id: "continue", span: 2, hidden: false },
        { id: "progress", span: 1, hidden: true },
        { id: "chapters", span: 2, hidden: false },
      ])
      cleanup()
      const again = mountEditing(vi.fn(), [
        { id: "continue", span: 2, hidden: false },
        { id: "progress", span: 1, hidden: true },
        { id: "chapters", span: 2, hidden: false },
      ])
      await screen.findByRole("region", { name: "Главы" })
      expect(screen.queryByRole("region", { name: "Прогресс" })).toBeNull()
      const tray = screen.getByRole("region", { name: "Скрытые виджеты" })
      fireEvent.click(within(tray).getByRole("button", { name: "Вернуть на стол «Прогресс»" }))
      expect(again).toHaveBeenLastCalledWith([
        { id: "continue", span: 2, hidden: false },
        { id: "progress", span: 1, hidden: false },
        { id: "chapters", span: 2, hidden: false },
      ])
    })
  })

  it("leaves a hidden widget off the desk", async () => {
    render(
      <ProjectDesk
        story={story}
        workshop={workshop}
        vaultPath="/vault"
        onOpenNote={vi.fn()}
        layout={[
          { id: "chapters", span: 3, hidden: false },
          { id: "progress", span: 1, hidden: true },
        ]}
      />,
    )
    await screen.findByRole("region", { name: "Главы" })
    expect(screen.queryByRole("region", { name: "Прогресс" })).toBeNull()
    // What the layout does not know is added after the rest.
    const titles = screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))
    expect(titles).toEqual(["Главы", "Продолжить"])
  })

  it("offers to make the first page in a list the story has none in, linked to the story", async () => {
    const withCharacters = workshopSummary("w_hills", {
      name: "MoleHills Workshop",
      stories: [story],
      sections: [
        section("text", { role: "text", databaseId: "db_text", databaseName: "Текст" }),
        section("chars", {
          role: "characters",
          databaseId: "db_chars",
          databaseName: "Персонажи",
          storiesPropertyId: "stp",
        }),
      ],
    })
    queryDatabase.mockImplementation(async ({ databaseId }: { databaseId: string }) => {
      const rows = databaseId === "db_text" ? ROWS : []
      return { rows, nextCursor: null, totalCount: rows.length, diagnostics: [] }
    })
    createWorkshopEntity.mockReset().mockResolvedValue({ noteId: "new" })
    render(
      <ProjectDesk
        story={story}
        workshop={withCharacters}
        vaultPath="/vault"
        onOpenNote={vi.fn()}
      />,
    )
    const card = await screen.findByRole("region", { name: "Персонажи" })
    expect(await within(card).findByText("Пока пусто.")).toBeTruthy()
    fireEvent.click(within(card).getByRole("button", { name: "Добавить: Персонажи" }))
    const field = within(card).getByLabelText("Название — Персонажи")
    fireEvent.change(field, { target: { value: "Анна" } })
    fireEvent.submit(field.closest("form") as HTMLFormElement)
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(createWorkshopEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "w_hills",
        sectionId: "chars",
        title: "Анна",
        storyId: "hills",
      }),
    )
  })

  it("takes the numbers the page above already read instead of reading them again", async () => {
    const stats = Object.fromEntries(STATS.map((entry) => [entry.noteId, entry]))
    render(
      <ProjectDesk
        story={story}
        workshop={workshop}
        vaultPath="/vault"
        onOpenNote={vi.fn()}
        stats={stats}
      />,
    )
    const outline = await screen.findByRole("region", { name: "Главы" })
    const book = await within(outline).findByRole("button", { name: "Книга первая" })
    await waitFor(() =>
      expect((book.closest("[data-text-page]") as HTMLElement).textContent).toContain(
        (1500).toLocaleString(),
      ),
    )
    expect(listTextStats).not.toHaveBeenCalled()
  })

  it("compiles the text in the order of the tree and saves it as a new file", async () => {
    renderDesk()
    fireEvent.click(await screen.findByRole("button", { name: "Собрать рукопись" }))
    await waitFor(() => expect(exportTextFile).toHaveBeenCalledTimes(1))
    const [markdown, name] = exportTextFile.mock.calls[0] as [string, string]
    expect(name).toBe("MoleHills.md")
    expect(markdown).toBe(
      [
        "# MoleHills",
        "## Книга первая",
        "### Глава первая",
        "Начало пути.",
        "### Глава вторая",
        "Дорога дальше.",
        "## Книга вторая",
        "Эпилог.",
      ].join("\n\n") + "\n",
    )
    // Reading only: every page was read once, in the order of the tree.
    expect(readNote.mock.calls.map((call) => call[1])).toEqual(["b1", "c1", "c2", "b2"])
    expect(await screen.findByRole("status")).toBeTruthy()
    expect(screen.getByRole("status").textContent).toContain("/home/me/MoleHills.md")
  })

  it("stops and names the page it could not read, saving nothing", async () => {
    readNote.mockImplementation(async (_vault: string, noteId: string) => {
      if (noteId === "c2") throw new Error("disk")
      return { content: NOTES[noteId] ?? "", revision: "r", source: "disk" }
    })
    renderDesk()
    fireEvent.click(await screen.findByRole("button", { name: "Собрать рукопись" }))
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Глава вторая")
    expect(exportTextFile).not.toHaveBeenCalled()
  })

  it("says nothing when the save dialog was closed", async () => {
    exportTextFile.mockResolvedValue(null)
    renderDesk()
    fireEvent.click(await screen.findByRole("button", { name: "Собрать рукопись" }))
    await waitFor(() => expect(exportTextFile).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("offers no manuscript without a vault to read from", async () => {
    renderDesk(vi.fn(), null)
    await screen.findByRole("region", { name: "Прогресс" })
    expect(screen.queryByRole("button", { name: "Собрать рукопись" })).toBeNull()
  })

  it("shows the done page count tile when page status is configured", async () => {
    const storyWithStatus = storySummary("hills", {
      ...story,
      text: {
        ...story.text!,
        properties: { ...story.text!.properties, status: "stat" },
        statusOptions: [
          { id: "st_draft", name: "Черновик", color: "gray", group: "notStarted" },
          { id: "st_wip", name: "В работе", color: "amber", group: "inProgress" },
          { id: "st_done", name: "Готово", color: "green", group: "done" },
        ],
      },
    })
    const workshopWithStatus = workshopSummary("w_hills", {
      ...workshop,
      stories: [storyWithStatus],
    })
    queryDatabase.mockResolvedValue({
      rows: [
        row("b1", "Книга первая", {
          lvl: { type: "select", optionId: "book" },
          ord: { type: "text", value: "a0" },
          stat: { type: "status", optionId: "st_done" },
        }),
        row("c1", "Глава первая", {
          lvl: { type: "select", optionId: "chapter" },
          par: { type: "relation", targetNoteIds: ["b1"] },
          ord: { type: "text", value: "a0" },
          stat: { type: "status", optionId: "st_done" },
        }),
        row("c2", "Глава вторая", {
          lvl: { type: "select", optionId: "chapter" },
          par: { type: "relation", targetNoteIds: ["b1"] },
          ord: { type: "text", value: "a1" },
          stat: { type: "status", optionId: "st_wip" },
        }),
      ],
      nextCursor: null,
      totalCount: 3,
      diagnostics: [],
    })
    render(
      <ProjectDesk
        story={storyWithStatus}
        workshop={workshopWithStatus}
        vaultPath="/vault"
        onOpenNote={vi.fn()}
      />,
    )
    await screen.findByRole("region", { name: "Прогресс" })
    await waitFor(() => expect(screen.getByText("Готово: 2 из 3")).toBeTruthy())
    const bar = screen.getByRole("progressbar")
    expect(bar.getAttribute("aria-valuenow")).toBe("67")
  })

  describe("the world beside the text", () => {
    const withWorld = workshopSummary("w_hills", {
      name: "MoleHills Workshop",
      stories: [story],
      sections: [
        section("text", { role: "text", databaseId: "db_text", databaseName: "Текст" }),
        section("chars", {
          role: "characters",
          name: "Персонажи",
          databaseId: "db_chars",
          databaseName: "Персонажи",
          storiesPropertyId: "stp",
        }),
      ],
    })
    const rel = (...ids: string[]) => ({ type: "relation", targetNoteIds: ids })
    const CHARS = [
      row("anna", "Анна", { stp: rel("note_hills") }),
      row("boris", "Борис", { stp: rel("note_other") }),
      // Named by a page of this story's text.
      row("zoya", "Зоя"),
      row("eva", "Ева"),
    ]
    const TEXT_WITH_CAST = ROWS.map((entry) =>
      entry.noteId === "c1"
        ? row("c1", "Глава первая", {
            lvl: { type: "select", optionId: "chapter" },
            par: { type: "relation", targetNoteIds: ["b1"] },
            cast: rel("zoya"),
            ord: { type: "text", value: "a0" },
          })
        : entry,
    )

    it("lists the pages of this story only: those that name it and those its text names", async () => {
      queryDatabase.mockImplementation(async ({ databaseId }: { databaseId: string }) => {
        const rows = databaseId === "db_chars" ? CHARS : TEXT_WITH_CAST
        return { rows, nextCursor: null, totalCount: rows.length, diagnostics: [] }
      })
      render(
        <ProjectDesk story={story} workshop={withWorld} vaultPath="/vault" onOpenNote={vi.fn()} />,
      )
      const card = await screen.findByRole("region", { name: "Персонажи" })
      await within(card).findByText("Анна")
      expect(within(card).getByText("Зоя")).toBeTruthy()
      expect(within(card).queryByText("Борис")).toBeNull()
      expect(within(card).queryByText("Ева")).toBeNull()
      // The widget's header counts what it lists.
      expect(within(card).getByText("2")).toBeTruthy()
    })
  })

  describe("the notes of this story", () => {
    const withNotes = workshopSummary("w_hills", {
      name: "MoleHills Workshop",
      stories: [story],
      sections: [
        section("text", { role: "text", databaseId: "db_text", databaseName: "Текст" }),
        section("notes", {
          role: "notes",
          name: "Заметки",
          databaseId: "db_notes",
          databaseName: "Заметки",
          storiesPropertyId: "nst",
        }),
      ],
    })
    const rel = (...ids: string[]) => ({ type: "relation", targetNoteIds: ids })
    const note = (
      noteId: string,
      title: string,
      values: Record<string, unknown>,
      path: string[],
    ) => ({
      ...row(noteId, title, values),
      categoryPath: path,
    })
    const NOTE_ROWS = [
      note("n1", "Идея", { nst: rel("note_hills") }, ["Идеи"]),
      note("n2", "Факт", { nst: rel("note_hills") }, []),
      note("n3", "Чужая", { nst: rel("note_other") }, ["Идеи"]),
    ]

    function mountNotes() {
      queryDatabase.mockImplementation(async ({ databaseId }: { databaseId: string }) => {
        const rows = databaseId === "db_notes" ? NOTE_ROWS : ROWS
        return { rows, nextCursor: null, totalCount: rows.length, diagnostics: [] }
      })
      const onOpenNote = vi.fn()
      render(
        <ProjectDesk
          story={story}
          workshop={withNotes}
          vaultPath="/vault"
          onOpenNote={onOpenNote}
        />,
      )
      return onOpenNote
    }

    it("lists only the notes of this story under their notebooks and opens one", async () => {
      const onOpenNote = mountNotes()
      const widget = await screen.findByRole("region", { name: "Заметки" })
      await within(widget).findByText("Идея")
      expect(within(widget).getByText("Факт")).toBeTruthy()
      expect(within(widget).queryByText("Чужая")).toBeNull()
      expect(
        within(widget)
          .getAllByRole("tab")
          .map((tab) => tab.textContent),
      ).toEqual(["Все2", "Идеи1", "Без блокнота1"])
      fireEvent.click(within(widget).getByText("Идея"))
      expect(onOpenNote).toHaveBeenCalledWith("n1")
    })

    it("makes a note linked to this story in the notebook shown", async () => {
      createWorkshopEntity.mockReset().mockResolvedValue({ noteId: "new" })
      mountNotes()
      const widget = await screen.findByRole("region", { name: "Заметки" })
      await within(widget).findByText("Идея")
      fireEvent.click(within(widget).getByRole("tab", { name: /Идеи/ }))
      fireEvent.click(within(widget).getByRole("button", { name: "Заметка" }))
      const field = within(widget).getByLabelText("Название заметки")
      fireEvent.change(field, { target: { value: "Новая" } })
      fireEvent.submit(field.closest("form") as HTMLFormElement)
      await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
      expect(createWorkshopEntity).toHaveBeenCalledWith(
        expect.objectContaining({
          workshopId: "w_hills",
          sectionId: "notes",
          title: "Новая",
          storyId: "hills",
          notebook: ["Идеи"],
        }),
      )
    })
  })
})
