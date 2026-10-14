// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseRow } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import { useCreativeNavStore } from "./creative-nav-store"
import {
  catalog,
  storySummary,
  workshopSection as section,
  workshopSummary,
} from "./project-fixtures.test-support"
import { ProjectPage } from "./project-page"
import { useProjectStore } from "./project-store"

const queryDatabase = vi.fn()
const ensurePlotLinks = vi.fn()
const createWorkshopEntity = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  queryDatabase: (...args: unknown[]) => queryDatabase(...args),
  ensurePlotLinks: (...args: unknown[]) => ensurePlotLinks(...args),
  createWorkshopEntity: (...args: unknown[]) => createWorkshopEntity(...args),
  listTextStats: async () => [],
  resolveDatabaseAssetPaths: async () => ({ paths: [] }),
}))
vi.mock("./create-section-dialog", () => ({ CreateSectionDialog: () => null }))

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

const workshop = workshopSummary("verse", {
  name: "Verse",
  sections: [
    section("stories", { role: "stories", databaseId: "db_stories", universePropertyId: "up" }),
    section("universes", { role: "universes", name: "Вселенные", databaseId: "db_univ" }),
    section("chars", {
      role: "characters",
      name: "Персонажи",
      databaseId: "db_chars",
      databaseName: "Персонажи",
      storiesPropertyId: "stp",
    }),
  ],
  stories: [
    storySummary("hills", { workshopId: "verse", name: "MoleHills", databaseId: "db_t_hills" }),
    storySummary("lone", { workshopId: "verse", name: "Одиночка", databaseId: "db_t_lone" }),
  ],
})

const ROWS: Record<string, DatabaseRow[]> = {
  db_stories: [row("note_hills", "MoleHills", { up: rel("u1") }), row("note_lone", "Одиночка")],
  db_univ: [row("u1", "Палуверс")],
  db_chars: [
    row("anna", "Анна", { stp: rel("note_hills") }),
    row("gleb", "Глеб", { stp: rel("note_lone") }),
    row("zoya", "Зоя"),
  ],
  db_t_hills: [row("h1", "Глава", { cast: rel("zoya") })],
  db_t_lone: [],
}

describe("the page of a universe", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    queryDatabase
      .mockReset()
      .mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
        rows: ROWS[databaseId] ?? [],
        nextCursor: null,
        totalCount: (ROWS[databaseId] ?? []).length,
        diagnostics: [],
      }))
    useProjectStore.getState().reset()
    useDatabaseStore.getState().reset(1)
    useCreativeNavStore.setState({ sectionByProject: {}, collapsed: {}, dataNonce: 0 })
    act(() => useProjectStore.getState().setCatalog(catalog([workshop])))
  })
  afterEach(cleanup)

  it("is named by the universe's card and lists its stories and the pages that belong to it", async () => {
    const onOpenProject = vi.fn()
    const onOpenNote = vi.fn()
    render(
      <ProjectPage
        projectId="universe:u1"
        renderDatabase={() => null}
        onOpenProject={onOpenProject}
        onOpenNote={onOpenNote}
      />,
    )
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Палуверс"),
    )
    const stories = await screen.findByRole("region", { name: "Истории" })
    await within(stories).findByText("MoleHills")
    expect(within(stories).queryByText("Одиночка")).toBeNull()
    fireEvent.click(within(stories).getByRole("button", { name: /MoleHills/ }))
    expect(onOpenProject).toHaveBeenCalledWith("hills")

    // The pages of the universe: Anna names a story of it, Zoya is named in that story's text.
    const characters = await screen.findByRole("region", { name: "Персонажи" })
    await within(characters).findByText("Анна")
    expect(within(characters).getByText("Зоя")).toBeTruthy()
    expect(within(characters).queryByText("Глеб")).toBeNull()
    fireEvent.click(within(characters).getByText("Зоя"))
    expect(onOpenNote).toHaveBeenCalledWith("zoya")
  })

  it("says so when no story belongs to the universe", async () => {
    ROWS.db_stories = [row("note_hills", "MoleHills"), row("note_lone", "Одиночка")]
    try {
      render(
        <ProjectPage
          projectId="universe:u1"
          renderDatabase={() => null}
          onOpenProject={vi.fn()}
          onOpenNote={vi.fn()}
        />,
      )
      expect(await screen.findByText(/В этой вселенной пока нет историй/)).toBeTruthy()
    } finally {
      ROWS.db_stories = [
        row("note_hills", "MoleHills", { up: rel("u1") }),
        row("note_lone", "Одиночка"),
      ]
    }
  })
})

describe("the events of a universe", () => {
  const withAnchors = (universeProperty: string | null) =>
    workshopSummary("verse", {
      name: "Verse",
      fileRevision: "rev-verse",
      sections: [
        ...workshop.sections,
        section("anchors", {
          role: "anchors",
          name: "Якоря",
          databaseId: "db_anch",
          databaseName: "Якоря",
          storiesPropertyId: "ast",
          universePropertyId: universeProperty,
        }),
      ],
      stories: workshop.stories,
    })
  const anchorRows = [
    row("a1", "Потоп", { uni: rel("u1") }),
    row("a2", "Чужое", { uni: rel("u2") }),
    row("a3", "Простой"),
  ]

  function mountDesk(universeProperty: string | null = "uni", rowsOfAnchors = anchorRows) {
    ROWS.db_anch = rowsOfAnchors
    act(() => useProjectStore.getState().setCatalog(catalog([withAnchors(universeProperty)])))
    render(
      <ProjectPage
        projectId="universe:u1"
        renderDatabase={() => null}
        onOpenProject={vi.fn()}
        onOpenNote={onOpenNote}
      />,
    )
  }
  const onOpenNote = vi.fn()

  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    onOpenNote.mockReset()
    ensurePlotLinks.mockReset().mockResolvedValue({ changed: true })
    createWorkshopEntity.mockReset().mockResolvedValue({ noteId: "new" })
    queryDatabase
      .mockReset()
      .mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
        rows: ROWS[databaseId] ?? [],
        nextCursor: null,
        totalCount: (ROWS[databaseId] ?? []).length,
        diagnostics: [],
      }))
    useProjectStore.getState().reset()
    useDatabaseStore.getState().reset(1)
    useCreativeNavStore.setState({ sectionByProject: {}, collapsed: {}, dataNonce: 0 })
  })
  afterEach(() => {
    cleanup()
    delete ROWS.db_anch
  })

  async function nameEvent(title: string) {
    const region = await screen.findByRole("region", { name: "События вселенной" })
    fireEvent.click(await within(region).findByRole("button", { name: "Новое событие" }))
    const field = within(region).getByLabelText("Название события")
    fireEvent.change(field, { target: { value: title } })
    fireEvent.submit(field.closest("form") as HTMLFormElement)
    return region
  }

  it("lists the anchors that name the universe and opens one", async () => {
    mountDesk()
    const region = await screen.findByRole("region", { name: "События вселенной" })
    await within(region).findByText("Потоп")
    expect(within(region).queryByText("Чужое")).toBeNull()
    expect(within(region).queryByText("Простой")).toBeNull()
    fireEvent.click(within(region).getByText("Потоп"))
    expect(onOpenNote).toHaveBeenCalledWith("a1")
  })

  it("says so when the universe has no event", async () => {
    mountDesk("uni", [row("a3", "Простой")])
    expect(await screen.findByText("У вселенной пока нет событий.")).toBeTruthy()
  })

  it("makes an event in one write that names the universe", async () => {
    mountDesk("uni")
    await nameEvent("Пожар")
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(createWorkshopEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "verse",
        sectionId: "anchors",
        title: "Пожар",
        universeId: "u1",
      }),
    )
    expect(ensurePlotLinks).not.toHaveBeenCalled()
  })

  it("makes the Universe relation of the anchors first when they lack it", async () => {
    mountDesk(null)
    await nameEvent("Пожар")
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(ensurePlotLinks).toHaveBeenCalledTimes(1)
    expect(ensurePlotLinks).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "anchors",
        workshopId: "verse",
        expectedRevision: "rev-verse",
      }),
    )
    expect(ensurePlotLinks.mock.invocationCallOrder[0]).toBeLessThan(
      createWorkshopEntity.mock.invocationCallOrder[0],
    )
  })

  it("shows the failure of that operation and writes no anchor", async () => {
    ensurePlotLinks.mockReset().mockRejectedValue(new Error("диск полон"))
    mountDesk(null)
    const region = await nameEvent("Пожар")
    const alert = await within(region).findByRole("alert")
    expect(alert.textContent).toContain("диск полон")
    expect(createWorkshopEntity).not.toHaveBeenCalled()
  })
})
