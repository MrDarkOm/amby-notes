import { describe, expect, it } from "vitest"
import {
  findStory,
  findWorkshop,
  groupSections,
  projectTargetTitle,
  resolveProjectTarget,
  sectionName,
  standaloneTargetId,
  universeTargetId,
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
    expect(groups.map((group) => group.id)).toEqual(["world", "work", "custom"])
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

describe("finding projects", () => {
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

  it("finds the standalone stories of a workshop by its id", () => {
    expect(resolveProjectTarget(cat, "standalone:w2")).toMatchObject({
      kind: "standalone",
      workshop: { workshopId: "w2" },
    })
    expect(resolveProjectTarget(cat, standaloneTargetId("w1"))).toMatchObject({
      kind: "standalone",
    })
    expect(resolveProjectTarget(cat, universeTargetId("note_1"))).toMatchObject({
      kind: "universe",
      universeId: "note_1",
    })
  })

  it("is nothing for the standalone stories of a workshop that is not there", () => {
    expect(resolveProjectTarget(cat, "standalone:ghost")).toBeNull()
    expect(resolveProjectTarget(catalog([]), "universe:note_1")).toBeNull()
  })

  it("is nothing for an unknown id or without a catalog", () => {
    expect(resolveProjectTarget(cat, "unknown")).toBeNull()
    expect(resolveProjectTarget(null, "w1")).toBeNull()
  })
})

describe("naming a page and its tab", () => {
  const labels = { universe: "Вселенная", standalone: "Отдельные истории", fallback: "Мастерская" }
  const cat = catalog([
    workshopSummary("w1", {
      name: "Verse",
      stories: [storySummary("s1", { workshopId: "w1", name: "MoleHills" })],
    }),
  ])

  it("names a story, the workshop and the standalone stories", () => {
    expect(projectTargetTitle(resolveProjectTarget(cat, "s1"), labels)).toBe("MoleHills")
    expect(projectTargetTitle(resolveProjectTarget(cat, "w1"), labels)).toBe("Verse")
    expect(projectTargetTitle(resolveProjectTarget(cat, "standalone:w1"), labels)).toBe(
      "Отдельные истории",
    )
    expect(projectTargetTitle(null, labels)).toBe("Мастерская")
  })

  it("names a universe by the title of its row, and by the common word until it is read", () => {
    const target = resolveProjectTarget(cat, "universe:u1")
    expect(projectTargetTitle(target, labels, " Палуверс ")).toBe("Палуверс")
    expect(projectTargetTitle(target, labels, undefined)).toBe("Вселенная")
    expect(projectTargetTitle(target, labels, "  ")).toBe("Вселенная")
  })
})
