// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseRow, ProjectTextSummary } from "@/lib/storage"
import { useDatabaseStore } from "../database/database-store"
import { useCreativeNavStore } from "./creative-nav-store"
import { readWorkshopPrefs } from "./creative-scope-storage"
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
  listNotebooks: async () => ({
    databaseId: "",
    containerPath: "",
    rootItemCount: 0,
    notebooks: [],
  }),
  resolveDatabaseAssetPaths: async () => ({ paths: [] }),
}))
vi.mock("./create-section-dialog", () => ({ CreateSectionDialog: () => null }))
vi.mock("./create-project-dialog", () => ({ CreateProjectDialog: () => null }))

const VAULT = "/vaults/desk"

const text = (databaseId: string): ProjectTextSummary => ({
  databaseId,
  properties: {
    level: "lvl",
    parent: "par",
    order: "ord",
    format: null,
    status: null,
    anchors: null,
    arcs: null,
    characters: null,
    pov: null,
    places: null,
    storyTime: null,
  },
  levels: [{ id: "chapter", icon: null, name: "Глава", color: null, state: "ok" }],
  formats: [],
  statusOptions: [],
})

const workshop = (readOnly = false) =>
  workshopSummary("w", {
    name: "W",
    readOnly,
    sections: [
      section("text", { role: "text", databaseId: "db_hills" }),
      section("chars", {
        role: "characters",
        name: "Персонажи",
        databaseId: "db_chars",
        databaseName: "Персонажи",
      }),
    ],
    stories: [
      storySummary("hills", {
        name: "MoleHills",
        workshopId: "w",
        databaseId: "db_hills",
        text: text("db_hills"),
      }),
      storySummary("tale", {
        name: "Рассказ",
        workshopId: "w",
        databaseId: "db_tale",
        text: text("db_tale"),
      }),
    ],
  })

const page: DatabaseRow = {
  noteId: "p1",
  title: "Первая",
  relativePath: "p1.md",
  parentNoteId: null,
  depth: 0,
  categoryPath: [],
  valuesJson: JSON.stringify({ lvl: { type: "select", optionId: "chapter" } }),
  rowRevision: "r",
}

function mount(projectId: string) {
  render(
    <ProjectPage
      projectId={projectId}
      vaultPath={VAULT}
      onOpenDatabase={vi.fn()}
      onOpenProject={vi.fn()}
      onOpenNote={vi.fn()}
    />,
  )
}

const widgetNames = () =>
  screen
    .getAllByRole("region")
    .map((region) => region.getAttribute("aria-label"))
    .filter((name) => ["Продолжить", "Прогресс", "Главы", "Персонажи"].includes(name ?? ""))

describe("customizing a story's desk from the page", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    localStorage.clear()
    queryDatabase.mockReset().mockImplementation(async ({ databaseId }: { databaseId: string }) => {
      const rows = databaseId === "db_hills" || databaseId === "db_tale" ? [page] : []
      return { rows, nextCursor: null, totalCount: rows.length, diagnostics: [] }
    })
    useProjectStore.getState().reset()
    useDatabaseStore.getState().reset(1)
    useCreativeNavStore.setState({ sectionByProject: {}, collapsed: {}, dataNonce: 0 })
    act(() => useProjectStore.getState().setCatalog(catalog([workshop()])))
  })
  afterEach(cleanup)

  it("has the button on a story's desk only, and it switches the mode on and off", async () => {
    mount("hills")
    const button = await screen.findByRole("button", { name: "Настроить стол" })
    expect(button.getAttribute("aria-pressed")).toBe("false")
    expect(screen.queryByText(/Изменения сохраняются для этой истории/)).toBeNull()
    fireEvent.click(button)
    expect(screen.getByText(/Изменения сохраняются для этой истории/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Готово" }).getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "Готово" }))
    expect(screen.queryByText(/Изменения сохраняются для этой истории/)).toBeNull()
    cleanup()
    mount("w")
    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByRole("button", { name: "Настроить стол" })).toBeNull()
  })

  it("is not offered on a section tab of the story", async () => {
    mount("hills")
    await screen.findByRole("button", { name: "Настроить стол" })
    const nav = screen.getByRole("navigation", { name: "Разделы мастерской" })
    fireEvent.click(within(nav).getByRole("button", { name: "Персонажи" }))
    expect(screen.queryByRole("button", { name: "Настроить стол" })).toBeNull()
  })

  it("keeps a story layout private until applied to every story and preserves the legacy default", async () => {
    localStorage.setItem(
      "amby:creative-workshop",
      JSON.stringify({
        [VAULT]: {
          deskLayout: [{ id: "chapters", span: 2, hidden: false }],
        },
      }),
    )
    mount("hills")
    fireEvent.click(await screen.findByRole("button", { name: "Настроить стол" }))
    fireEvent.click(await screen.findByRole("button", { name: "Скрыть виджет «Прогресс»" }))
    expect(screen.queryByRole("region", { name: "Прогресс" })).toBeNull()
    expect(readWorkshopPrefs(VAULT).deskLayout).toEqual([
      { id: "chapters", span: 2, hidden: false },
    ])

    cleanup()
    mount("tale")
    expect(await screen.findByRole("region", { name: "Прогресс" })).toBeTruthy()
    expect(widgetNames()[0]).toBe("Главы")

    cleanup()
    mount("hills")
    fireEvent.click(await screen.findByRole("button", { name: "Настроить стол" }))
    expect(screen.queryByRole("region", { name: "Прогресс" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Применить ко всем историям" }))
    cleanup()
    mount("tale")
    await screen.findByRole("region", { name: "Главы" })
    expect(screen.queryByRole("region", { name: "Прогресс" })).toBeNull()
  })

  it("lets a read-only workshop's desk be arranged, since the layout is the interface's own", async () => {
    act(() => useProjectStore.getState().setCatalog(catalog([workshop(true)])))
    mount("hills")
    expect(await screen.findByRole("button", { name: "Настроить стол" })).toBeTruthy()
    await waitFor(() => expect(screen.getByRole("region", { name: "Главы" })).toBeTruthy())
  })

  it("brings back a widget the layout lost track of: a saved layout is reconciled", async () => {
    localStorage.setItem(
      "amby:creative-workshop",
      JSON.stringify({
        [VAULT]: {
          deskLayout: [
            { id: "gone", span: 1, hidden: false },
            { id: "chapters", span: 3, hidden: false },
          ],
        },
      }),
    )
    mount("hills")
    await screen.findByRole("region", { name: "Главы" })
    // The widgets the layout did not name come after it.
    expect(widgetNames()).toEqual(["Главы", "Продолжить", "Прогресс", "Персонажи"])
  })
})
