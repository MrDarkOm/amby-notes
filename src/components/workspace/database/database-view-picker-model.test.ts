import { describe, expect, it } from "vitest"
import type { DatabaseSummary } from "@/lib/storage"
import {
  choiceForOption,
  filterDatabases,
  isBindable,
  viewOptions,
} from "./database-view-picker-model"

const DB = "01J00000000000000000000010"
const VIEW = "01J00000000000000000000011"

const database = (title: string, viewIds: string[]): DatabaseSummary => ({
  databaseId: DB,
  title,
  icon: null,
  attachedNoteId: null,
  manifestRevision: "m",
  locked: false,
  properties: [],
  views: viewIds.map((viewId) => ({
    viewId,
    title: viewId,
    layout: "table",
    revision: "r",
    groupField: null,
  })),
  templates: [],
  diagnostics: [],
})

describe("database view picker model", () => {
  it("filters by title ignoring case and keeps order", () => {
    const all = [database("Tasks", [VIEW]), database("Projects", [VIEW])]
    expect(filterDatabases(all, "  PRO ").map((d) => d.title)).toEqual(["Projects"])
    expect(filterDatabases(all, "")).toBe(all)
  })

  it("offers the saved views, then every layout", () => {
    const options = viewOptions(database("Tasks", [VIEW, "other"]))
    expect(
      options.map((option) => (option.kind === "view" ? option.view.viewId : option.layout)),
    ).toEqual([VIEW, "other", "table", "board", "list", "gallery"])
    expect(isBindable(database("Empty", []))).toBe(false)
  })

  it("binds a saved view as is and a layout on top of the first view", () => {
    const tasks = database("Tasks", [VIEW, "other"])
    const options = viewOptions(tasks)
    expect(choiceForOption(tasks, options[1])).toEqual({ databaseId: DB, viewId: "other" })
    expect(choiceForOption(tasks, options[2])).toEqual({
      databaseId: DB,
      viewId: VIEW,
      layout: "table",
    })
    expect(choiceForOption(tasks, options[3])).toEqual({
      databaseId: DB,
      viewId: VIEW,
      layout: "board",
    })
    const empty = database("Empty", [])
    expect(choiceForOption(empty, viewOptions(empty)[0])).toBeNull()
  })
})
