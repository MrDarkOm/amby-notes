import { describe, expect, it } from "vitest"
import type { DatabasePropertySummary, DatabaseSummary } from "@/lib/storage"
import {
  aggregationsFor,
  EMPTY_ROLLUP_DRAFT,
  isDraftComplete,
  nextDraft,
  targetPropertiesFor,
} from "./rollup-model"

const property = (
  propertyId: string,
  propertyType: string,
  configJson = "{}",
): DatabasePropertySummary => ({
  propertyId,
  name: propertyId,
  propertyType,
  configJson,
  options: [],
})

const database = (databaseId: string, properties: DatabasePropertySummary[]): DatabaseSummary => ({
  databaseId,
  title: databaseId,
  icon: null,
  attachedNoteId: null,
  manifestRevision: "r",
  locked: false,
  properties,
  views: [],
  templates: [],
  diagnostics: [],
})

const tasks = database("tasks", [
  property("hours", "number"),
  property("done", "checkbox"),
  property("notes", "text"),
  property("calc", "formula"),
  property("owner", "relation"),
])
const projects = database("projects", [
  property("tasksRel", "relation", JSON.stringify({ targetDatabaseId: "tasks" })),
  property("selfRel", "relation", JSON.stringify({ targetDatabaseId: "projects" })),
  property("progress", "rollup"),
])
const context = { database: projects, databases: [projects, tasks], currentDatabaseId: "projects" }

describe("rollup wizard model", () => {
  it("offers only the aggregations that suit a field kind", () => {
    expect(aggregationsFor("number")).toContain("sum")
    expect(aggregationsFor("checkbox")).toEqual(["count", "percentChecked"])
    expect(aggregationsFor("formula")).toEqual([])
  })

  it("lists summarizable fields of the related database, never computed ones or itself", () => {
    const relation = projects.properties[0]
    expect(
      targetPropertiesFor(relation, [projects, tasks], "projects").map((p) => p.propertyId),
    ).toEqual(["hours", "done", "notes", "owner"])
    const self = projects.properties[1]
    expect(
      targetPropertiesFor(self, [projects, tasks], "projects", "progress").map((p) => p.propertyId),
    ).toEqual(["tasksRel", "selfRel"])
    expect(targetPropertiesFor(undefined, [projects, tasks], "projects")).toEqual([])
  })

  it("clears later choices when an earlier one no longer fits", () => {
    let draft = nextDraft(EMPTY_ROLLUP_DRAFT, { relationId: "tasksRel" }, context)
    draft = nextDraft(draft, { targetId: "done" }, context)
    draft = nextDraft(draft, { aggregation: "percentChecked" }, context)
    expect(isDraftComplete(draft)).toBe(true)
    // Another target field: the share of checked boxes makes no sense for hours.
    draft = nextDraft(draft, { targetId: "hours" }, context)
    expect(draft).toEqual({ relationId: "tasksRel", targetId: "hours", aggregation: "" })
    // Another relation: the field belonged to the old one.
    draft = nextDraft(
      { relationId: "tasksRel", targetId: "hours", aggregation: "sum" },
      { relationId: "selfRel" },
      context,
    )
    expect(draft).toEqual({ relationId: "selfRel", targetId: "", aggregation: "" })
  })
})
