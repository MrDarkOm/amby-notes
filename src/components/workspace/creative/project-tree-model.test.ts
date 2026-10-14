import { describe, expect, it } from "vitest"
import {
  findStory,
  findWorkshop,
  groupSections,
  listScopes,
  resolveProjectTarget,
  resolveScope,
  sectionName,
} from "./project-tree-model"
import {
  catalog,
  storySummary,
  universeCatalog,
  workshopSection,
  workshopSummary,
} from "./project-fixtures.test-support"

describe("project tree model", () => {
  it("gathers sections under world, work and loose blocks", () => {
    const workshop = universeCatalog().workshops[0]!
    const groups = groupSections(workshop)
    expect(groups.map((group) => [group.id, group.name])).toEqual([
      ["world", "Мир"],
      ["work", "Произведение"],
      ["custom", null],
    ])
    expect(groups[0].sections.map((entry) => entry.id)).toEqual(["characters", "locations"])
    expect(groups[1].sections.map((entry) => entry.id)).toEqual(["stories", "notes", "anchors"])
    expect(groups[2].sections.map((entry) => entry.id)).toEqual(["loose"])
  })

  it("omits empty groups and sends a role it does not know to the loose block", () => {
    const workshop = workshopSummary("w", {
      sections: [
        workshopSection("a", { role: "characters" }),
        workshopSection("b", { role: "somethingNew" as never }),
      ],
    })
    expect(groupSections(workshop).map((group) => group.id)).toEqual(["world", "custom"])
    expect(groupSections(workshopSummary("empty"))).toEqual([])
  })

  it("hands the read-only mark of the workshop to every section and keeps a missing one in", () => {
    const workshop = workshopSummary("w", {
      readOnly: true,
      sections: [
        workshopSection("a", { role: "characters", state: "missing", resolvedPath: null }),
        workshopSection("b", { role: "notes" }),
      ],
    })
    const sections = groupSections(workshop).flatMap((group) => group.sections)
    expect(sections.map((entry) => [entry.id, entry.readOnly, entry.workshopId])).toEqual([
      ["a", true, "w"],
      ["b", true, "w"],
    ])
    expect(sections[0].state).toBe("missing")
  })

  it("names a section by its name, falling back to id", () => {
    expect(sectionName(workshopSection("a", { name: " Имя " }))).toBe("Имя")
    expect(sectionName(workshopSection("a", { name: "" }))).toBe("a")
  })
})

describe("creative scopes", () => {
  it("lists workshops in catalog order", () => {
    const cat = catalog([workshopSummary("first"), workshopSummary("second")])
    expect(listScopes(cat).map((entry) => entry.workshopId)).toEqual(["first", "second"])
  })

  it("resolves a wanted workshop if it exists, otherwise falls back to the first", () => {
    const cat = catalog([workshopSummary("first"), workshopSummary("second")])
    expect(resolveScope(cat, "second")).toBe("second")
    expect(resolveScope(cat, "unknown")).toBe("first")
    expect(resolveScope(cat, null)).toBe("first")
  })

  it("finds workshop and story by id", () => {
    const ws = workshopSummary("w1", {
      stories: [storySummary("s1", { workshopId: "w1", name: "Story 1" })],
    })
    const cat = catalog([ws])
    expect(findWorkshop(cat, "w1")?.name).toBe("w1")
    expect(findStory(cat, "s1")?.story.name).toBe("Story 1")
    expect(findStory(cat, "unknown")).toBeNull()
  })
})

describe("resolving a creative target", () => {
  const cat = catalog([
    workshopSummary("w1", { stories: [storySummary("s1", { workshopId: "w1" })] }),
    workshopSummary("w2"),
  ])

  it("finds a workshop, a story and the universe of a note", () => {
    expect(resolveProjectTarget(cat, "w2")).toMatchObject({ kind: "workshop" })
    expect(resolveProjectTarget(cat, "s1")).toMatchObject({
      kind: "story",
      workshop: { workshopId: "w1" },
    })
    expect(resolveProjectTarget(cat, "universe:note_1")).toMatchObject({
      kind: "universe",
      universeId: "note_1",
    })
  })

  it("is nothing for an unknown id or without a catalog", () => {
    expect(resolveProjectTarget(cat, "unknown")).toBeNull()
    expect(resolveProjectTarget(null, "w1")).toBeNull()
    expect(resolveScope(catalog([]), "w1")).toBeNull()
  })
})
