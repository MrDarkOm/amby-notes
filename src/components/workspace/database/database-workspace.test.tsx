// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { databaseFailure } from "@/lib/test-utils/errors"
import type { DatabaseHostSession } from "./database-store"
import type { DatabaseRow, DatabaseSummary } from "@/lib/storage"

const storage = vi.hoisted(() => ({
  getDatabaseHistoryStatus: vi.fn(async () => ({ canUndo: false, canRedo: false })),
  getDatabaseView: vi.fn(async () => ({ revision: "doc-1", configJson: "{}" })),
  updateDatabaseViewConfig: vi.fn(),
  renameDatabase: vi.fn(),
  createDatabaseRow: vi.fn(),
  listDatabases: vi.fn(async () => []),
}))
const query = vi.hoisted(() => ({ host: null as unknown, retry: vi.fn(async () => {}) }))

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  ...storage,
}))
vi.mock("./use-database-query", () => ({
  useDatabaseQuery: () => ({
    host: query.host,
    loadNextPage: vi.fn(async () => {}),
    retry: query.retry,
  }),
}))

import { useDatabaseStore } from "./database-store"
import { DatabaseWorkspace } from "./database-workspace"

const DB = "01J00000000000000000000010"
const TABLE_VIEW = "01J00000000000000000000011"
const BOARD_VIEW = "01J00000000000000000000012"
const view = (viewId: string, title: string, layout: string) => ({
  viewId,
  title,
  layout,
  revision: "r",
  groupField: null,
})
const database = {
  databaseId: DB,
  title: "Tasks",
  icon: null,
  attachedNoteId: null,
  manifestRevision: "manifest-1",
  locked: false,
  properties: [
    {
      propertyId: "01J00000000000000000000020",
      name: "Notes",
      propertyType: "text",
      configJson: "{}",
      options: [],
    },
  ],
  views: [view(TABLE_VIEW, "All tasks", "table"), view(BOARD_VIEW, "By status", "board")],
  templates: [],
  diagnostics: [],
} as unknown as DatabaseSummary

const row = (noteId: string, title: string) =>
  ({
    noteId,
    title,
    relativePath: `${title}.md`,
    parentNoteId: null,
    depth: 0,
    categoryPath: [],
    valuesJson: "{}",
    rowRevision: "rev",
  }) as DatabaseRow

function setup() {
  useDatabaseStore.getState().reset(1)
  useDatabaseStore.getState().setRuntime({ enabled: true, vaultGeneration: 1, projection: null })
  useDatabaseStore.getState().setCatalog([database])
  query.host = {
    key: "k",
    kind: "tab",
    databaseId: DB,
    viewId: TABLE_VIEW,
    status: "ready",
    loadedInvalidationSeq: 0,
    rows: [row("n1", "Write report"), row("n2", "Plan trip")],
    projection: null,
    diagnostics: [],
    error: null,
    nextCursor: null,
    totalCount: 2,
  } satisfies DatabaseHostSession
}

const renderWorkspace = (props: Partial<React.ComponentProps<typeof DatabaseWorkspace>> = {}) =>
  render(<DatabaseWorkspace databaseId={DB} title="Tasks" onOpenInNewTab={() => {}} {...props} />)

describe("DatabaseWorkspace", () => {
  beforeEach(setup)
  afterEach(() => {
    cleanup()
    useDatabaseStore.getState().reset(null)
    vi.clearAllMocks()
  })

  it("shows the title, the view tabs and the rows of the table view", async () => {
    renderWorkspace()
    expect(await screen.findByText("Write report")).toBeTruthy()
    expect(screen.getByText("Plan trip")).toBeTruthy()
    expect(
      screen.getByRole("textbox", { name: i18n.t("databaseWorkspace.renameTitle") }),
    ).toBeTruthy()
    expect(screen.getAllByText("All tasks").length).toBeGreaterThan(0)
    expect(screen.getAllByText("By status").length).toBeGreaterThan(0)
  })

  it("renames the database from the title field on Enter", async () => {
    storage.renameDatabase.mockResolvedValue({ title: "Chores", warnings: [] })
    const onRenameTitle = vi.fn()
    renderWorkspace({ onRenameTitle })
    const input = screen.getByRole("textbox", { name: i18n.t("databaseWorkspace.renameTitle") })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "Chores" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(storage.renameDatabase).toHaveBeenCalledWith({
        expectedGeneration: 1,
        databaseId: DB,
        expectedManifestRevision: "manifest-1",
        name: "Chores",
      }),
    )
    await waitFor(() => expect(onRenameTitle).toHaveBeenCalledWith("Chores"))
  })

  it("opens and closes the view settings panel from the toolbar", async () => {
    renderWorkspace()
    await screen.findByText("Write report")
    const toggle = screen.getAllByRole("button", { name: i18n.t("databaseWorkspace.settings") })[0]!
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"))
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"))
  })

  it("creates a page from the new-page dialog", async () => {
    storage.createDatabaseRow.mockResolvedValue({ noteId: "n3", warnings: [] })
    renderWorkspace()
    await screen.findByText("Write report")
    fireEvent.click(screen.getByText(i18n.t("databaseWorkspace.newPage")))
    const titleField = await screen.findByRole("textbox", {
      name: i18n.t("databaseWorkspace.pageTitle"),
    })
    fireEvent.change(titleField, { target: { value: "Buy milk" } })
    fireEvent.keyDown(titleField, { key: "Enter" })
    await waitFor(() =>
      expect(storage.createDatabaseRow).toHaveBeenCalledWith(
        expect.objectContaining({ databaseId: DB, title: "Buy milk" }),
      ),
    )
  })

  it("shows the settings button in the host's slot when the header is hidden", async () => {
    const toolbarHost = document.createElement("div")
    document.body.appendChild(toolbarHost)
    renderWorkspace({ hideHeader: true, toolbarHost })
    await screen.findByText("Write report")
    expect(
      screen.queryByRole("textbox", { name: i18n.t("databaseWorkspace.renameTitle") }),
    ).toBeNull()
    expect(toolbarHost.querySelector("button[aria-pressed]")).not.toBeNull()
    toolbarHost.remove()
  })

  it("says so when the database is missing from a ready catalog", () => {
    useDatabaseStore.getState().setCatalog([])
    renderWorkspace()
    expect(screen.getByText(i18n.t("databaseWorkspace.notFound"))).toBeTruthy()
  })

  describe("a refusal says why in one place (docs/notices.md, section 8)", () => {
    const taken = () => i18n.t("databaseErrors.reason.name_taken")

    async function refusePage() {
      storage.createDatabaseRow.mockRejectedValue(databaseFailure("name_taken"))
      renderWorkspace()
      await screen.findByText("Write report")
      fireEvent.click(screen.getByText(i18n.t("databaseWorkspace.newPage")))
      const field = await screen.findByRole("textbox", {
        name: i18n.t("databaseWorkspace.pageTitle"),
      })
      fireEvent.change(field, { target: { value: "Plan trip" } })
      fireEvent.keyDown(field, { key: "Enter" })
      await waitFor(() => expect(storage.createDatabaseRow).toHaveBeenCalled())
    }

    it("shows a refused page name in the dialog only, not again above the table", async () => {
      await refusePage()
      expect((await screen.findAllByText(taken())).length).toBe(1)
      expect(screen.queryByRole("alert")).toBeNull()
    })

    it("leaves nothing behind when the dialog is cancelled", async () => {
      await refusePage()
      await screen.findByText(taken())
      fireEvent.click(screen.getByRole("button", { name: i18n.t("common.cancel") }))
      await waitFor(() => expect(screen.queryByText(taken())).toBeNull())
    })

    it("keeps a refused database name in the title field with the reason under it", async () => {
      storage.renameDatabase.mockRejectedValue(databaseFailure("name_taken"))
      renderWorkspace()
      const input = screen.getByRole("textbox", { name: i18n.t("databaseWorkspace.renameTitle") })
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: "Chores" } })
      fireEvent.keyDown(input, { key: "Enter" })
      const hint = await screen.findByTestId("rename-hint")
      expect(hint.textContent).toContain(taken())
      expect((input as HTMLInputElement).value).toBe("Chores")
      expect(screen.queryByRole("alert")).toBeNull()
      fireEvent.keyDown(input, { key: "Escape" })
      expect(screen.queryByTestId("rename-hint")).toBeNull()
      expect((input as HTMLInputElement).value).toBe("Tasks")
    })
  })
})
