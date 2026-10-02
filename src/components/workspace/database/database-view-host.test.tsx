// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import * as storage from "@/lib/storage"
import type { DatabaseRow, DatabaseSummary } from "@/lib/storage"
import { DatabaseViewHost } from "./database-view-host"
import { registerDatabaseNavigation } from "./database-navigation"
import { useDatabaseStore } from "./database-store"
import { currentPageFilter } from "./embedded-view-model"
import { _clearInFlightQueriesForTesting } from "./use-database-query"

const DB = "01J00000000000000000000010"
const VIEW = "01J00000000000000000000011"
const PAGE = "01J00000000000000000000099"
const PROJECT_DB = "01J00000000000000000000050"

const database = (extra: Partial<DatabaseSummary> = {}): DatabaseSummary => ({
  databaseId: DB,
  title: "Tasks",
  icon: null,
  attachedNoteId: null,
  manifestRevision: "m",
  locked: false,
  properties: [
    {
      propertyId: "01J00000000000000000000020",
      name: "Project",
      propertyType: "relation",
      configJson: JSON.stringify({ targetDatabaseId: PROJECT_DB }),
      options: [],
    },
  ],
  views: [{ viewId: VIEW, title: "All tasks", layout: "table", revision: "r1", groupField: null }],
  templates: [],
  diagnostics: [],
  ...extra,
})

const row = (noteId: string, title: string): DatabaseRow => ({
  noteId,
  title,
  relativePath: `${title}.md`,
  parentNoteId: null,
  depth: 0,
  categoryPath: [],
  valuesJson: "{}",
  rowRevision: "rev",
})

function setup(viewFilter: unknown = null) {
  useDatabaseStore.getState().reset(1)
  useDatabaseStore.getState().setRuntime({ enabled: true, vaultGeneration: 1, projection: null })
  useDatabaseStore.getState().setCatalog([database()])
  vi.spyOn(storage, "getDatabaseView").mockResolvedValue({
    databaseId: DB,
    viewId: VIEW,
    title: "All tasks",
    layout: "table",
    revision: "r1",
    configJson: JSON.stringify({
      format: "amby-database-view",
      databaseId: DB,
      viewId: VIEW,
      layout: "table",
      fields: [],
      filter: viewFilter,
      sorts: [],
      layoutConfig: {},
    }),
  })
  vi.spyOn(storage, "getDatabaseNoteContext").mockResolvedValue({
    vaultGeneration: 1,
    databaseId: PROJECT_DB,
    databaseTitle: "Projects",
    databaseIcon: null,
    manifestRevision: "m",
    locked: false,
    properties: [],
    row: row(PAGE, "Site"),
  })
  vi.spyOn(storage, "resolveRecordReferences").mockResolvedValue({ references: [] })
  return vi.spyOn(storage, "queryDatabase").mockResolvedValue({
    database: {} as never,
    projection: {} as never,
    rows: [row("n1", "Design the homepage")],
    nextCursor: null,
    diagnostics: [],
    totalCount: 1,
  })
}

describe("DatabaseViewHost", () => {
  beforeEach(() => _clearInFlightQueriesForTesting())
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useDatabaseStore.getState().reset(null)
  })

  it("shows the shared view's records and asks the backend for this page's context", async () => {
    const query = setup()
    render(
      <DatabaseViewHost
        reference={{
          databaseId: DB,
          viewId: VIEW,
          layout: "list",
          filter: currentPageFilter("01J00000000000000000000020"),
        }}
        noteId={PAGE}
        editable
      />,
    )
    await screen.findByText("Design the homepage")
    const request = query.mock.calls[0][0]
    expect(request.contextPageId).toBe(PAGE)
    // The block's own filter is combined with the (empty) shared one and sent as a query filter.
    expect(JSON.stringify(request.filter)).toContain("@currentPage")
    expect(request.source).toMatchObject({ kind: "inline" })
  })

  it("opens a record through the app, not inside the block", async () => {
    setup()
    const openNote = vi.fn()
    const unregister = registerDatabaseNavigation({ openNote, openDatabase: vi.fn() })
    render(
      <DatabaseViewHost
        reference={{ databaseId: DB, viewId: VIEW, layout: "list" }}
        noteId={PAGE}
        editable={false}
      />,
    )
    fireEvent.click(await screen.findByText("Design the homepage"))
    expect(openNote).toHaveBeenCalledWith("n1")
    unregister()
  })

  it("creates a record and links it to the page the view is on", async () => {
    setup()
    const created = {
      databaseId: DB,
      noteId: "01J00000000000000000000077",
      title: "New record",
      notePath: "/vault/Tasks/New record.md",
      recordPath: "",
      recordRevision: "",
      warnings: [],
    }
    const create = vi.spyOn(storage, "createDatabaseRow").mockResolvedValue(created)
    vi.spyOn(storage, "getFileRevision").mockResolvedValue("raw-rev")
    const link = vi.spyOn(storage, "updateDatabaseRelationValue").mockResolvedValue({
      operationId: "x",
      databaseId: DB,
      noteId: created.noteId,
      targetNoteIds: [PAGE],
      affectedNotes: [],
      revisions: [],
      warnings: [],
    })
    render(
      <DatabaseViewHost
        reference={{
          databaseId: DB,
          viewId: VIEW,
          layout: "list",
          filter: currentPageFilter("01J00000000000000000000020"),
        }}
        noteId={PAGE}
        editable
      />,
    )
    await screen.findByText("Design the homepage")
    fireEvent.click(screen.getByRole("button", { name: /Добавить/ }))
    await waitFor(() => expect(link).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0][0]).toMatchObject({ databaseId: DB })
    expect(link.mock.calls[0][0]).toMatchObject({
      databaseId: DB,
      noteId: created.noteId,
      propertyId: "01J00000000000000000000020",
      targetNoteIds: [PAGE],
      expectedRevision: "raw-rev",
    })
    expect((await screen.findByRole("status")).textContent).toContain("связана с этой страницей")
  })

  it("explains that other conditions can hide a new record", async () => {
    setup({
      kind: "condition",
      field: { kind: "property", propertyId: "s" },
      operator: "equals",
      value: "todo",
    })
    vi.spyOn(storage, "createDatabaseRow").mockResolvedValue({
      databaseId: DB,
      noteId: "01J00000000000000000000078",
      title: "x",
      notePath: "/v/x.md",
      recordPath: "",
      recordRevision: "",
      warnings: [],
    })
    vi.spyOn(storage, "getFileRevision").mockResolvedValue("r")
    vi.spyOn(storage, "updateDatabaseRelationValue").mockResolvedValue({
      operationId: "x",
      databaseId: DB,
      noteId: "n",
      targetNoteIds: [],
      affectedNotes: [],
      revisions: [],
      warnings: [],
    })
    render(
      <DatabaseViewHost
        reference={{
          databaseId: DB,
          viewId: VIEW,
          layout: "list",
          filter: currentPageFilter("01J00000000000000000000020"),
        }}
        noteId={PAGE}
        editable
      />,
    )
    await screen.findByText("Design the homepage")
    fireEvent.click(screen.getByRole("button", { name: /Добавить/ }))
    expect((await screen.findByRole("status")).textContent).toContain("не появится")
  })

  it("lets the embedding choose a layout and tie the view to the page, saving into its reference", async () => {
    setup()
    const onChange = vi.fn()
    render(
      <DatabaseViewHost
        reference={{ databaseId: DB, viewId: VIEW, layout: "list" }}
        noteId={PAGE}
        editable
        onReferenceChange={onChange}
      />,
    )
    await screen.findByText("Design the homepage")
    fireEvent.click(screen.getByRole("button", { name: "Галерея" }))
    expect(onChange).toHaveBeenLastCalledWith({ layout: "gallery" })
    const select = await screen.findByLabelText("Связано с этой страницей")
    await act(async () => {
      fireEvent.change(select, { target: { value: "01J00000000000000000000020" } })
    })
    expect(onChange).toHaveBeenLastCalledWith({
      filter: currentPageFilter("01J00000000000000000000020"),
    })
  })

  it("does not offer editing when the page is read-only", async () => {
    setup()
    render(
      <DatabaseViewHost
        reference={{ databaseId: DB, viewId: VIEW, layout: "list" }}
        noteId={PAGE}
        editable={false}
      />,
    )
    await screen.findByText("Design the homepage")
    expect(screen.queryByRole("button", { name: /Добавить/ })).toBeNull()
    expect(screen.queryByLabelText("Вид")).toBeNull()
  })
})
