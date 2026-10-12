import { describe, expect, it } from "vitest"
import type { DatabaseSummary } from "@/lib/storage"
import { catalog, project, section } from "../project-fixtures.test-support"
import {
  buildSearchGroups,
  defaultSource,
  entityTabs,
  groupEntities,
  groupPropertyOf,
  initialsOf,
  inStory,
  isUnplaced,
  orderByAuthor,
  relationTargets,
  sectionTabKey,
  storiesOfEntity,
  workshopScope,
  worksSectionsFromPrefs,
  type EntityItem,
} from "./workshop-model"

const universe = project("pv", {
  kind: "collection",
  name: "Verse",
  sections: [
    section("chars", { role: "characters", databaseName: "Персонажи", databaseId: "db_uc" }),
    section("orgs", { role: null, databaseName: "Организации", databaseId: "db_uo" }),
  ],
})
const story = (id: string, extra = {}) =>
  project(id, {
    collectionId: "pv",
    name: id,
    sections: [
      section(`${id}-text`, { role: "text", databaseId: `db_${id}_t` }),
      section(`${id}-notes`, { role: "notes", databaseId: `db_${id}_n` }),
      section(`${id}-chars`, {
        role: "characters",
        databaseName: "Персонажи",
        databaseId: `db_${id}_c`,
      }),
      section(`${id}-orgs`, { role: null, databaseName: "организации", databaseId: `db_${id}_o` }),
    ],
    ...extra,
  })
const cat = catalog([universe, story("a"), story("b"), project("tale", { name: "Рассказ" })])

describe("workshopScope", () => {
  it("holds a collection and its stories, or the stand-alone stories", () => {
    const inside = workshopScope(cat, "pv")
    expect(inside.collection?.projectId).toBe("pv")
    expect(inside.stories.map((s) => s.projectId)).toEqual(["a", "b"])
    const alone = workshopScope(cat, null)
    expect(alone.collection).toBeNull()
    expect(alone.stories.map((s) => s.projectId)).toEqual(["tale"])
  })
})

describe("entityTabs", () => {
  it("merges the same role and the same custom name across the collection and its stories", () => {
    const tabs = entityTabs(workshopScope(cat, "pv"))
    expect(tabs.map((t) => t.key)).toEqual(["characters", "name:организации"])
    expect(tabs[0].sources.map((s) => s.project.projectId)).toEqual(["pv", "a", "b"])
    expect(tabs[1].sources.map((s) => s.section.databaseId)).toEqual(["db_uo", "db_a_o", "db_b_o"])
  })

  it("leaves the text and the notes to the works tab and skips missing sections", () => {
    const withMissing = story("c", {
      sections: [
        section("t", { role: "text" }),
        section("m", { role: "locations", state: "missing", databaseName: null }),
      ],
    })
    const tabs = entityTabs(workshopScope(catalog([withMissing]), null))
    expect(tabs).toEqual([])
  })

  it("puts characters and locations first whatever the order in the files", () => {
    const odd = project("s", {
      sections: [
        section("o", { role: null, databaseName: "Предметы" }),
        section("l", { role: "locations" }),
        section("c", { role: "characters" }),
      ],
    })
    const keys = entityTabs(workshopScope(catalog([odd]), null)).map((t) => t.key)
    expect(keys).toEqual(["characters", "locations", "name:предметы"])
  })

  it("keys a custom section by its name", () => {
    expect(sectionTabKey(section("x", { role: null, databaseName: "  Артефакты " }))).toBe(
      "name:артефакты",
    )
  })
})

describe("story membership", () => {
  const item = (noteId: string, projectId: string): EntityItem => ({
    noteId,
    title: noteId,
    databaseId: "db",
    projectId,
    valuesJson: "{}",
  })
  const refs = new Map([["b", new Set(["shared"])]])
  const stories = [story("a"), story("b")]

  it("counts an entity that lives in the story and one the story's text names", () => {
    expect(inStory(item("own", "a"), "a", refs)).toBe(true)
    expect(inStory(item("shared", "pv"), "b", refs)).toBe(true)
    expect(inStory(item("shared", "pv"), "a", refs)).toBe(false)
  })

  it("lists every story an entity belongs to", () => {
    expect(storiesOfEntity(item("shared", "pv"), stories, refs).map((s) => s.projectId)).toEqual([
      "b",
    ])
    expect(storiesOfEntity(item("own", "a"), stories, refs).map((s) => s.projectId)).toEqual(["a"])
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
  const entity = (noteId: string, option: string | null, projectId = "pv"): EntityItem => ({
    noteId,
    title: noteId,
    databaseId: "db",
    projectId,
    valuesJson: option ? JSON.stringify({ imp: { type: "select", optionId: option } }) : "{}",
  })
  const context = {
    groupProperty: (id: string) => groupPropertyOf(id === "db" ? summary : undefined),
    projectName: (id: string) => (id === "pv" ? "Verse" : id),
    sharedLabel: "Общие",
    noValueLabel: "Без значимости",
    projectOrder: ["pv", "a", "b"],
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

  it("groups by story with the shared pages first", () => {
    const groups = groupEntities(
      [entity("x", null, "b"), entity("y", null, "pv"), entity("z", null, "a")],
      "story",
      context,
    )
    expect(groups.map((g) => g.label)).toEqual(["Verse", "a", "b"])
  })

  it("returns nothing for an empty list", () => {
    expect(groupEntities([], "importance", context)).toEqual([])
  })
})

describe("relationTargets and defaultSource", () => {
  it("collects the targets of every relation value", () => {
    const json = JSON.stringify({
      a: { type: "relation", targetNoteIds: ["n1", "n2"] },
      b: { type: "text", value: "x" },
      c: { type: "relation", targetNoteIds: ["n3"] },
    })
    expect(relationTargets(json)).toEqual(["n1", "n2", "n3"])
    expect(relationTargets("not json")).toEqual([])
  })

  it("prefers the filtered story's section, then the shared one, then the first", () => {
    const [tab] = entityTabs(workshopScope(cat, "pv"))
    expect(defaultSource(tab, "b", "pv")?.project.projectId).toBe("b")
    expect(defaultSource(tab, null, "pv")?.project.projectId).toBe("pv")
    expect(defaultSource(tab, "zzz", null)?.project.projectId).toBe("pv")
  })
})

describe("buildSearchGroups", () => {
  const item = (noteId: string, title: string): EntityItem => ({
    noteId,
    title,
    databaseId: "db",
    projectId: "pv",
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

describe("isUnplaced", () => {
  const item = (noteId: string, projectId: string): EntityItem => ({
    noteId,
    title: noteId,
    databaseId: "db",
    projectId,
    valuesJson: "{}",
  })
  const references = new Map([
    ["s1", new Set(["named"])],
    ["s2", new Set<string>()],
  ])

  it("is a page of the shared section that no story's text names", () => {
    expect(isUnplaced(item("fresh", "pv"), "pv", references)).toBe(true)
  })

  it("is not a page some story names, even another story", () => {
    expect(isUnplaced(item("named", "pv"), "pv", references)).toBe(false)
  })

  it("is not a page of a story's own section, nor anything without a shared world", () => {
    expect(isUnplaced(item("own", "s1"), "pv", references)).toBe(false)
    expect(isUnplaced(item("fresh", "pv"), null, references)).toBe(false)
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
    expect(ordered.map((row) => row.noteId)).toEqual([
      "pinned",
      "late",
      // Made at the same moment: by title.
      "twin",
      "early",
      "unknown",
    ])
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
