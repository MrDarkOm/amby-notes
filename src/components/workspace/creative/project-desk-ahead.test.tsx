// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseRow, ProjectTextSummary } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import { useCreativeNavStore } from "./creative-nav-store"
import {
  storySummary,
  workshopSection as section,
  workshopSummary,
} from "./project-fixtures.test-support"
import { ProjectDesk } from "./project-desk"

const queryDatabase = vi.fn()
const createWorkshopEntity = vi.fn()
const updateDatabaseRelationValue = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  queryDatabase: (...args: unknown[]) => queryDatabase(...args),
  createWorkshopEntity: (...args: unknown[]) => createWorkshopEntity(...args),
  updateDatabaseRelationValue: (...args: unknown[]) => updateDatabaseRelationValue(...args),
  listTextStats: async () => [],
  resolveDatabaseAssetPaths: async () => ({ paths: [] }),
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
    status: "st",
    anchors: "tanc",
    arcs: null,
  },
  levels: [{ id: "chapter", icon: null, name: "Глава", color: null, state: "ok" }],
  formats: [],
  statusOptions: [
    { id: "todo", name: "Черновик", color: "#999", group: "notStarted" },
    { id: "ready", name: "Готово", color: "#0a0", group: "done" },
  ],
}

const story = storySummary("hills", {
  name: "MoleHills",
  workshopId: "w",
  databaseId: "db_text",
  text,
})
const workshop = (withStoriesLink = true) =>
  workshopSummary("w", {
    name: "W",
    stories: [story],
    sections: [
      section("text", { role: "text", databaseId: "db_text" }),
      section("anchors", {
        role: "anchors",
        name: "Якоря",
        databaseId: "db_anch",
        databaseName: "Якоря",
        storiesPropertyId: withStoriesLink ? "ast" : null,
      }),
    ],
  })

let ROWS: Record<string, DatabaseRow[]> = {}

function mount(onOpenNote = vi.fn(), w = workshop()) {
  render(<ProjectDesk story={story} workshop={w} vaultPath={null} onOpenNote={onOpenNote} />)
  return onOpenNote
}

describe('the anchors of a story on its desk: marks on the pages and the strip "Ahead"', () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    ROWS = {
      db_text: [
        page("c1", "Глава первая", "a0", {
          st: { type: "status", optionId: "ready" },
          tanc: rel("a2"),
        }),
        page("c2", "Глава вторая", "a1", {
          st: { type: "status", optionId: "todo" },
          tanc: rel("a1"),
        }),
      ],
      db_anch: [
        row("a1", "Встреча", { ast: rel("note_hills") }),
        row("a2", "Начало", { ast: rel("note_hills") }),
        row("a3", "Мечта", { ast: rel("note_hills") }),
        row("a4", "Чужой"),
      ],
    }
    queryDatabase
      .mockReset()
      .mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
        rows: ROWS[databaseId] ?? [],
        nextCursor: null,
        totalCount: (ROWS[databaseId] ?? []).length,
        diagnostics: [],
      }))
    createWorkshopEntity.mockReset().mockResolvedValue({ noteId: "new" })
    updateDatabaseRelationValue.mockReset().mockResolvedValue(undefined)
    useCreativeNavStore.setState({ dataNonce: 0 })
    useDatabaseStore.setState({ vaultGeneration: 1, invalidationSeq: 0 })
  })
  afterEach(cleanup)

  const chapters = async () => {
    const region = await screen.findByRole("region", { name: "Главы" })
    await within(region).findByRole("button", { name: "Глава первая" })
    return region
  }
  const strip = async () => {
    const region = await chapters()
    await within(region).findByText("Впереди")
    return region
  }
  const pageRow = (region: HTMLElement, title: string) =>
    within(region).getByRole("button", { name: title }).closest("[data-text-page]") as HTMLElement

  /** A drag as the browser carries it: the data set at the start is read at the drop. */
  function dragData() {
    const store = new Map<string, string>()
    return {
      setData: (type: string, value: string) => void store.set(type, value),
      getData: (type: string) => store.get(type) ?? "",
      get types() {
        return [...store.keys()]
      },
      dropEffect: "none",
      effectAllowed: "all",
    }
  }

  it("marks a page with the anchors bound to it, and lists only the unbound ones ahead", async () => {
    mount()
    const region = await strip()
    expect(within(pageRow(region, "Глава первая")).getByTestId("page-anchor-mark")).toBeTruthy()
    expect(within(pageRow(region, "Глава вторая")).getByTestId("page-anchor-mark")).toBeTruthy()
    expect(within(region).getByRole("button", { name: "Мечта" })).toBeTruthy()
    // Bound anchors are on their pages, not ahead; another story's anchor is nowhere here.
    expect(within(region).queryByRole("button", { name: "Начало" })).toBeNull()
    expect(within(region).queryByRole("button", { name: "Встреча" })).toBeNull()
    expect(within(region).queryByText("Чужой")).toBeNull()
  })

  it("opens an anchor ahead", async () => {
    const onOpenNote = mount()
    const region = await strip()
    fireEvent.click(within(region).getByRole("button", { name: "Мечта" }))
    expect(onOpenNote).toHaveBeenCalledWith("a3")
  })

  it("binds an anchor to a page when it is dropped on it, keeping the page's other anchors", async () => {
    mount()
    const region = await strip()
    const data = dragData()
    const chip = within(region).getByRole("button", { name: "Мечта" }).closest("[draggable]")!
    fireEvent.dragStart(chip, { dataTransfer: data })
    const row = pageRow(region, "Глава вторая")
    fireEvent.dragOver(row, { dataTransfer: data })
    fireEvent.drop(row, { dataTransfer: data })
    await waitFor(() => expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(1))
    expect(updateDatabaseRelationValue).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: "db_text",
        noteId: "c2",
        propertyId: "tanc",
        targetNoteIds: ["a1", "a3"],
        expectedRevision: "rev-c2",
      }),
    )
  })

  it("binds an anchor from its menu, by keyboard", async () => {
    mount()
    const region = await strip()
    fireEvent.keyDown(
      within(region).getByRole("button", { name: "Привязать «Мечта» к странице…" }),
      {
        key: "Enter",
      },
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "Глава первая" }))
    await waitFor(() => expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(1))
    expect(updateDatabaseRelationValue).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: "c1", targetNoteIds: ["a2", "a3"] }),
    )
  })

  it("says why a binding failed", async () => {
    updateDatabaseRelationValue.mockRejectedValue(new Error("страница изменилась"))
    mount()
    const region = await strip()
    const data = dragData()
    const chip = within(region).getByRole("button", { name: "Мечта" }).closest("[draggable]")!
    fireEvent.dragStart(chip, { dataTransfer: data })
    const row = pageRow(region, "Глава первая")
    fireEvent.dragOver(row, { dataTransfer: data })
    fireEvent.drop(row, { dataTransfer: data })
    expect((await within(region).findByRole("alert")).textContent).toContain("страница изменилась")
  })

  it("offers making an anchor of this story, and says why it failed", async () => {
    ROWS.db_anch = []
    mount()
    const region = await strip()
    fireEvent.click(within(region).getByRole("button", { name: "Добавить якорь" }))
    const field = within(region).getByLabelText("Название якоря")
    fireEvent.change(field, { target: { value: "Первый" } })
    fireEvent.submit(field.closest("form") as HTMLFormElement)
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(createWorkshopEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "w",
        sectionId: "anchors",
        title: "Первый",
        storyId: "hills",
      }),
    )
  })

  it("shows why an anchor could not be made", async () => {
    ROWS.db_anch = []
    createWorkshopEntity.mockRejectedValue(new Error("нет места"))
    mount()
    const region = await strip()
    fireEvent.click(within(region).getByRole("button", { name: "Добавить якорь" }))
    const field = within(region).getByLabelText("Название якоря")
    fireEvent.change(field, { target: { value: "Первый" } })
    fireEvent.submit(field.closest("form") as HTMLFormElement)
    expect((await within(region).findByRole("alert")).textContent).toContain("нет места")
  })

  it("has no strip in a workshop without an anchors base", async () => {
    mount(vi.fn(), {
      ...workshop(),
      sections: [section("text", { role: "text", databaseId: "db_text" })],
    })
    const region = await chapters()
    expect(within(region).queryByText("Впереди")).toBeNull()
  })
})
