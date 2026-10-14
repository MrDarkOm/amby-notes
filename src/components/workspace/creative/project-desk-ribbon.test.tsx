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

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  queryDatabase: (...args: unknown[]) => queryDatabase(...args),
  createWorkshopEntity: (...args: unknown[]) => createWorkshopEntity(...args),
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

describe("the ribbon of anchors on a story's desk", () => {
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
    useCreativeNavStore.setState({ dataNonce: 0 })
    useDatabaseStore.setState({ vaultGeneration: 1, invalidationSeq: 0 })
  })
  afterEach(cleanup)

  const names = (region: HTMLElement) =>
    within(region)
      .getAllByRole("listitem")
      .filter((item) => item.querySelector("button"))
      .map((item) => item.textContent ?? "")

  it("lists the anchors in the order of the text, then the ones ahead", async () => {
    mount()
    const region = await screen.findByRole("region", { name: "Якоря" })
    await within(region).findByText("Начало")
    const items = names(region)
    expect(items).toHaveLength(3)
    expect(items[0]).toContain("Начало")
    expect(items[0]).toContain("Глава первая")
    expect(items[1]).toContain("Встреча")
    expect(items[1]).toContain("Глава вторая")
    expect(items[2]).toContain("Мечта")
    expect(within(region).queryByText("Чужой")).toBeNull()
  })

  it("marks the anchor on a page that is done as passed, and only that one", async () => {
    mount()
    const region = await screen.findByRole("region", { name: "Якоря" })
    await within(region).findByText("Начало")
    const items = names(region)
    expect(items[0]).toContain("пройден")
    expect(items[1]).not.toContain("пройден")
    expect(items[2]).not.toContain("пройден")
  })

  it("opens an anchor", async () => {
    const onOpenNote = mount()

    const region = await screen.findByRole("region", { name: "Якоря" })
    fireEvent.click(await within(region).findByText("Мечта"))
    expect(onOpenNote).toHaveBeenCalledWith("a3")
  })

  it("is quiet without anchors and offers making the first, in this story", async () => {
    ROWS.db_anch = []
    mount()
    const region = await screen.findByRole("region", { name: "Якоря" })
    expect(await within(region).findByText("У истории пока нет якорей.")).toBeTruthy()
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
    const region = await screen.findByRole("region", { name: "Якоря" })
    fireEvent.click(await within(region).findByRole("button", { name: "Добавить якорь" }))
    const field = within(region).getByLabelText("Название якоря")
    fireEvent.change(field, { target: { value: "Первый" } })
    fireEvent.submit(field.closest("form") as HTMLFormElement)
    expect((await within(region).findByRole("alert")).textContent).toContain("нет места")
  })

  it("has no ribbon in a workshop without an anchors base", async () => {
    mount(vi.fn(), {
      ...workshop(),
      sections: [section("text", { role: "text", databaseId: "db_text" })],
    })
    await screen.findByText("Продолжить с…")
    expect(screen.queryByRole("region", { name: "Якоря" })).toBeNull()
  })
})
