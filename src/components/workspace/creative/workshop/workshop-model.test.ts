import { describe, expect, it } from "vitest"
import type { DatabaseSummary } from "@/lib/storage"
import {
  catalog,
  storySummary,
  workshopSection,
  workshopSummary,
} from "../project-fixtures.test-support"
import {
  buildSearchGroups,
  entityTabs,
  groupEntities,
  groupPropertyOf,
  initialsOf,
  orderByAuthor,
  relationTargets,
  sectionTabKey,
  workshopScope,
  worksSectionsFromPrefs,
  type EntityItem,
} from "./workshop-model"

const ws = workshopSummary("w1", {
  name: "Verse",
  sections: [
    workshopSection("stories", { role: "stories", name: "Истории", databaseId: "db_stories" }),
    workshopSection("chars", { role: "characters", name: "Персонажи", databaseId: "db_uc" }),
    workshopSection("locs", { role: "locations", name: "Локации", databaseId: "db_ul" }),
    workshopSection("orgs", { role: "custom", name: "Организации", databaseId: "db_uo" }),
    workshopSection("notes", { role: "notes", name: "Заметки", databaseId: "db_un" }),
    workshopSection("anchors", { role: "anchors", name: "Якоря", databaseId: "db_ua" }),
  ],
  stories: [
    storySummary("a", { workshopId: "w1", name: "Story A" }),
    storySummary("b", { workshopId: "w1", name: "Story B" }),
  ],
})
const ws2 = workshopSummary("w2", {
  name: "Second",
  stories: [storySummary("c", { workshopId: "w2", name: "Story C" })],
})
const cat = catalog([ws, ws2])

describe("workshopScope", () => {
  it("holds a workshop and its stories", () => {
    const scope1 = workshopScope(cat, "w1")
    expect(scope1.workshop?.workshopId).toBe("w1")
    expect(scope1.stories.map((s) => s.storyId)).toEqual(["a", "b"])

    const scope2 = workshopScope(cat, "w2")
    expect(scope2.workshop?.workshopId).toBe("w2")
    expect(scope2.stories.map((s) => s.storyId)).toEqual(["c"])

    const fallback = workshopScope(cat, null)
    expect(fallback.workshop?.workshopId).toBe("w1")
  })
})

describe("entityTabs", () => {
  it("extracts world categories from workshop sections and orders them", () => {
    const tabs = entityTabs(ws)
    expect(tabs.map((t) => t.key)).toEqual(["characters", "locations", "name:организации"])
    expect(tabs.map((t) => t.databaseId)).toEqual(["db_uc", "db_ul", "db_uo"])
  })

  it("leaves stories, text, notes, and anchors out of world entity tabs and skips missing sections", () => {
    const withMissing = workshopSummary("wm", {
      sections: [
        workshopSection("stories", { role: "stories" }),
        workshopSection("notes", { role: "notes" }),
        workshopSection("anchors", { role: "anchors" }),
        workshopSection("m", { role: "locations", state: "missing" }),
      ],
    })
    const tabs = entityTabs(withMissing)
    expect(tabs).toEqual([])
  })

  it("puts characters and locations first whatever the order in sections", () => {
    const odd = workshopSummary("s", {
      sections: [
        workshopSection("o", { role: "custom", name: "Предметы" }),
        workshopSection("l", { role: "locations", name: "Локации" }),
        workshopSection("c", { role: "characters", name: "Персонажи" }),
      ],
    })
    const keys = entityTabs(odd).map((t) => t.key)
    expect(keys).toEqual(["characters", "locations", "name:предметы"])
  })

  it("keys a custom section by its name", () => {
    expect(sectionTabKey(workshopSection("x", { role: "custom", name: "  Артефакты " }))).toBe(
      "name:артефакты",
    )
  })
})

describe("groupEntities", () => {
  const options = [
    { optionId: "o1", name: "Главные", color: "red" },
    { optionId: "o2", name: "Второстепенные", color: "blue" },
  ]
  const summary = {
    databaseId: "db",
    properties: [
      { propertyId: "imp", name: "Значимость", propertyType: "select", configJson: "{}", options },
    ],
    views: [
      {
        viewId: "v",
        title: "g",
        layout: "gallery",
        revision: "r",
        groupField: { kind: "property", propertyId: "imp" },
      },
    ],
  } as unknown as DatabaseSummary
  const entity = (noteId: string, option: string | null, workshopId = "w1"): EntityItem => ({
    noteId,
    title: noteId,
    databaseId: "db",
    workshopId,
    valuesJson: option ? JSON.stringify({ imp: { type: "select", optionId: option } }) : "{}",
  })
  const context = {
    groupProperty: (id: string) => groupPropertyOf(id === "db" ? summary : undefined),
    sharedLabel: "Общие",
    noValueLabel: "Без значимости",
  }

  it("groups by the importance option in the option order and sorts by name", () => {
    const groups = groupEntities(
      [entity("Зоя", "o2"), entity("Борис", "o1"), entity("Анна", "o1"), entity("Яна", null)],
      "importance",
      context,
    )
    expect(groups.map((g) => [g.label, g.items.map((i) => i.title)])).toEqual([
      ["Главные", ["Анна", "Борис"]],
      ["Второстепенные", ["Зоя"]],
      ["Без значимости", ["Яна"]],
    ])
  })

  it("shows one plain list when nothing carries an importance", () => {
    const groups = groupEntities([entity("Б", null), entity("А", null)], "importance", context)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBeNull()
    expect(groups[0].items.map((i) => i.title)).toEqual(["А", "Б"])
  })

  it("returns nothing for an empty list", () => {
    expect(groupEntities([], "importance", context)).toEqual([])
  })
})

describe("relationTargets", () => {
  it("collects the targets of every relation value", () => {
    const json = JSON.stringify({
      a: { type: "relation", targetNoteIds: ["n1", "n2"] },
      b: { type: "text", value: "x" },
      c: { type: "relation", targetNoteIds: ["n3"] },
    })
    expect(relationTargets(json)).toEqual(["n1", "n2", "n3"])
    expect(relationTargets("not json")).toEqual([])
  })
})

describe("buildSearchGroups", () => {
  const item = (noteId: string, title: string): EntityItem => ({
    noteId,
    title,
    databaseId: "db",
    workshopId: "w1",
    valuesJson: "{}",
  })
  const sources = [
    { key: "works", label: "Произведения", items: [item("p", "Борьба"), item("q", "Утро")] },
    { key: "characters", label: "Персонажи", items: [item("b", "Борис"), item("a", "Анна")] },
    { key: "locations", label: "Локации", items: [item("l", "Лес")] },
  ]

  it("keeps matches under their tab, sorted by name, and drops empty groups", () => {
    const groups = buildSearchGroups("  БОР ", sources)
    expect(groups.map((g) => [g.key, g.items.map((i) => i.title)])).toEqual([
      ["works", ["Борьба"]],
      ["characters", ["Борис"]],
    ])
  })

  it("finds nothing for an empty query", () => {
    expect(buildSearchGroups("   ", sources)).toEqual([])
  })
})

describe("worksSectionsFromPrefs", () => {
  it("unfolds the text when nothing was saved or the save is not a list", () => {
    expect(worksSectionsFromPrefs(undefined)).toEqual(["text"])
    expect(worksSectionsFromPrefs("books")).toEqual(["text"])
  })

  it("reads the old books and arcs parts as the text, once", () => {
    expect(worksSectionsFromPrefs(["books"])).toEqual(["text"])
    expect(worksSectionsFromPrefs(["arcs", "notes"])).toEqual(["text", "notes"])
    expect(worksSectionsFromPrefs(["books", "arcs", "anchors"])).toEqual(["text", "anchors"])
  })

  it("keeps what the author folded and drops what it does not know", () => {
    expect(worksSectionsFromPrefs([])).toEqual([])
    expect(worksSectionsFromPrefs(["notes", "nonsense", 3, "text"])).toEqual(["notes", "text"])
  })
})

describe("orderByAuthor", () => {
  const rows = [
    { noteId: "late", title: "Поздний" },
    { noteId: "early", title: "Ранний" },
    { noteId: "pinned", title: "Закреплённый" },
    { noteId: "unknown", title: "Без времени" },
    { noteId: "twin", title: "Близнец" },
  ]
  const made: Record<string, number> = { late: 300, early: 100, pinned: 500, twin: 100 }

  it("puts what the author placed first, in their order, then the rest as they were made", () => {
    const ordered = orderByAuthor(rows, ["pinned", "late"], (id) => made[id])
    expect(ordered.map((row) => row.noteId)).toEqual(["pinned", "late", "twin", "early", "unknown"])
  })

  it("is the order they were made when nothing was placed, and leaves its input alone", () => {
    const input = [...rows]
    const ordered = orderByAuthor(input, [], (id) => made[id])
    expect(ordered.map((row) => row.noteId)).toEqual(["twin", "early", "late", "pinned", "unknown"])
    expect(input).toEqual(rows)
  })

  it("ignores placed IDs that are no longer there", () => {
    expect(orderByAuthor(rows, ["gone", "late"], (id) => made[id])[0].noteId).toBe("late")
  })
})

describe("initialsOf", () => {
  it("takes the first letter of the first two words, upper case", () => {
    expect(initialsOf("Борис")).toBe("Б")
    expect(initialsOf("зоя белая")).toBe("ЗБ")
    expect(initialsOf("Анна Мария фон Берг")).toBe("АМ")
  })

  it("skips leading marks and whole symbols, and has a fallback for nothing", () => {
    expect(initialsOf("«Тихий» порт")).toBe("ТП")
    expect(initialsOf("  ")).toBe("?")
    expect(initialsOf("***")).toBe("?")
  })
})
