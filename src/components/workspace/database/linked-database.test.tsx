// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import * as storage from "@/lib/storage"
import type { DatabaseRow, DatabaseSummary } from "@/lib/storage"
import { LinkedDatabase } from "./linked-database"
import { registerDatabaseNavigation } from "./database-navigation"
import { useDatabaseStore } from "./database-store"
import { currentPageFilter } from "./embedded-view-model"
import type { LinkedBlock, LinkedView } from "./linked-block"
import { _clearInFlightQueriesForTesting } from "./use-database-query"

const DB = "01J00000000000000000000010"
const VIEW = "01J00000000000000000000011"
const PAGE = "01J00000000000000000000099"
const PROJECT_DB = "01J00000000000000000000050"
const PROJECT_VIEW = "01J00000000000000000000051"
const RELATION = "01J00000000000000000000020"

const database = (extra: Partial<DatabaseSummary> = {}): DatabaseSummary => ({
  databaseId: DB,
  title: "Tasks",
  icon: null,
  attachedNoteId: null,
  manifestRevision: "m",
  locked: false,
  properties: [
    {
      propertyId: RELATION,
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

const projects = (): DatabaseSummary =>
  database({
    databaseId: PROJECT_DB,
    title: "Projects",
    properties: [],
    views: [
      { viewId: PROJECT_VIEW, title: "Roadmap", layout: "board", revision: "r", groupField: null },
    ],
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

const view = (extra: Partial<LinkedView> = {}): LinkedView => ({
  id: "v1",
  databaseId: DB,
  title: "My tasks",
  layout: "list",
  config: {},
  extra: {},
  ...extra,
})

const lastBlock = (fn: { mock: { calls: unknown[][] } }) =>
  fn.mock.calls[fn.mock.calls.length - 1][0] as LinkedBlock

const blockOf = (...views: LinkedView[]): LinkedBlock => ({ views, extra: {} })

function setup(databases: DatabaseSummary[] = [database(), projects()]) {
  useDatabaseStore.getState().reset(1)
  useDatabaseStore.getState().setRuntime({ enabled: true, vaultGeneration: 1, projection: null })
  useDatabaseStore.getState().setCatalog(databases)
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

describe("LinkedDatabase", () => {
  beforeEach(() => _clearInFlightQueriesForTesting())
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useDatabaseStore.getState().reset(null)
  })

  it("shows the database's records in the tab's own layout and filter", async () => {
    const query = setup()
    render(
      <LinkedDatabase
        block={blockOf(view({ pageFilter: currentPageFilter(RELATION) }))}
        noteId={PAGE}
        editable
        onBlockChange={vi.fn()}
      />,
    )
    await screen.findByText("Design the homepage")
    const request = query.mock.calls[0][0]
    expect(request.databaseId).toBe(DB)
    expect(request.contextPageId).toBe(PAGE)
    expect(JSON.stringify(request.filter)).toContain("@currentPage")
  })

  it("names the tab itself and the database in its tooltip", async () => {
    setup()
    render(
      <LinkedDatabase block={blockOf(view())} noteId={PAGE} editable onBlockChange={vi.fn()} />,
    )
    const tab = await screen.findByRole("tab", { name: "My tasks" })
    expect(tab.getAttribute("title")).toBe("Tasks")
  })

  it("opens a record through the app, not inside the block", async () => {
    setup()
    const openNote = vi.fn()
    const unregister = registerDatabaseNavigation({ openNote, openDatabase: vi.fn() })
    render(<LinkedDatabase block={blockOf(view())} noteId={PAGE} editable={false} />)
    fireEvent.click(await screen.findByText("Design the homepage"))
    expect(openNote).toHaveBeenCalledWith("n1")
    unregister()
  })

  it("creates a record and links it to the page the view is tied to", async () => {
    setup()
    const created = {
      databaseId: DB,
      noteId: "01J00000000000000000000077",
      title: "New record",
      notePath: "/v/new.md",
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
      <LinkedDatabase
        block={blockOf(view({ pageFilter: currentPageFilter(RELATION) }))}
        noteId={PAGE}
        editable
        onBlockChange={vi.fn()}
      />,
    )
    await screen.findByText("Design the homepage")
    fireEvent.click(screen.getByRole("button", { name: "Новая" }))
    await waitFor(() => expect(link).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0][0]).toMatchObject({ databaseId: DB })
    expect(link.mock.calls[0][0]).toMatchObject({
      propertyId: RELATION,
      targetNoteIds: [PAGE],
      expectedRevision: "raw-rev",
    })
    expect((await screen.findByRole("status")).textContent).toContain("связана с этой страницей")
  })

  it("moves between tabs of different databases without writing anything", async () => {
    const query = setup()
    const onChange = vi.fn()
    render(
      <LinkedDatabase
        block={blockOf(
          view(),
          view({ id: "v2", databaseId: PROJECT_DB, title: "", layout: "table" }),
        )}
        noteId={PAGE}
        editable
        onBlockChange={onChange}
      />,
    )
    await screen.findByText("Design the homepage")
    // A tab with no name of its own shows its database's.
    fireEvent.click(screen.getByRole("tab", { name: "Projects" }))
    await waitFor(() =>
      expect(query.mock.calls.some(([request]) => request.databaseId === PROJECT_DB)).toBe(true),
    )
    expect(screen.getByRole("tab", { name: "Projects" }).getAttribute("aria-selected")).toBe("true")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("keeps the tab's settings in the block, not in the database's view", async () => {
    setup()
    const databaseWrite = vi.spyOn(storage, "updateDatabaseViewConfig")
    const onChange = vi.fn()
    render(
      <LinkedDatabase block={blockOf(view())} noteId={PAGE} editable onBlockChange={onChange} />,
    )
    await screen.findByText("Design the homepage")
    // Pressing the active tab opens its settings; the layout page changes the tab's layout.
    fireEvent.click(screen.getByRole("tab", { name: "My tasks" }))
    fireEvent.click(await screen.findByRole("button", { name: /^Раскладка/ }))
    fireEvent.click(await screen.findByRole("radio", { name: "Галерея" }))
    const next = lastBlock(onChange)
    expect(next.views[0].layout).toBe("gallery")
    expect(next.views[0].id).toBe("v1")
    expect(databaseWrite).not.toHaveBeenCalled()
  })

  it("adds a view of another database as a new tab", async () => {
    setup()
    vi.spyOn(storage, "getDatabaseView").mockResolvedValue({
      databaseId: PROJECT_DB,
      viewId: PROJECT_VIEW,
      title: "Roadmap",
      layout: "board",
      revision: "r",
      configJson: JSON.stringify({ filter: { kind: "condition" }, databaseId: PROJECT_DB }),
    })
    const onChange = vi.fn()
    render(
      <LinkedDatabase block={blockOf(view())} noteId={PAGE} editable onBlockChange={onChange} />,
    )
    await screen.findByText("Design the homepage")
    fireEvent.click(screen.getByRole("button", { name: "Добавить вид" }))
    fireEvent.click(await screen.findByRole("option", { name: /Projects/ }))
    fireEvent.click(await screen.findByRole("option", { name: /Roadmap/ }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    const next = lastBlock(onChange)
    expect(next.views).toHaveLength(2)
    expect(next.views[1]).toMatchObject({
      databaseId: PROJECT_DB,
      title: "Roadmap",
      layout: "board",
    })
    // The copy carries the settings but not the identity of the source view.
    expect(next.views[1].config).toEqual({ filter: { kind: "condition" } })
  })

  it("always fits its content and offers no resizing of its own", async () => {
    setup()
    const { container } = render(
      <LinkedDatabase
        block={{ ...blockOf(view()), extra: { height: 300, width: 500 } }}
        noteId={PAGE}
        editable
        onBlockChange={vi.fn()}
      />,
    )
    await screen.findByText("Design the homepage")
    expect(screen.queryByRole("separator")).toBeNull()
    const host = container.querySelector<HTMLElement>(".amby-database-host")!
    expect(host.style.width).toBe("100%")
    // The content decides its height, up to a limit; a saved size from before is ignored.
    expect(host.querySelector<HTMLElement>("[style*='max-height: 560px']")).not.toBeNull()
    expect(host.querySelector<HTMLElement>("[style*='height: 300px']")).toBeNull()
  })

  it("searches the view's records", async () => {
    const query = setup()
    render(<LinkedDatabase block={blockOf(view())} noteId={PAGE} editable={false} />)
    await screen.findByText("Design the homepage")
    fireEvent.click(screen.getByRole("button", { name: "Поиск" }))
    fireEvent.change(await screen.findByPlaceholderText(/Поиск по страницам/), {
      target: { value: "home" },
    })
    await waitFor(() =>
      expect(query.mock.calls.some(([request]) => JSON.stringify(request).includes("home"))).toBe(
        true,
      ),
    )
  })

  it("offers to choose a new database when the bound one is gone", async () => {
    setup([])
    const onChange = vi.fn()
    render(
      <LinkedDatabase block={blockOf(view())} noteId={PAGE} editable onBlockChange={onChange} />,
    )
    expect(await screen.findByText(/не найдена/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Выбрать базу" }))
    expect(await screen.findByText("В хранилище пока нет баз данных")).toBeTruthy()
  })

  it("does not offer editing when the page is read-only", async () => {
    setup()
    render(<LinkedDatabase block={blockOf(view())} noteId={PAGE} editable={false} />)
    await screen.findByText("Design the homepage")
    expect(screen.queryByRole("button", { name: "Новая" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Настройки" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Фильтр" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Добавить вид" })).toBeNull()
    expect(screen.queryByRole("separator")).toBeNull()
  })

  it("runs without a note context", async () => {
    setup()
    await act(async () => {
      render(<LinkedDatabase block={blockOf(view())} editable onBlockChange={vi.fn()} />)
    })
    expect(await screen.findByText("Design the homepage")).toBeTruthy()
  })
})
