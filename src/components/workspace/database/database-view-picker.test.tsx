// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabaseSummary } from "@/lib/storage"
import { useDatabaseStore } from "./database-store"
import { DatabaseViewPicker } from "./database-view-picker"

const view = (viewId: string, title: string, layout = "table") => ({
  viewId,
  title,
  layout,
  revision: "r",
  groupField: null,
})
const database = (databaseId: string, title: string, views: DatabaseSummary["views"]) =>
  ({
    databaseId,
    title,
    icon: null,
    attachedNoteId: null,
    manifestRevision: "m",
    locked: false,
    properties: [],
    views,
    templates: [],
    diagnostics: [],
  }) satisfies DatabaseSummary

const TASKS = "01J00000000000000000000010"
const PROJECTS = "01J00000000000000000000050"

function setup(databases: DatabaseSummary[]) {
  useDatabaseStore.getState().reset(1)
  useDatabaseStore.getState().setRuntime({ enabled: true, vaultGeneration: 1, projection: null })
  useDatabaseStore.getState().setCatalog(databases)
}

describe("DatabaseViewPicker", () => {
  afterEach(() => {
    cleanup()
    useDatabaseStore.getState().reset(null)
  })

  it("always asks how to show the database, even with a single view", () => {
    setup([database(TASKS, "Tasks", [view("01J00000000000000000000011", "All")])])
    const onSelect = vi.fn()
    render(<DatabaseViewPicker onSelect={onSelect} />)
    fireEvent.click(screen.getByRole("option", { name: /Tasks/ }))
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("option", { name: /^All/ }))
    expect(onSelect).toHaveBeenCalledWith({
      databaseId: TASKS,
      viewId: "01J00000000000000000000011",
    })
  })

  it("shows a database as a plain layout on top of its first view, and goes back", () => {
    setup([
      database(PROJECTS, "Projects", [
        view("01J00000000000000000000051", "Table"),
        view("01J00000000000000000000052", "Roadmap", "board"),
      ]),
    ])
    const onSelect = vi.fn()
    render(<DatabaseViewPicker onSelect={onSelect} />)
    fireEvent.click(screen.getByRole("option", { name: /Projects/ }))
    fireEvent.click(screen.getByRole("option", { name: "Галерея" }))
    expect(onSelect).toHaveBeenCalledWith({
      databaseId: PROJECTS,
      viewId: "01J00000000000000000000051",
      layout: "gallery",
    })
    fireEvent.click(screen.getByRole("button", { name: "К списку баз" }))
    expect(screen.getByRole("option", { name: /Projects/ })).toBeTruthy()
  })

  it("filters by search, selects with the keyboard and skips databases without views", () => {
    setup([
      database(TASKS, "Tasks", [view("01J00000000000000000000011", "All")]),
      database(PROJECTS, "Projects", []),
    ])
    const onSelect = vi.fn()
    render(<DatabaseViewPicker onSelect={onSelect} />)
    fireEvent.click(screen.getByRole("option", { name: /Projects/ }))
    expect(screen.queryByRole("option", { name: "Галерея" })).toBeNull()
    const search = screen.getByRole("textbox")
    fireEvent.change(search, { target: { value: "task" } })
    expect(screen.queryByRole("option", { name: /Projects/ })).toBeNull()
    fireEvent.keyDown(search, { key: "Enter" })
    // Enter on the database opens its choices; Enter again picks the first view.
    const list = screen.getByRole("listbox")
    fireEvent.keyDown(list, { key: "Enter" })
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("says so when the module is off", () => {
    useDatabaseStore.getState().reset(1)
    render(<DatabaseViewPicker onSelect={vi.fn()} />)
    expect(screen.getByText("Модуль баз данных выключен")).toBeTruthy()
  })
})
