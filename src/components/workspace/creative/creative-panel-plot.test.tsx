// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { logger } from "@/lib/logger"
import type { DatabaseRow, DatabaseSummary, ProjectCatalog } from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"
import { useDatabaseStore } from "../database/database-store"
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
const ensurePlotLinks = vi.fn()
const updateDatabaseRelationValue = vi.fn()
const createWorkshopEntity = vi.fn()
const listTextStats = vi.fn()
const resolveDatabaseAssetPaths = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>()
  return {
    ...original,
    queryDatabase: (...args: unknown[]) => queryDatabase(...args),
    ensurePlotLinks: (...args: unknown[]) => ensurePlotLinks(...args),
    updateDatabaseRelationValue: (...args: unknown[]) => updateDatabaseRelationValue(...args),
    createWorkshopEntity: (...args: unknown[]) => createWorkshopEntity(...args),
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

/** The "Stories" relation of an anchor or an arc: the card of the story "hills". */
const ofHills = (property: string) => ({ [property]: relation("note_hills") })

function textPage(
  noteId: string,
  title: string,
  parent: string | null,
  order: string,
  links: { anchors?: string[]; arcs?: string[] } = {},
) {
  const values: Record<string, unknown> = {
    lvl: { type: "select", optionId: parent ? "chapter" : "book" },
    par: relation(...(parent ? [parent] : [])),
    ord: { type: "text", value: order },
  }
  if (links.anchors) values.tanc = relation(...links.anchors)
  if (links.arcs) values.tarc = relation(...links.arcs)
  return row(noteId, title, values)
}

const ROWS: Record<string, DatabaseRow[]> = {
  db_text: [],
  db_anch: [],
  db_arcs: [],
}

function resetRows() {
  ROWS.db_text = [
    textPage("b1", "Книга", null, "a0"),
    textPage("c1", "Глава первая", "b1", "a0", {
      anchors: ["a1"],
      arcs: ["r1", "r2", "r3", "r4"],
    }),
    textPage("c2", "Глава вторая", "b1", "a1", { anchors: ["a2", "a1"], arcs: ["r1"] }),
  ]
  ROWS.db_anch = [
    row("a1", "Встреча", ofHills("sta")),
    row("a2", "Финал", ofHills("sta")),
    row("a3", "Эпилог", ofHills("sta")),
    row("a4", "Мечта", ofHills("sta")),
    // In no story: not listed under this one.
    row("a5", "Чужой"),
  ]
  ROWS.db_arcs = [
    row("r1", "Любовь", ofHills("stg")),
    row("r2", "Месть", ofHills("stg")),
    row("r3", "Дорога", ofHills("stg")),
    row("r4", "Тайна", ofHills("stg")),
    row("r5", "Чужая", {}),
  ]
}

function text(withProperties: boolean) {
  return {
    databaseId: "db_text",
    properties: {
      level: "lvl",
      parent: "par",
      order: "ord",
      format: null,
      status: null,
      anchors: withProperties ? "tanc" : null,
      arcs: withProperties ? "tarc" : null,
    },
    levels: [
      { id: "book", icon: null, name: "Книга", color: null, state: "ok" as const },
      { id: "chapter", icon: null, name: "Глава", color: null, state: "ok" as const },
    ],
    formats: [],
    statusOptions: [],
  }
}

function world(
  options: { withProperties?: boolean; anchorsHaveArcs?: boolean; readOnly?: boolean } = {},
): ProjectCatalog {
  const { withProperties = true, anchorsHaveArcs = true, readOnly = false } = options
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
        arcsPropertyId: anchorsHaveArcs ? "aarc" : null,
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
        text: text(withProperties),
      }),
    ],
  })
  return catalog([workshop])
}

const props = (extra: Partial<PanelRenderProps> = {}) =>
  ({ databaseRuntimeEnabled: true, ...extra }) as PanelRenderProps

/** A drag's data, as the browser keeps it between the start and the drop. */
function transfer() {
  const data: Record<string, string> = {}
  return {
    setData: (type: string, value: string) => {
      data[type] = value
    },
    getData: (type: string) => data[type] ?? "",
    get types() {
      return Object.keys(data)
    },
    effectAllowed: "",
    dropEffect: "",
  }
}

const pageRow = (noteId: string) =>
  document.querySelector<HTMLElement>(`[data-text-page="${noteId}"]`) as HTMLElement
const rowButton = (name: string) => screen.getByText(name).closest("button") as HTMLButtonElement

async function ready() {
  render(<CreativePanel {...props()} />)
  await screen.findByText("Глава первая")
  await screen.findByText("Встреча")
  await screen.findByText("Любовь")
}

/** Drags an anchor or an arc from its row onto a page of the text. */
function dragOnto(source: HTMLElement, pageId: string) {
  const dataTransfer = transfer()
  fireEvent.dragStart(source, { dataTransfer })
  fireEvent.dragOver(pageRow(pageId), { dataTransfer })
  fireEvent.drop(pageRow(pageId), { dataTransfer })
}

describe("CreativePanel: anchors and arcs bound to the pages of a story", () => {
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
    ensurePlotLinks.mockReset().mockResolvedValue({
      operationId: "x",
      workshopId: "verse",
      target: "story",
      storyId: "hills",
      anchorsPropertyId: "tanc",
      arcsPropertyId: "tarc",
      universePropertyId: null,
      revision: "story-rev-2",
      changed: true,
      replayed: false,
      warnings: [],
    })
    updateDatabaseRelationValue.mockReset().mockResolvedValue({ revisions: [], warnings: [] })
    createWorkshopEntity.mockReset().mockResolvedValue({ noteId: "new-note", linkedStoryId: null })
    listTextStats.mockReset().mockResolvedValue([])
    resolveDatabaseAssetPaths.mockReset().mockResolvedValue({ paths: [] })
    useProjectStore.getState().reset()
    useDatabaseStore.setState({
      vaultGeneration: 1,
      databases: [] as DatabaseSummary[],
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

  describe("what the tree shows", () => {
    it("marks a page with its anchors and up to three arcs, and a page bound to nothing has no marks", async () => {
      await ready()
      const first = pageRow("c1")
      // One anchor: the mark has no number. Four arcs: three dots and "+1".
      const anchorMark = within(first).getByTestId("page-anchor-mark")
      expect(anchorMark.textContent).toBe("")
      expect(anchorMark.getAttribute("title")).toContain("Встреча")
      expect(first.querySelectorAll("[data-arc-dot]")).toHaveLength(3)
      expect(within(first).getByTestId("page-arc-marks").textContent).toBe("+1")

      const second = pageRow("c2")
      expect(within(second).getByTestId("page-anchor-mark").textContent).toBe("2")
      expect(second.querySelectorAll("[data-arc-dot]")).toHaveLength(1)
      expect(within(second).queryByText(/^\+/u)).toBeNull()

      expect(within(pageRow("b1")).queryByTestId("page-marks")).toBeNull()
    })

    it("gives an arc the same color on every page", async () => {
      await ready()
      const dotOf = (pageId: string) =>
        pageRow(pageId).querySelector<HTMLElement>('[data-arc-dot="r1"]')!.style.backgroundColor
      expect(dotOf("c1")).not.toBe("")
      expect(dotOf("c1")).toBe(dotOf("c2"))
    })

    it("lists the anchors of the story by the text, with the page, then those ahead", async () => {
      await ready()
      const names = ["Встреча", "Финал", "Мечта", "Эпилог"]
      const rows = names.map(rowButton)
      for (let index = 1; index < rows.length; index += 1) {
        expect(
          rows[index - 1].compareDocumentPosition(rows[index]) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy()
      }
      // Bound anchors say where they stand: the earliest page, and how many more.
      expect(within(rows[0]).getByTestId("anchor-place").textContent).toBe("Глава первая +1")
      expect(within(rows[1]).getByTestId("anchor-place").textContent).toBe("Глава вторая")
      expect(within(rows[2]).queryByTestId("anchor-place")).toBeNull()
      // "Ahead" heads only the ones bound to no page; an anchor of no story is not listed.
      const heading = screen.getByText("Впереди")
      expect(
        rows[1].compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      expect(
        heading.compareDocumentPosition(rows[2]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      expect(screen.queryByText("Чужой")).toBeNull()
      // The order of a bound anchor is the text's, and the row says so instead of ignoring a drag.
      expect(rows[0].getAttribute("title")).toContain("задаёт текст")
    })

    it("lets only the anchors ahead be dragged into an order of their own", async () => {
      await ready()
      const dataTransfer = transfer()
      // Dropping a bound anchor on another bound one changes nothing: it is not a place to drop.
      fireEvent.dragStart(rowButton("Эпилог"), { dataTransfer })
      const over = new Event("dragover", { bubbles: true, cancelable: true })
      Object.assign(over, { dataTransfer })
      expect(rowButton("Финал").dispatchEvent(over)).toBe(true)
      const ahead = new Event("dragover", { bubbles: true, cancelable: true })
      Object.assign(ahead, { dataTransfer, clientY: 0 })
      expect(rowButton("Мечта").dispatchEvent(ahead)).toBe(false)
    })
  })

  describe("binding by dragging", () => {
    it("adds an anchor to a page without asking for a property the text already has, and keeps the other bindings", async () => {
      await ready()
      dragOnto(rowButton("Эпилог"), "c2")
      await waitFor(() => expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(1))
      expect(updateDatabaseRelationValue.mock.calls[0][0]).toMatchObject({
        databaseId: "db_text",
        noteId: "c2",
        propertyId: "tanc",
        expectedRevision: "rev-c2",
        // The page had Финал and Встреча; both stay.
        targetNoteIds: ["a2", "a1", "a3"],
      })
      expect(ensurePlotLinks).not.toHaveBeenCalled()
    })

    it("adds an arc dragged from the arcs list the same way", async () => {
      await ready()
      dragOnto(rowButton("Месть"), "c2")
      await waitFor(() => expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(1))
      expect(updateDatabaseRelationValue.mock.calls[0][0]).toMatchObject({
        noteId: "c2",
        propertyId: "tarc",
        targetNoteIds: ["r1", "r2"],
      })
    })

    it("writes nothing when the page already has the anchor", async () => {
      await ready()
      dragOnto(rowButton("Финал"), "c2")
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(updateDatabaseRelationValue).not.toHaveBeenCalled()
      expect(ensurePlotLinks).not.toHaveBeenCalled()
    })

    it("does not take a dragged page for an anchor, and does not bind a page onto itself", async () => {
      await ready()
      const dataTransfer = transfer()
      fireEvent.dragStart(pageRow("c1"), { dataTransfer })
      fireEvent.dragOver(pageRow("c2"), { dataTransfer })
      fireEvent.drop(pageRow("c2"), { dataTransfer })
      expect(updateDatabaseRelationValue).not.toHaveBeenCalled()
    })

    it("asks the backend once for what a text made before the anchors lacks, then writes", async () => {
      act(() =>
        useProjectStore
          .getState()
          .setCatalog(world({ withProperties: false, anchorsHaveArcs: false })),
      )
      ROWS.db_text = ROWS.db_text.map((entry) => ({ ...entry, valuesJson: "{}" }))
      await ready()
      dragOnto(rowButton("Эпилог"), "c2")
      await waitFor(() => expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(1))

      // The story's text first, with the revision of its file; the anchors' own relations after.
      expect(ensurePlotLinks).toHaveBeenCalledTimes(2)
      expect(ensurePlotLinks.mock.calls[0][0]).toMatchObject({
        workshopId: "verse",
        target: "story",
        storyId: "hills",
        expectedRevision: "story-rev-1",
        labels: { "property:anchors": "Якоря", "property:arcs": "Арки" },
      })
      expect(ensurePlotLinks.mock.calls[1][0]).toMatchObject({
        target: "anchors",
        expectedRevision: "rev-verse",
      })
      // The value goes to the property the backend named.
      expect(updateDatabaseRelationValue.mock.calls[0][0]).toMatchObject({
        noteId: "c2",
        propertyId: "tanc",
        targetNoteIds: ["a3"],
      })
    })

    it("binds all the same when the anchors' own relations cannot be made, and logs why", async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => null)
      try {
        act(() =>
          useProjectStore
            .getState()
            .setCatalog(world({ withProperties: false, anchorsHaveArcs: false })),
        )
        ensurePlotLinks.mockImplementation(async (request: { target: string }) => {
          if (request.target === "anchors") throw new Error("anchors are locked")
          return {
            changed: true,
            revision: "story-rev-2",
            anchorsPropertyId: "tanc",
            arcsPropertyId: "tarc",
            universePropertyId: null,
          }
        })
        ROWS.db_text = ROWS.db_text.map((entry) => ({ ...entry, valuesJson: "{}" }))
        await ready()
        dragOnto(rowButton("Эпилог"), "c2")
        await waitFor(() => expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(1))
        expect(warn).toHaveBeenCalledWith(
          "creative.plot.anchor_links_failed",
          expect.objectContaining({ workshopId: "verse" }),
        )
      } finally {
        warn.mockRestore()
      }
    })

    it("does not ask again once the catalog knows the property", async () => {
      act(() =>
        useProjectStore
          .getState()
          .setCatalog(world({ withProperties: false, anchorsHaveArcs: true })),
      )
      render(<CreativePanel {...props()} />)
      await screen.findByText("Эпилог")
      dragOnto(rowButton("Эпилог"), "c2")
      await waitFor(() => expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(1))
      expect(ensurePlotLinks).toHaveBeenCalledTimes(1)
      expect(ensurePlotLinks.mock.calls[0][0].target).toBe("story")

      // The catalog is read again: the text now names its relation.
      act(() => useProjectStore.getState().setCatalog(world()))
      dragOnto(rowButton("Мечта"), "c1")
      await waitFor(() => expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(2))
      expect(ensurePlotLinks).toHaveBeenCalledTimes(1)
    })

    it("says on the page row why a binding failed, and nothing else changes", async () => {
      updateDatabaseRelationValue.mockRejectedValue(new Error("The page changed"))
      await ready()
      dragOnto(rowButton("Эпилог"), "c2")
      const alert = await screen.findByRole("alert")
      expect(alert.textContent).toContain("The page changed")
      // It stands under the row of the page it was dropped on.
      expect(pageRow("c2").parentElement?.contains(alert)).toBe(true)
      expect(alert.previousElementSibling?.contains(pageRow("c2"))).toBe(true)
    })

    it("offers nothing to drop on when the workshop is read-only", async () => {
      act(() => useProjectStore.getState().setCatalog(world({ readOnly: true })))
      render(<CreativePanel {...props()} />)
      await screen.findByText("Эпилог")
      expect(rowButton("Эпилог").getAttribute("draggable")).not.toBe("true")
      dragOnto(rowButton("Эпилог"), "c2")
      expect(updateDatabaseRelationValue).not.toHaveBeenCalled()
    })
  })

  describe("binding and unbinding from menus", () => {
    async function openSubmenu(trigger: HTMLElement, label: string) {
      fireEvent.contextMenu(trigger)
      fireEvent.click(await screen.findByRole("menuitem", { name: label }))
    }

    it("lists the story's anchors in the page's menu with the bound ones checked, and flips a choice", async () => {
      await ready()
      await openSubmenu(pageRow("c1"), "Якоря")
      const bound = await screen.findByRole("menuitemcheckbox", { name: "Встреча" })
      expect(bound.getAttribute("aria-checked")).toBe("true")
      expect(
        screen.getByRole("menuitemcheckbox", { name: "Финал" }).getAttribute("aria-checked"),
      ).toBe("false")
      // Only this story's anchors.
      expect(screen.queryByRole("menuitemcheckbox", { name: "Чужой" })).toBeNull()

      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Финал" }))
      await waitFor(() => expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(1))
      expect(updateDatabaseRelationValue.mock.calls[0][0]).toMatchObject({
        noteId: "c1",
        propertyId: "tanc",
        targetNoteIds: ["a1", "a2"],
      })
    })

    it("unbinds a checked choice and keeps the rest", async () => {
      await ready()
      await openSubmenu(pageRow("c2"), "Якоря")
      fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Встреча" }))
      await waitFor(() => expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(1))
      expect(updateDatabaseRelationValue.mock.calls[0][0]).toMatchObject({
        noteId: "c2",
        propertyId: "tanc",
        targetNoteIds: ["a2"],
      })
      expect(ensurePlotLinks).not.toHaveBeenCalled()
    })

    it("binds an arc from the page's menu", async () => {
      await ready()
      await openSubmenu(pageRow("c2"), "Арки")
      fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Тайна" }))
      await waitFor(() => expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(1))
      expect(updateDatabaseRelationValue.mock.calls[0][0]).toMatchObject({
        noteId: "c2",
        propertyId: "tarc",
        targetNoteIds: ["r1", "r4"],
      })
    })

    it("unbinds an anchor from one of its pages by the anchor's own menu", async () => {
      await ready()
      await openSubmenu(screen.getByText("Встреча"), "Отвязать от страницы")
      // It is on both chapters; the text order lists them.
      const pages = await screen.findAllByRole("menuitem", { name: /Глава/ })
      expect(pages.map((page) => page.textContent)).toEqual(["Глава первая", "Глава вторая"])
      fireEvent.click(pages[1])
      await waitFor(() => expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(1))
      expect(updateDatabaseRelationValue.mock.calls[0][0]).toMatchObject({
        noteId: "c2",
        propertyId: "tanc",
        targetNoteIds: ["a2"],
      })
    })

    it("unbinds an arc the same way, and offers no unbinding for one bound to nothing", async () => {
      await ready()
      await openSubmenu(screen.getByText("Месть"), "Отвязать от страницы")
      fireEvent.click(await screen.findByRole("menuitem", { name: "Глава первая" }))
      await waitFor(() => expect(updateDatabaseRelationValue).toHaveBeenCalledTimes(1))
      expect(updateDatabaseRelationValue.mock.calls[0][0]).toMatchObject({
        noteId: "c1",
        propertyId: "tarc",
        targetNoteIds: ["r1", "r3", "r4"],
      })

      cleanup()
      render(<CreativePanel {...props()} />)
      await screen.findByText("Эпилог")
      fireEvent.contextMenu(screen.getByText("Эпилог"))
      await screen.findByRole("menuitem", { name: "Открыть" })
      expect(screen.queryByRole("menuitem", { name: "Отвязать от страницы" })).toBeNull()
    })

    it("shows the failure of an unbinding on the anchor's row", async () => {
      updateDatabaseRelationValue.mockRejectedValue(new Error("Locked"))
      await ready()
      await openSubmenu(screen.getByText("Финал"), "Отвязать от страницы")
      fireEvent.click(await screen.findByRole("menuitem", { name: "Глава вторая" }))
      const alert = await screen.findByRole("alert")
      expect(alert.textContent).toContain("Locked")
      expect(alert.previousElementSibling?.contains(rowButton("Финал"))).toBe(true)
    })
  })

  it("makes a new anchor in the shown story linked to it from the first write", async () => {
    await ready()
    const header = screen.getByRole("button", { name: /Якоря/ }).parentElement as HTMLElement
    fireEvent.click(within(header).getByRole("button", { name: "Добавить" }))
    const field = await screen.findByRole("textbox", {
      name: "Название якоря — Enter, чтобы создать",
    })
    fireEvent.change(field, { target: { value: "Свадьба" } })
    fireEvent.keyDown(field, { key: "Enter" })
    await waitFor(() => expect(createWorkshopEntity).toHaveBeenCalledTimes(1))
    expect(createWorkshopEntity.mock.calls[0][0]).toMatchObject({
      sectionId: "anchors",
      title: "Свадьба",
      storyId: "hills",
    })
  })
})
