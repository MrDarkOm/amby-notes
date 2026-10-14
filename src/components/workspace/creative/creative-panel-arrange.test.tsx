// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { DatabaseRow, DatabaseSummary, ProjectCatalog } from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"
import { useDatabaseStore } from "../database/database-store"
import { parseViewSettings } from "../database/view-config"
import { CreativePanel } from "./creative-panel"
import { useCreativeNavStore } from "./creative-nav-store"
import {
  catalog,
  workshopSection as section,
  storySummary,
  workshopSummary,
} from "./project-fixtures.test-support"
import { useProjectStore } from "./project-store"

const queryDatabase = vi.fn()
const moveTextPage = vi.fn()
const getDatabaseView = vi.fn()
const updateDatabaseViewConfig = vi.fn()
const listTextStats = vi.fn()
const resolveDatabaseAssetPaths = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>()
  return {
    ...original,
    queryDatabase: (...args: unknown[]) => queryDatabase(...args),
    moveTextPage: (...args: unknown[]) => moveTextPage(...args),
    getDatabaseView: (...args: unknown[]) => getDatabaseView(...args),
    updateDatabaseViewConfig: (...args: unknown[]) => updateDatabaseViewConfig(...args),
    listTextStats: (...args: unknown[]) => listTextStats(...args),
    resolveDatabaseAssetPaths: (...args: unknown[]) => resolveDatabaseAssetPaths(...args),
  }
})
vi.mock("./create-project-dialog", () => ({ CreateProjectDialog: () => null }))
vi.mock("./create-section-dialog", () => ({ CreateSectionDialog: () => null }))

const relation = (...ids: string[]) => ({ type: "relation", targetNoteIds: ids })

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

const ofHills = (property: string) => ({ [property]: relation("note_hills") })

function textPage(
  noteId: string,
  title: string,
  level: "book" | "chapter" | "scene",
  parent: string | null,
  order: string,
  anchors?: string[],
) {
  const values: Record<string, unknown> = {
    lvl: { type: "select", optionId: level },
    par: relation(...(parent ? [parent] : [])),
    ord: { type: "text", value: order },
  }
  if (anchors) values.tanc = relation(...anchors)
  return row(noteId, title, values)
}

// Книга ─ Глава первая ─ Сцена один
//       ├ Глава вторая
//       └ Сцена два        (a scene straight under the book)
// Том два
const ROWS: Record<string, DatabaseRow[]> = {}

function resetRows() {
  ROWS.db_text = [
    textPage("b1", "Книга", "book", null, "a0"),
    textPage("c1", "Глава первая", "chapter", "b1", "a0", ["a1"]),
    textPage("s1", "Сцена один", "scene", "c1", "a0"),
    textPage("c2", "Глава вторая", "chapter", "b1", "a1"),
    textPage("s2", "Сцена два", "scene", "b1", "a2"),
    textPage("b2", "Том два", "book", null, "a1"),
  ]
  ROWS.db_anch = [
    row("a1", "Встреча", ofHills("sta")),
    row("a3", "Эпилог", ofHills("sta")),
    row("a4", "Мечта", ofHills("sta")),
  ]
  ROWS.db_arcs = []
}

function world(readOnly = false): ProjectCatalog {
  const workshop = workshopSummary("verse", {
    name: "Verse",
    path: "Verse",
    fileRevision: "rev-verse",
    readOnly,
    sections: [
      section("stories", { role: "stories", name: "Истории", databaseId: "db_stories" }),
      section("anchors", {
        role: "anchors",
        name: "Якоря",
        databaseId: "db_anch",
        databaseName: "Якоря",
        storiesPropertyId: "sta",
      }),
      section("arcs", {
        role: "arcs",
        name: "Арки",
        databaseId: "db_arcs",
        databaseName: "Арки",
        storiesPropertyId: "stg",
      }),
    ],
    stories: [
      storySummary("hills", {
        workshopId: "verse",
        name: "MoleHills",
        folderPath: "Verse/MoleHills",
        databaseId: "db_text",
        fileRevision: "story-rev-1",
        text: {
          databaseId: "db_text",
          properties: {
            level: "lvl",
            parent: "par",
            order: "ord",
            format: null,
            status: null,
            anchors: "tanc",
            arcs: null,
          },
          levels: [
            { id: "book", icon: null, name: "Книга", color: null, state: "ok" as const },
            { id: "chapter", icon: null, name: "Глава", color: null, state: "ok" as const },
            { id: "scene", icon: null, name: "Сцена", color: null, state: "ok" as const },
          ],
          formats: [],
          statusOptions: [],
        },
      }),
    ],
  })
  return catalog([workshop])
}

const props = (extra: Partial<PanelRenderProps> = {}) =>
  ({ databaseRuntimeEnabled: true, ...extra }) as PanelRenderProps

const pageRow = (noteId: string) =>
  document.querySelector<HTMLElement>(`[data-text-page="${noteId}"]`) as HTMLElement
const anchorButton = (name: string) => screen.getByText(name).closest("button") as HTMLButtonElement

/** The anchors database, with the one view that keeps the hand-placed order. */
const anchorsDatabase = {
  databaseId: "db_anch",
  title: "Якоря",
  icon: null,
  attachedNoteId: null,
  manifestRevision: "m1",
  locked: false,
  properties: [],
  views: [{ viewId: "v1", title: "Таблица", layout: "table", revision: "vr1", groupField: null }],
  templates: [],
  diagnostics: [],
} as DatabaseSummary

async function ready() {
  render(<CreativePanel {...props()} />)
  await waitFor(() => expect(pageRow("c1")).toBeTruthy())
  await screen.findByText("Мечта")
  await waitFor(() => expect(getDatabaseView).toHaveBeenCalled())
}

async function openMenu(trigger: HTMLElement) {
  fireEvent.contextMenu(trigger)
  await screen.findByRole("menuitem", { name: "Открыть" })
}

const entry = (name: string) => screen.queryByRole("menuitem", { name })
const isDisabled = (name: string) =>
  entry(name)?.getAttribute("aria-disabled") === "true" ||
  entry(name)?.hasAttribute("data-disabled") === true

describe("CreativePanel: moving pages and anchors without the mouse", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    localStorage.clear()
    resetRows()
    queryDatabase
      .mockReset()
      .mockImplementation(async ({ databaseId }: { databaseId: string }) => ({
        rows: ROWS[databaseId] ?? [],
        nextCursor: null,
        totalCount: (ROWS[databaseId] ?? []).length,
        diagnostics: [],
      }))
    moveTextPage.mockReset().mockResolvedValue({ revision: "next" })
    getDatabaseView
      .mockReset()
      .mockResolvedValue({ revision: "vr1", configJson: JSON.stringify({ manualOrder: [] }) })
    updateDatabaseViewConfig.mockReset().mockResolvedValue({ viewRevision: "vr2" })
    listTextStats.mockReset().mockResolvedValue([])
    resolveDatabaseAssetPaths.mockReset().mockResolvedValue({ paths: [] })
    useProjectStore.getState().reset()
    useDatabaseStore.setState({
      vaultGeneration: 1,
      databases: [anchorsDatabase],
      invalidationSeq: 0,
    })
    useCreativeNavStore.setState({
      sectionByProject: {},
      collapsed: {},
      scope: "verse",
      worksOpen: { text: true, anchors: true, notes: false },
      storyFilter: null,
      universeFilter: null,
      dataNonce: 0,
      search: "",
      pageRequest: null,
      entityRequest: null,
      createRequest: null,
    })
    act(() => useProjectStore.getState().setCatalog(world()))
  })
  afterEach(cleanup)

  describe("pages of the text", () => {
    it("moves a page up through `move_text_page`, under the same parent and before its neighbour", async () => {
      await ready()
      await openMenu(pageRow("c2"))
      expect(isDisabled("Выше")).toBe(false)
      fireEvent.click(entry("Выше")!)
      await waitFor(() => expect(moveTextPage).toHaveBeenCalledTimes(1))
      const request = moveTextPage.mock.calls[0][0]
      expect(request).toMatchObject({
        storyId: "hills",
        noteId: "c2",
        newParentNoteId: "b1",
        expectedRevision: "rev-c2",
        expectedGeneration: 1,
      })
      // Before "Глава первая" (a0): a key that sorts first.
      expect(request.orderKey < "a0").toBe(true)
    })

    it("moves a page down past its next sibling", async () => {
      await ready()
      await openMenu(pageRow("c1"))
      fireEvent.click(entry("Ниже")!)
      await waitFor(() => expect(moveTextPage).toHaveBeenCalledTimes(1))
      const request = moveTextPage.mock.calls[0][0]
      expect(request).toMatchObject({ noteId: "c1", newParentNoteId: "b1" })
      expect(request.orderKey > "a1" && request.orderKey < "a2").toBe(true)
    })

    it("nests a page into the previous one, last among its children", async () => {
      await ready()
      await openMenu(pageRow("s2"))
      expect(isDisabled("Вложить в предыдущую")).toBe(false)
      fireEvent.click(entry("Вложить в предыдущую")!)
      await waitFor(() => expect(moveTextPage).toHaveBeenCalledTimes(1))
      const request = moveTextPage.mock.calls[0][0]
      expect(request).toMatchObject({ noteId: "s2", newParentNoteId: "c2" })
    })

    it("moves a page out to the level above, right after its parent", async () => {
      await ready()
      await openMenu(pageRow("s1"))
      fireEvent.click(entry("Вынести на уровень выше")!)
      await waitFor(() => expect(moveTextPage).toHaveBeenCalledTimes(1))
      const request = moveTextPage.mock.calls[0][0]
      expect(request).toMatchObject({ noteId: "s1", newParentNoteId: "b1" })
      // Between "Глава первая" (a0) and "Глава вторая" (a1).
      expect(request.orderKey > "a0" && request.orderKey < "a1").toBe(true)

      moveTextPage.mockClear()
      cleanup()
      await ready()
      await openMenu(pageRow("c2"))
      fireEvent.click(entry("Вынести на уровень выше")!)
      await waitFor(() => expect(moveTextPage).toHaveBeenCalledTimes(1))
      expect(moveTextPage.mock.calls[0][0].newParentNoteId).toBeNull()
    })

    it("greys out what cannot be done instead of writing and failing", async () => {
      await ready()
      // The first page of a list cannot go up, nor nest under a previous page it does not have.
      await openMenu(pageRow("c1"))
      expect(isDisabled("Выше")).toBe(true)
      expect(isDisabled("Вложить в предыдущую")).toBe(true) // nothing before it
      fireEvent.click(entry("Выше")!)
      fireEvent.click(entry("Вложить в предыдущую")!)
      expect(moveTextPage).not.toHaveBeenCalled()
      cleanup()

      await ready()
      await openMenu(pageRow("c2"))
      // The page before it is a chapter like itself, not a shallower level: it cannot nest there.
      expect(isDisabled("Ниже")).toBe(false)
      expect(isDisabled("Вложить в предыдущую")).toBe(true)
      expect(isDisabled("Вынести на уровень выше")).toBe(false)
      cleanup()

      await ready()
      await openMenu(pageRow("s2"))
      // Last of its list: nothing below it to pass.
      expect(isDisabled("Ниже")).toBe(true)
      fireEvent.click(entry("Ниже")!)
      expect(moveTextPage).not.toHaveBeenCalled()
      cleanup()

      await ready()
      await openMenu(pageRow("b1"))
      // At the top there is no level above.
      expect(isDisabled("Вынести на уровень выше")).toBe(true)
      expect(isDisabled("Выше")).toBe(true)
      expect(isDisabled("Вложить в предыдущую")).toBe(true)
      expect(isDisabled("Ниже")).toBe(false)
      fireEvent.click(entry("Вынести на уровень выше")!)
      expect(moveTextPage).not.toHaveBeenCalled()
    })

    it("says what the backend refused, on the part, and reads the pages again", async () => {
      moveTextPage.mockRejectedValue(new Error("The page changed"))
      await ready()
      const reads = queryDatabase.mock.calls.length
      await openMenu(pageRow("c2"))
      fireEvent.click(entry("Выше")!)
      const alert = await screen.findByRole("alert")
      expect(alert.textContent).toContain("The page changed")
      await waitFor(() => expect(queryDatabase.mock.calls.length).toBeGreaterThan(reads))
    })

    it("offers no moves in a workshop that is read-only", async () => {
      act(() => useProjectStore.getState().setCatalog(world(true)))
      render(<CreativePanel {...props()} />)
      await waitFor(() => expect(pageRow("c2")).toBeTruthy())
      await openMenu(pageRow("c2"))
      expect(entry("Выше")).toBeNull()
      expect(entry("Ниже")).toBeNull()
      expect(entry("Вложить в предыдущую")).toBeNull()
      expect(entry("Вынести на уровень выше")).toBeNull()
    })

    it("opens the menu from the keyboard like the file tree: the Menu key or Shift+F10", async () => {
      await ready()
      // The focused control of the row: its name, not the fold toggle.
      const target = pageRow("c2").querySelector<HTMLElement>("button:not([aria-expanded])")!
      fireEvent.keyDown(target, { key: "ContextMenu" })
      await screen.findByRole("menuitem", { name: "Выше" })
      fireEvent.keyDown(document.body, { key: "Escape" })
      await waitFor(() => expect(entry("Выше")).toBeNull())
      fireEvent.keyDown(target, { key: "F10", shiftKey: true })
      await screen.findByRole("menuitem", { name: "Выше" })
    })
  })

  describe("anchors ahead", () => {
    // "Встреча" is bound to a chapter and stands where the text puts it; "Мечта" and "Эпилог"
    // are bound to nothing and sit ahead, in the author's order.
    it("moves an anchor ahead one place down, writing the hand-placed order of the view", async () => {
      await ready()
      const names = ["Мечта", "Эпилог"]
      const first = names[0]
      await openMenu(screen.getByText(first))
      expect(isDisabled("Выше")).toBe(true)
      expect(isDisabled("Ниже")).toBe(false)
      expect(entry("Вложить в предыдущую")).toBeNull()
      fireEvent.click(entry("Ниже")!)
      await waitFor(() => expect(updateDatabaseViewConfig).toHaveBeenCalledTimes(1))
      const call = updateDatabaseViewConfig.mock.calls[0][0]
      expect(call).toMatchObject({
        databaseId: "db_anch",
        viewId: "v1",
        expectedViewRevision: "vr1",
      })
      expect(parseViewSettings(call.configJson).manualOrder).toEqual(["a3", "a4"])
    })

    it("moves the last anchor ahead up, and cannot move it further down", async () => {
      await ready()
      await openMenu(screen.getByText("Эпилог"))
      expect(isDisabled("Ниже")).toBe(true)
      fireEvent.click(entry("Ниже")!)
      expect(updateDatabaseViewConfig).not.toHaveBeenCalled()
      fireEvent.click(entry("Выше")!)
      await waitFor(() => expect(updateDatabaseViewConfig).toHaveBeenCalledTimes(1))
      expect(
        parseViewSettings(updateDatabaseViewConfig.mock.calls[0][0].configJson).manualOrder,
      ).toEqual(["a3", "a4"])
    })

    it("gives an anchor bound to a page no such entries: the text sets its place", async () => {
      await ready()
      await openMenu(screen.getByText("Встреча"))
      expect(entry("Выше")).toBeNull()
      expect(entry("Ниже")).toBeNull()
    })

    it("shows why a save failed on the part", async () => {
      updateDatabaseViewConfig.mockRejectedValue(new Error("The view changed"))
      await ready()
      await openMenu(screen.getByText("Мечта"))
      fireEvent.click(entry("Ниже")!)
      const alert = await screen.findByRole("alert")
      expect(alert.textContent).toContain("The view changed")
    })

    it("offers no order in a workshop that is read-only", async () => {
      act(() => useProjectStore.getState().setCatalog(world(true)))
      render(<CreativePanel {...props()} />)
      await screen.findByText("Мечта")
      await openMenu(screen.getByText("Мечта"))
      expect(entry("Выше")).toBeNull()
      expect(entry("Ниже")).toBeNull()
    })

    it("keeps the ahead anchors reachable by keyboard: the Menu key on the row", async () => {
      await ready()
      fireEvent.keyDown(anchorButton("Мечта"), { key: "ContextMenu" })
      expect(await screen.findByRole("menuitem", { name: "Ниже" })).toBeTruthy()
    })
  })
})
