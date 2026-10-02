import { describe, expect, it } from "vitest"
import type { DatabasePropertySummary } from "@/lib/storage"
import {
  combineFilters,
  currentPageFilter,
  currentPageRelations,
  hasOtherConditions,
  pageRelationCandidates,
} from "./embedded-view-model"

const status = {
  kind: "condition",
  field: { kind: "property", propertyId: "s" },
  operator: "equals",
  value: "todo",
}

describe("embedded view model", () => {
  it("requires both the shared view's and the embedding's own filter", () => {
    expect(combineFilters(null, null)).toBeNull()
    expect(combineFilters(status, null)).toEqual(status)
    expect(combineFilters(null, status)).toEqual(status)
    expect(combineFilters(status, currentPageFilter("p"))).toMatchObject({
      kind: "group",
      operator: "and",
      children: [status, currentPageFilter("p")],
    })
    expect(combineFilters(null, "junk")).toBeNull()
  })

  it("finds the relations tied to the current page, also next to other conditions", () => {
    expect(currentPageRelations(currentPageFilter("p"))).toEqual(["p"])
    const both = combineFilters(status, currentPageFilter("p"))
    expect(currentPageRelations(both)).toEqual(["p"])
    expect(currentPageRelations(status)).toEqual([])
    expect(currentPageRelations(null)).toEqual([])
  })

  it("says when another condition may hide a new record", () => {
    expect(hasOtherConditions(currentPageFilter("p"))).toBe(false)
    expect(hasOtherConditions(null)).toBe(false)
    expect(hasOtherConditions(combineFilters(status, currentPageFilter("p")))).toBe(true)
    expect(hasOtherConditions({ kind: "group", operator: "or", children: [] })).toBe(true)
  })

  it("offers only relations that point at the page's own database", () => {
    const relation = (propertyId: string, target: string): DatabasePropertySummary => ({
      propertyId,
      name: propertyId,
      propertyType: "relation",
      configJson: JSON.stringify({ targetDatabaseId: target }),
      options: [],
    })
    const properties = [
      relation("project", "projects"),
      relation("client", "clients"),
      { propertyId: "t", name: "t", propertyType: "text", configJson: "{}", options: [] },
    ]
    expect(
      pageRelationCandidates(properties, "projects", "tasks").map((p) => p.propertyId),
    ).toEqual(["project"])
    expect(pageRelationCandidates(properties, null, "tasks")).toEqual([])
  })
})
