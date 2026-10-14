// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type {
  DatabaseNoteContext,
  DatabaseRow,
  NoteReference,
  ProjectTextSummary,
} from "@/lib/storage"
import { useDatabaseStore } from "../../database/database-store"
import { useCreativeNavStore } from "../creative-nav-store"
import {
  catalog,
  storySummary,
  workshopSection as section,
  workshopSummary,
} from "../project-fixtures.test-support"
import { useProjectStore } from "../project-store"
import { arcColor } from "../workshop/plot-model"
import { DossierFrame } from "./dossier-frame"

const storage = vi.hoisted(() => ({
  getDatabaseNoteContext: vi.fn(),
  listNoteReferences: vi.fn(),
  queryDatabase: vi.fn(),
  listTextStats: vi.fn(),
  resolveDatabaseAssetPaths: vi.fn(),
}))
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  ...storage,
}))

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
const rel = (...ids: string[]) => ({ type: "relation", targetNoteIds: ids })
const page = (noteId: string, title: string, order: string, extra: Record<string, unknown> = {}) =>
  row(noteId, title, {
    lvl: { type: "select", optionId: "chapter" },
    ord: { type: "text", value: order },
    ...extra,
  })

const text: ProjectTextSummary = {
  databaseId: "db_text",
  properties: {
    level: "lvl",
    parent: "par",
    order: "ord",
    format: null,
    status: null,
    anchors: "tanc",
    arcs: "tarc",
  },
  levels: [{ id: "chapter", icon: null, name: "Глава", color: null, state: "ok" }],
  formats: [],
  statusOptions: [],
}

function world(withPlot = true) {
  return workshopSummary("w", {
    name: "Мир",
    sections: [
      section("characters", {
        role: "characters",
        databaseId: "db_chars",
        databaseName: "Персонажи",
      }),
      ...(withPlot
        ? [
            section("anchors", {
              role: "anchors",
              databaseId: "db_anch",
              databaseName: "Якоря",
              storiesPropertyId: "ast",
              arcsPropertyId: "aarc",
            }),
            section("arcs", {
              role: "arcs",
              databaseId: "db_arcs",
              databaseName: "Арки",
              charactersPropertyId: "who",
            }),
          ]
        : []),
    ],
    stories: [
      storySummary("s1", { workshopId: "w", name: "Дом", databaseId: "db_text", text }),
      storySummary("s2", {
        workshopId: "w",
        name: "Лес",
        databaseId: "db_text2",
        text: { ...text, databaseId: "db_text2" },
      }),
    ],
  })
}

let ROWS: Record<string, DatabaseRow[]> = {}

function resetRows() {
  ROWS = {
    db_text: [
      page("p1", "Глава 1", "a0", { tanc: rel("a1"), tarc: rel("r1") }),
      page("p2", "Глава 2", "a1"),
      page("p3", "Глава 3", "a2", { tanc: rel("a2"), tarc: rel("r1", "r2") }),
      page("p4", "Глава 4", "a3", { tarc: rel("r1") }),
    ],
    db_text2: [page("q1", "Лесная глава", "a0", { tarc: rel("r1") })],
    db_anch: [
      row("a1", "Встреча", { ast: rel("note_s1"), aarc: rel("r1") }),
      row("a2", "Финал", { ast: rel("note_s1"), aarc: rel("r1") }),
      row("a3", "Мечта", { ast: rel("note_s1"), aarc: rel("r1") }),
      row("a4", "Чужой", { aarc: rel("r2") }),
    ],
    db_arcs: [row("r1", "Любовь", { who: rel("anna") }), row("r2", "Месть")],
    db_chars: [row("anna", "Анна"), row("bob", "Боб")],
  }
}

function context(databaseId: string, noteId: string, title: string): DatabaseNoteContext {
  return {
    vaultGeneration: 1,
    databaseId,
    databaseTitle: databaseId,
    databaseIcon: null,
    manifestRevision: "m",
    locked: false,
    properties: [],
    row: row(noteId, title),
  }
}

function mount(noteId: string, onOpenNote = vi.fn()) {
  render(
    <DossierFrame
      noteId={noteId}
      content=""
      canJump
      scrollToHeading={vi.fn()}
      onOpenNote={onOpenNote}
    >
      <div data-testid="editor">editor</div>
    </DossierFrame>,
  )
  return onOpenNote
}

const settle = () => act(async () => {})
const useNote = (databaseId: string, noteId: string, title: string) =>
  storage.getDatabaseNoteContext.mockResolvedValue(context(databaseId, noteId, title))

describe("the plot beside a page of the text", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    resetRows()
    storage.getDatabaseNoteContext.mockReset()
    storage.listNoteReferences.mockReset().mockResolvedValue([])
    storage.listTextStats.mockReset().mockResolvedValue([])
    storage.resolveDatabaseAssetPaths.mockReset().mockResolvedValue({ paths: [] })
    storage.queryDatabase
      .mockReset()
      .mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
        rows: ROWS[databaseId] ?? [],
        nextCursor: null,
        totalCount: (ROWS[databaseId] ?? []).length,
        diagnostics: [],
      }))
    useProjectStore.getState().reset()
    useDatabaseStore.getState().reset(1)
    useCreativeNavStore.setState({ dataNonce: 0 })
    act(() => useProjectStore.getState().setCatalog(catalog([world()])))
  })
  afterEach(cleanup)

  const aside = () => screen.findByRole("complementary", { name: "Сюжет страницы" })

  it("shows the anchors of the page, the nearest bound ones around it and its arcs", async () => {
    useNote("db_text", "p3", "Глава 3")
    const onOpenNote = mount("p3")
    const region = await aside()
    const block = (title: string) =>
      within(region).getByRole("heading", { name: title }).parentElement as HTMLElement
    expect(within(block("Якоря этой страницы")).getByText("Финал")).toBeTruthy()
    // Before it, the anchor of chapter 1; after it nothing is bound, so the first one ahead.
    expect(within(block("Отталкиваемся от")).getByText("Встреча")).toBeTruthy()
    expect(within(block("Отталкиваемся от")).getByText("на странице «Глава 1»")).toBeTruthy()
    expect(within(block("Должны прийти к")).getByText("Мечта")).toBeTruthy()
    expect(within(block("Должны прийти к")).getByText("впереди, ещё не привязан")).toBeTruthy()
    const arcs = block("Арки")
    expect(within(arcs).getByText("Любовь")).toBeTruthy()
    expect(within(arcs).getByText("Месть")).toBeTruthy()
    const dot = within(arcs).getByText("Любовь").previousElementSibling as HTMLElement
    expect(dot.style.backgroundColor).not.toBe("")
    expect(arcColor("r1")).toBeTruthy()

    fireEvent.click(within(block("Должны прийти к")).getByRole("button", { name: /Мечта/ }))
    expect(onOpenNote).toHaveBeenLastCalledWith("a3")
    fireEvent.click(within(block("Якоря этой страницы")).getByRole("button", { name: "Финал" }))
    expect(onOpenNote).toHaveBeenLastCalledWith("a2")
    fireEvent.click(within(arcs).getByRole("button", { name: "Месть" }))
    expect(onOpenNote).toHaveBeenLastCalledWith("r2")
  })

  it("takes the nearest bound anchors of a page that has none of its own", async () => {
    useNote("db_text", "p2", "Глава 2")
    mount("p2")
    const region = await aside()
    expect(within(region).getByText("Встреча")).toBeTruthy()
    expect(within(region).getByText("Финал")).toBeTruthy()
    expect(within(region).getByText("К этой странице якоря не привязаны.")).toBeTruthy()
    expect(within(region).getByText("К этой странице арки не привязаны.")).toBeTruthy()
    expect(within(region).queryByText("впереди, ещё не привязан")).toBeNull()
  })

  it("says so quietly where nothing is before or after, and keeps every block", async () => {
    ROWS.db_anch = [row("a1", "Встреча", { ast: rel("note_s1") })]
    ROWS.db_text = [page("p1", "Глава 1", "a0", { tanc: rel("a1") })]
    useNote("db_text", "p1", "Глава 1")
    mount("p1")
    const region = await aside()
    expect(within(region).getByText("Раньше по тексту привязанных якорей нет.")).toBeTruthy()
    expect(within(region).getByText("Дальше по тексту якорей нет.")).toBeTruthy()
    expect(within(region).getAllByRole("heading")).toHaveLength(4)
  })

  it("never remounts the editor when the answer arrives", async () => {
    useNote("db_text", "p2", "Глава 2")
    mount("p2")
    const before = screen.getByTestId("editor")
    await aside()
    expect(screen.getByTestId("editor")).toBe(before)
  })

  it("adds nothing where the workshop has neither anchors nor arcs, or no row of them", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([world(false)])))
    useNote("db_text", "p2", "Глава 2")
    mount("p2")
    await settle()
    expect(screen.queryByRole("complementary")).toBeNull()
    expect(storage.queryDatabase).not.toHaveBeenCalled()
    cleanup()

    act(() => useProjectStore.getState().setCatalog(catalog([world(true)])))
    ROWS.db_anch = []
    ROWS.db_arcs = []
    mount("p2")
    await settle()
    expect(screen.queryByRole("complementary")).toBeNull()
  })

  it("adds nothing to a page of the notes", async () => {
    useNote("db_notes", "n1", "Заметка")
    mount("n1")
    await settle()
    expect(screen.queryByRole("complementary")).toBeNull()
    expect(storage.queryDatabase).not.toHaveBeenCalled()
  })
})

describe("the plot on the page of an arc and of a character", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    resetRows()
    storage.getDatabaseNoteContext.mockReset()
    storage.listNoteReferences.mockReset().mockResolvedValue([])
    storage.listTextStats.mockReset().mockResolvedValue([])
    storage.resolveDatabaseAssetPaths.mockReset().mockResolvedValue({ paths: [] })
    storage.queryDatabase
      .mockReset()
      .mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
        rows: ROWS[databaseId] ?? [],
        nextCursor: null,
        totalCount: (ROWS[databaseId] ?? []).length,
        diagnostics: [],
      }))
    useProjectStore.getState().reset()
    useDatabaseStore.getState().reset(1)
    useCreativeNavStore.setState({ dataNonce: 0 })
    act(() => useProjectStore.getState().setCatalog(catalog([world()])))
  })
  afterEach(cleanup)

  const reference = (over: Partial<NoteReference>): NoteReference => ({
    direction: "in",
    propertyId: "who",
    propertyName: "Персонажи",
    databaseId: "db_arcs",
    databaseName: "Арки",
    noteId: "r1",
    title: "Любовь",
    ...over,
  })

  it("lists an arc's anchors in the order of the text, the unbound last, and its chapters with the span", async () => {
    useNote("db_arcs", "r1", "Любовь")
    // The text pages that point at the arc are references too; they are not listed twice.
    storage.listNoteReferences.mockResolvedValue([
      reference({
        propertyId: "tarc",
        propertyName: "Арки",
        databaseId: "db_text",
        noteId: "p1",
        title: "Глава 1",
      }),
    ])
    const onOpenNote = mount("r1")
    const region = await screen.findByRole("complementary", { name: "Досье" })
    const block = (title: string) =>
      within(region).getByRole("heading", { name: title }).parentElement as HTMLElement
    await within(region).findByText("Встреча")
    const anchors = block("Якоря арки")
    const listed = within(anchors)
      .getAllByRole("button")
      .map((button) => button.textContent)
    // Two stories hold chapters of this arc, but only the first binds an anchor to its text.
    expect(listed).toEqual(["Встреча", "Финал", "Мечта"])
    expect(within(anchors).getByText("Не привязаны к тексту")).toBeTruthy()
    expect(within(anchors).queryByText("Чужой")).toBeNull()

    const chapters = block("Главы")
    expect(
      within(chapters)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Глава 1", "Глава 3", "Глава 4", "Лесная глава"])
    expect(within(chapters).getByText("от «Глава 1» до «Глава 4»")).toBeTruthy()
    // The other story binds the arc to one page only: no span for it.
    expect(within(chapters).getAllByText(/^от «/)).toHaveLength(1)
    expect(within(chapters).getByText("Лес")).toBeTruthy()
    expect(within(region).queryByText("Появляется в")).toBeNull()

    fireEvent.click(within(anchors).getByRole("button", { name: "Финал" }))
    expect(onOpenNote).toHaveBeenLastCalledWith("a2")
    fireEvent.click(within(chapters).getByRole("button", { name: "Глава 3" }))
    expect(onOpenNote).toHaveBeenLastCalledWith("p3")
  })

  it("says so quietly when an arc has no anchors and no chapters", async () => {
    useNote("db_arcs", "r2", "Месть")
    ROWS.db_anch = []
    ROWS.db_text = [page("p1", "Глава 1", "a0")]
    ROWS.db_text2 = []
    mount("r2")
    const region = await screen.findByRole("complementary", { name: "Досье" })
    expect(await within(region).findByText("Ни один якорь не указывает на эту арку.")).toBeTruthy()
    expect(
      within(region).getByText("Арка пока не привязана ни к одной странице текста."),
    ).toBeTruthy()
  })

  it("shows the arcs of a character with their colors, once", async () => {
    useNote("db_chars", "anna", "Анна")
    storage.listNoteReferences.mockResolvedValue([reference({})])
    const onOpenNote = mount("anna")
    const region = await screen.findByRole("complementary", { name: "Досье" })
    const block = await within(region).findByRole("heading", { name: "Арки" })
    const arcs = block.parentElement as HTMLElement
    const button = within(arcs).getByRole("button", { name: "Любовь" })
    const dot = button.querySelector("span[aria-hidden]") as HTMLElement
    expect(dot.style.backgroundColor).not.toBe("")
    // The same arc is not repeated among the connections.
    expect(within(region).getAllByText("Любовь")).toHaveLength(1)
    expect(within(region).getByText("Связей пока нет.")).toBeTruthy()
    fireEvent.click(button)
    expect(onOpenNote).toHaveBeenCalledWith("r1")
  })

  it("has no block of arcs for a character that no arc names", async () => {
    useNote("db_chars", "bob", "Боб")
    mount("bob")
    const region = await screen.findByRole("complementary", { name: "Досье" })
    await settle()
    expect(within(region).queryByRole("heading", { name: "Арки" })).toBeNull()
  })
})
