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

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  queryDatabase: (...args: unknown[]) => queryDatabase(...args),
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
