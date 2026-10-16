import { describe, expect, it } from "vitest"
import type { DatabaseRow, DatabaseSummary } from "@/lib/storage"
import {
  catalog,
  storySummary,
  workshopSection,
  workshopSummary,
} from "../project-fixtures.test-support"
import {
  buildMembership,
  buildSearchGroups,
  entityItemsOf,
  entityTabs,
  groupEntities,
  groupPropertyOf,
  initialsOf,
  orderByAuthor,
  relationTargets,
  relationTargetsOf,
  resolvePanelFilter,
  scopeEntities,
  scopeSections,
  sectionTabKey,
  storiesInScope,
  storyLabels,
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

// ── Belonging ────────────────────────────────────────────────────────────────────────────────

function row(noteId: string, title: string, values: Record<string, unknown> = {}): DatabaseRow {
  return {
    noteId,
    title,
    relativePath: `${noteId}.md`,
    parentNoteId: null,
    depth: 0,
    categoryPath: [],
    valuesJson: JSON.stringify(values),
    rowRevision: `rev-${noteId}`,
  }
}
const rel = (...ids: string[]) => ({ type: "relation", targetNoteIds: ids })

const belonging = {
  stories: [
    storySummary("hills", { name: "Холмы", databaseId: "t_hills" }),
    storySummary("river", { name: "Река", databaseId: "t_river" }),
    storySummary("lone", { name: "Одна", databaseId: "t_lone" }),
  ],
  sections: [
    workshopSection("stories", {
      role: "stories",
      databaseId: "db_stories",
      universePropertyId: "up",
    }),
    workshopSection("universes", { role: "universes", databaseId: "db_univ" }),
    workshopSection("chars", {
      role: "characters",
      databaseId: "db_chars",
      storiesPropertyId: "stp",
    }),
    workshopSection("orgs", { role: "custom", databaseId: "db_orgs", storiesPropertyId: "stp3" }),
  ],
  rows: {
    db_stories: [
      row("note_hills", "Холмы", { up: rel("u1") }),
      row("note_river", "Река", { up: rel("u1") }),
      row("note_lone", "Одна"),
    ],
    db_univ: [row("u1", "Мир"), row("u2", "Пустой")],
    db_chars: [
      row("anna", "Анна", { stp: rel("note_hills") }),
      row("boris", "Борис", { stp: rel("note_river", "note_hills") }),
      row("gleb", "Глеб", { stp: rel("note_lone") }),
      row("zoya", "Зоя"),
      row("eva", "Ева"),
      // A link to a card that is not a story of this workshop counts for nothing.
      row("ghost", "Призрак", { stp: rel("note_gone") }),
    ],
    db_orgs: [row("guild", "Гильдия", { stp3: rel("note_lone") })],
    t_hills: [row("h1", "Глава", { par: rel("h0") })],
    t_river: [row("r1", "Глава", { cast: rel("zoya"), par: rel("r0") })],
    // t_lone is not loaded: its text counts for nothing yet.
  } as Record<string, DatabaseRow[]>,
}

const items = (databaseId: string) => entityItemsOf(belonging.rows[databaseId], databaseId, "w1")
const ids = (list: { noteId: string }[]) => list.map((item) => item.noteId)

describe("relationTargetsOf", () => {
  it("reads one relation property of a row, and nothing else", () => {
    const values = JSON.stringify({ stp: rel("a", "b"), other: rel("c"), n: { type: "number" } })
    expect(relationTargetsOf(values, "stp")).toEqual(["a", "b"])
    expect(relationTargetsOf(values, "n")).toEqual([])
    expect(relationTargetsOf(values, "none")).toEqual([])
    expect(relationTargetsOf("not json", "stp")).toEqual([])
  })
})

describe("buildMembership", () => {
  const membership = buildMembership(belonging)

  it("puts a page in the stories its relation names", () => {
    expect(membership.storiesOf("anna")).toEqual(["hills"])
    expect(membership.storiesOf("guild")).toEqual(["lone"])
  })

  it("puts a page in a story whose own text names it, without any note being written", () => {
    expect(membership.storiesOf("zoya")).toEqual(["river"])
  })

  it("lists both ways of belonging once, in the order of the catalog", () => {
    expect(membership.storiesOf("boris")).toEqual(["hills", "river"])
    const both = buildMembership({
      ...belonging,
      rows: { ...belonging.rows, t_hills: [row("h1", "Глава", { cast: rel("boris", "eva") })] },
    })
    expect(both.storiesOf("boris")).toEqual(["hills", "river"])
    expect(both.storiesOf("eva")).toEqual(["hills"])
  })

  it("leaves a page in no story that no relation and no text names", () => {
    expect(membership.storiesOf("eva")).toEqual([])
    expect(membership.storiesOf("ghost")).toEqual([])
    expect(membership.storiesOf("nobody")).toEqual([])
  })

  it("reads the universe of a story from its card, and a universe is in its stories", () => {
    expect(membership.universeOf("hills")).toBe("u1")
    expect(membership.universeOf("river")).toBe("u1")
    expect(membership.universeOf("lone")).toBeNull()
    expect(membership.storiesOf("u1")).toEqual(["hills", "river"])
    expect(membership.storiesOf("u2")).toEqual([])
  })

  it("knows no universe without the property that names it", () => {
    const old = buildMembership({
      ...belonging,
      sections: belonging.sections.map((section) =>
        section.role === "stories" ? { ...section, universePropertyId: null } : section,
      ),
    })
    expect(old.universeOf("hills")).toBeNull()
  })

  it("does not take a section without the property for linked", () => {
    const old = buildMembership({
      ...belonging,
      sections: belonging.sections.map((section) =>
        section.role === "characters" ? { ...section, storiesPropertyId: null } : section,
      ),
    })
    expect(old.storiesOf("anna")).toEqual([])
    // The text still names Zoya.
    expect(old.storiesOf("zoya")).toEqual(["river"])
  })
})

describe("scopeEntities", () => {
  const membership = buildMembership(belonging)

  it("shows a story's pages: those that name it and those its text names", () => {
    const river = scopeEntities(items("db_chars"), { kind: "story", storyId: "river" }, membership)
    expect(ids(river.shown)).toEqual(["boris", "zoya"])
    expect(river.withoutStory).toEqual([])
    const hills = scopeEntities(items("db_chars"), { kind: "story", storyId: "hills" }, membership)
    expect(ids(hills.shown)).toEqual(["anna", "boris"])
  })

  it("shows a universe's pages through any of its stories, and the universe itself", () => {
    const filter = { kind: "universe", universeId: "u1" } as const
    expect(ids(scopeEntities(items("db_chars"), filter, membership).shown)).toEqual([
      "anna",
      "boris",
      "zoya",
    ])
    // Lone is in no universe, so neither is Gleb or the guild.
    expect(ids(scopeEntities(items("db_orgs"), filter, membership).shown)).toEqual([])
    expect(ids(scopeEntities(items("db_univ"), filter, membership).shown)).toEqual(["u1"])
    const empty = { kind: "universe", universeId: "u2" } as const
    expect(ids(scopeEntities(items("db_univ"), empty, membership).shown)).toEqual(["u2"])
  })

  it("shows the standalone scope: pages of a standalone story, with the pages in no story set apart", () => {
    const standalone = scopeEntities(items("db_chars"), { kind: "standalone" }, membership)
    // Only Gleb is in a story no universe holds; the others are in Hills or River.
    expect(ids(standalone.shown)).toEqual(["gleb"])
    expect(ids(standalone.withoutStory)).toEqual(["eva", "ghost"])
    expect(ids(scopeEntities(items("db_orgs"), { kind: "standalone" }, membership).shown)).toEqual([
      "guild",
    ])
  })

  it("keeps a page of a standalone story and of a universe's in both scopes", () => {
    const both = buildMembership({
      ...belonging,
      rows: { ...belonging.rows, t_lone: [row("l1", "Глава", { cast: rel("anna") })] },
    })
    expect(ids(scopeEntities(items("db_chars"), { kind: "standalone" }, both).shown)).toEqual([
      "anna",
      "gleb",
    ])
    expect(
      ids(scopeEntities(items("db_chars"), { kind: "universe", universeId: "u1" }, both).shown),
    ).toContain("anna")
  })

  it("puts a universe that holds no story into the group of its own, a universe with stories out", () => {
    const standalone = scopeEntities(items("db_univ"), { kind: "standalone" }, membership)
    expect(ids(standalone.shown)).toEqual([])
    expect(ids(standalone.withoutStory)).toEqual(["u2"])
  })
})

describe("resolvePanelFilter", () => {
  const stories = belonging.stories
  // The stories the universe "u1" holds, and the standalone ones, as the card below reads them.
  const inU1 = new Set(["hills", "river"])
  const standalone = new Set(["lone"])

  it("shows the first story of the scope while none was chosen, or the scope when it has none", () => {
    expect(resolvePanelFilter(stories, null, null, standalone)).toEqual({
      kind: "story",
      storyId: "lone",
    })
    expect(resolvePanelFilter(stories, null, "u1", inU1)).toEqual({
      kind: "story",
      storyId: "hills",
    })
    expect(resolvePanelFilter(stories, null, "u2", new Set())).toEqual({
      kind: "universe",
      universeId: "u2",
    })
    expect(resolvePanelFilter(stories, null, null, new Set())).toEqual({ kind: "standalone" })
    expect(resolvePanelFilter([], null, null)).toEqual({ kind: "standalone" })
    // Before the cards are read the first story of the scope is not known: the scope is shown.
    expect(resolvePanelFilter(stories, null, null)).toEqual({ kind: "standalone" })
    expect(resolvePanelFilter(stories, null, "u1")).toEqual({ kind: "universe", universeId: "u1" })
  })

  it("lets a story win over a universe: the universe sets the scope, the story narrows it", () => {
    expect(resolvePanelFilter(stories, "river", "u1", inU1)).toEqual({
      kind: "story",
      storyId: "river",
    })
    // The same before the scope is read.
    expect(resolvePanelFilter(stories, "river", "u1")).toEqual({ kind: "story", storyId: "river" })
  })

  it('shows the whole scope for "all": the universe, or the standalone stories', () => {
    expect(resolvePanelFilter(stories, "all", "u1", inU1)).toEqual({
      kind: "universe",
      universeId: "u1",
    })
    expect(resolvePanelFilter(stories, "all", null, standalone)).toEqual({ kind: "standalone" })
  })

  it("gives way to the scope when the story is outside it", () => {
    expect(resolvePanelFilter(stories, "lone", "u1", inU1)).toEqual({
      kind: "universe",
      universeId: "u1",
    })
    expect(resolvePanelFilter(stories, "river", null, standalone)).toEqual({ kind: "standalone" })
  })

  it("counts a story that is gone as all the stories of the scope, not as the first one", () => {
    expect(resolvePanelFilter(stories, "gone", null, standalone)).toEqual({ kind: "standalone" })
    expect(resolvePanelFilter(stories, "gone", "u1", inU1)).toEqual({
      kind: "universe",
      universeId: "u1",
    })
  })
})

describe("storiesInScope", () => {
  const membership = buildMembership(belonging)
  const names = (list: { storyId: string }[]) => list.map((story) => story.storyId)

  it("lists the standalone stories with no universe chosen", () => {
    expect(names(storiesInScope(belonging.stories, membership, null))).toEqual(["lone"])
  })

  it("lists the stories whose card names the universe, in the order of the catalog", () => {
    expect(names(storiesInScope(belonging.stories, membership, "u1"))).toEqual(["hills", "river"])
    // A universe no story names holds none.
    expect(storiesInScope(belonging.stories, membership, "u2")).toEqual([])
  })

  it("takes every story for a standalone one while the cards say no universe", () => {
    const old = buildMembership({
      ...belonging,
      sections: belonging.sections.map((section) =>
        section.role === "stories" ? { ...section, universePropertyId: null } : section,
      ),
    })
    expect(names(storiesInScope(belonging.stories, old, null))).toEqual(["hills", "river", "lone"])
  })
})

describe("storyLabels", () => {
  const names = new Map([
    ["a", "Холмы"],
    ["b", "Река"],
    ["c", "Лес"],
    ["d", "Дом"],
  ])
  const nameOf = (id: string) => names.get(id)

  it("shows up to two names and counts the rest", () => {
    expect(storyLabels(["a"], nameOf)).toEqual({ names: ["Холмы"], more: 0 })
    expect(storyLabels(["a", "b"], nameOf)).toEqual({ names: ["Холмы", "Река"], more: 0 })
    expect(storyLabels(["a", "b", "c"], nameOf)).toEqual({ names: ["Холмы", "Река"], more: 1 })
    expect(storyLabels(["a", "b", "c", "d"], nameOf)).toEqual({
      names: ["Холмы", "Река"],
      more: 2,
    })
  })

  it("has nothing for no story and skips one the catalog does not know", () => {
    expect(storyLabels([], nameOf)).toEqual({ names: [], more: 0 })
    expect(storyLabels(["x", "a"], nameOf)).toEqual({ names: ["Холмы"], more: 0 })
  })
})

describe("entityTabs and the link property", () => {
  it("carries the section and the property that links it to stories", () => {
    const tabs = entityTabs(
      workshopSummary("w", {
        sections: [
          workshopSection("chars", {
            role: "characters",
            databaseId: "db_c",
            storiesPropertyId: "stp",
          }),
          workshopSection("locs", { role: "locations", databaseId: "db_l" }),
        ],
      }),
    )
    expect(tabs.map((tab) => [tab.sectionId, tab.storiesPropertyId])).toEqual([
      ["chars", "stp"],
      ["locs", null],
    ])
  })
})

describe("scopeSections", () => {
  it("lists the world's categories, then the anchors and the notes", () => {
    expect(scopeSections(ws).map((section) => section.id)).toEqual([
      "chars",
      "locs",
      "orgs",
      "anchors",
      "notes",
    ])
  })

  it("leaves out the stories, the text, the universes and a section whose folder is gone", () => {
    const withMore = workshopSummary("w3", {
      sections: [
        workshopSection("stories", { role: "stories" }),
        workshopSection("text", { role: "text" }),
        workshopSection("universes", { role: "universes" }),
        workshopSection("chars", { role: "characters", state: "missing" }),
        workshopSection("arcs", { role: "arcs" }),
      ],
    })
    expect(scopeSections(withMore).map((section) => section.id)).toEqual(["arcs"])
    expect(scopeSections(null)).toEqual([])
  })
})
