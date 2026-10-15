import { describe, expect, it } from "vitest"
import type { DatabaseRow, NotebookCatalog, NoteReference, WorkshopSummary } from "@/lib/storage"
import fixture from "./real-workshop.fixture.json"
import { buildNotebookTree, noteItemsOf, planNotebookDelete, type NoteItem } from "./notebook-model"
import { orderStoryAnchors, pageMarks, pagesOf, readBindings } from "./plot-model"
import {
  arcAnchors,
  arcChapters,
  bucketAnchors,
  characterArcs,
  pageNeighbours,
  universeEvents,
  type StoryPlotText,
} from "./plot-views"
import { buildTextTree, textOrder } from "./text-tree-model"
import {
  buildMembership,
  entityItemsOf,
  entityTabs,
  relationTargetsOf,
  scopeEntities,
  storyLabels,
  type PanelFilter,
} from "./workshop-model"

/**
 * The workshop in `real-workshop.fixture.json` was built by the real Rust write path and read back
 * through the real index and query (`src-tauri/src/project/contract_test.rs` keeps the file equal
 * to that output). Nothing here is a mock: these are the keys and shapes the backend really sends,
 * so a rename on either side fails one of the two tests.
 */
const workshop = fixture.workshop as unknown as WorkshopSummary
const rows: Record<string, DatabaseRow[]> = Object.fromEntries(
  Object.entries(fixture.rows).map(([databaseId, list]) => [
    databaseId,
    list.map((entry) => ({
      noteId: entry.noteId,
      title: entry.title,
      relativePath: entry.relativePath,
      parentNoteId: null,
      depth: 0,
      categoryPath: entry.categoryPath,
      valuesJson: JSON.stringify(entry.values),
      rowRevision: "r",
    })),
  ]),
)

const membership = buildMembership({
  stories: workshop.stories,
  sections: workshop.sections,
  rows,
})
const storyName = new Map(workshop.stories.map((story) => [story.storyId, story.name]))

function titlesIn(databaseId: string, filter: PanelFilter) {
  const items = entityItemsOf(rows[databaseId], databaseId, workshop.workshopId)
  const { shown, withoutStory } = scopeEntities(items, filter, membership)
  return { shown: shown.map((item) => item.title), without: withoutStory.map((i) => i.title) }
}
const storyIdOf = (name: string) => workshop.stories.find((story) => story.name === name)!.storyId

describe("the real workshop from the backend", () => {
  it("names the link properties on the sections, and the card of every story", () => {
    const tabs = entityTabs(workshop)
    expect(tabs.map((tab) => [tab.role, tab.storiesPropertyId !== null])).toEqual([
      ["characters", true],
      ["locations", true],
      ["universes", false],
      ["arcs", true],
    ])
    const stories = workshop.sections.find((section) => section.role === "stories")
    expect(stories?.universePropertyId).toBeTruthy()
    expect(stories?.storiesPropertyId).toBeNull()
    for (const story of workshop.stories) {
      expect(story.cardNoteId).toBeTruthy()
      expect(story.databaseId).toBeTruthy()
    }
  })

  it("reads who is in which story from the relations and from the text", () => {
    const characters = "ID:db:characters"
    expect(titlesIn(characters, { kind: "story", storyId: storyIdOf("Дом") }).shown).toEqual([
      "Анна",
      "Борис",
    ])
    // Zoya has no relation of her own: the text of "Лес" names her.
    expect(titlesIn(characters, { kind: "story", storyId: storyIdOf("Лес") }).shown).toEqual([
      "Борис",
      "Вера",
      "Зоя",
    ])
    expect(titlesIn(characters, { kind: "story", storyId: storyIdOf("Одна") }).shown).toEqual([
      "Глеб",
    ])
    expect(titlesIn("ID:db:locations", { kind: "story", storyId: storyIdOf("Дом") }).shown).toEqual(
      ["Озеро"],
    )
  })

  it("reads the universe of a story from its card", () => {
    expect(membership.universeOf(storyIdOf("Дом"))).toBe("ID:note:Мир")
    expect(membership.universeOf(storyIdOf("Лес"))).toBe("ID:note:Мир")
    expect(membership.universeOf(storyIdOf("Одна"))).toBeNull()
    const universe: PanelFilter = { kind: "universe", universeId: "ID:note:Мир" }
    expect(titlesIn("ID:db:characters", universe).shown).toEqual(["Анна", "Борис", "Вера", "Зоя"])
    expect(titlesIn("ID:db:locations", universe).shown).toEqual(["Озеро"])
    expect(titlesIn("ID:db:universes", universe).shown).toEqual(["Мир"])
  })

  it("shows the standalone stories' pages, sets apart those in no story, and labels the rest", () => {
    const standalone = titlesIn("ID:db:characters", { kind: "standalone" })
    // Of the characters only Gleb is in a story no universe holds; Eva is in none.
    expect(standalone.shown).toEqual(["Глеб"])
    expect(standalone.without).toEqual(["Ева"])
    const boris = storyLabels(membership.storiesOf("ID:note:Борис"), (id) => storyName.get(id))
    expect(boris).toEqual({ names: ["Дом", "Лес"], more: 0 })
    // The universe is in its stories, which no standalone scope holds.
    const universes = titlesIn("ID:db:universes", { kind: "standalone" })
    expect([...universes.shown, ...universes.without]).toEqual([])
  })

  it("groups the notes of the real notes base by notebook, under the filter, with the empty notebook listed", () => {
    const listing = (fixture.notebooks as unknown as Record<string, NotebookCatalog>)["ID:db:notes"]
    const items = noteItemsOf(rows["ID:db:notes"], "ID:db:notes", workshop.workshopId)
    const section = workshop.sections.find((entry) => entry.role === "notes")!
    expect(section.storiesPropertyId).toBeTruthy()
    // The folders on disk are named the way the rows' category paths are.
    expect(listing.notebooks.map((entry) => entry.segments)).toEqual([
      ["Идеи"],
      ["Идеи", "Сюжеты"],
      ["Пустой"],
    ])
    expect(listing.containerPath.startsWith("VAULT/")).toBe(true)

    const house = scopeEntities(items, { kind: "story", storyId: storyIdOf("Дом") }, membership)
    const tree = buildNotebookTree(listing.notebooks, house.shown, { showEmpty: true })
    expect(tree.nodes.map((node) => [node.name, node.count])).toEqual([
      ["Идеи", 1],
      ["Пустой", 0],
    ])
    expect(tree.nodes[0].notes.map((note) => note.title)).toEqual(["Заготовка"])
    expect(tree.nodes[0].children[0].count).toBe(0)
    expect(tree.rootNotes.map((note) => note.title)).toEqual(["Корневая"])

    const wood = scopeEntities(items, { kind: "story", storyId: storyIdOf("Лес") }, membership)
    expect(wood.shown.map((note) => note.title)).toEqual(["Поворот"])

    // The standalone scope: the note in no story is set apart, and stays in its notebook.
    const all = scopeEntities(items, { kind: "standalone" }, membership)
    expect(all.withoutStory.map((note) => note.title)).toEqual(["Ничья"])
    const apart = buildNotebookTree(listing.notebooks, all.withoutStory, { showEmpty: false })
    expect(apart.nodes.map((node) => node.name)).toEqual(["Идеи"])
  })

  it("plans the deletion of a real notebook from what the disk and the rows really say", () => {
    const listing = (fixture.notebooks as unknown as Record<string, NotebookCatalog>)["ID:db:notes"]
    const items: NoteItem[] = noteItemsOf(rows["ID:db:notes"], "ID:db:notes", workshop.workshopId)
    // "Идеи" holds two notes and "Сюжеты" one: the counts of the disk equal the rows, so the
    // notebook holds nothing but notes and all three go up into the root.
    const plan = planNotebookDelete(["Идеи"], listing.notebooks, items, true, true)
    expect(plan.kind).toBe("ready")
    if (plan.kind === "ready") {
      expect(plan.moves.map((move) => move.title).sort()).toEqual(["Заготовка", "Ничья", "Поворот"])
    }
    expect(planNotebookDelete(["Пустой"], listing.notebooks, items, true, true)).toMatchObject({
      kind: "ready",
      moves: [],
    })
  })

  it("names the anchors' and arcs' own link properties on the sections and the text relations on the stories", () => {
    const section = (role: string) => workshop.sections.find((entry) => entry.role === role)!
    expect(section("anchors").arcsPropertyId).toBe("ID:prop:arcs:anchors")
    expect(section("anchors").universePropertyId).toBe("ID:prop:universe:anchors")
    expect(section("arcs").charactersPropertyId).toBe("ID:prop:characters:arcs")
    expect(section("characters").arcsPropertyId).toBeNull()
    const properties = (name: string) => workshop.stories.find((s) => s.name === name)!.text!
    // The workshop was initialized whole, so every text has both relations from its birth.
    expect(properties("Дом").properties.anchors).toBe("ID:prop:text:Дом:anchors")
    expect(properties("Лес").properties.arcs).toBe("ID:prop:text:Лес:arcs")
    expect(properties("Одна").properties.anchors).toBe("ID:prop:text:Одна:anchors")
    expect(properties("Одна").properties.arcs).toBe("ID:prop:text:Одна:arcs")
  })

  it("reads which anchors and arcs belong to a story from their own relation and from the text", () => {
    const anchors = "ID:db:anchors"
    const arcs = "ID:db:arcs"
    expect(titlesIn(anchors, { kind: "story", storyId: storyIdOf("Дом") }).shown).toEqual([
      "Встреча",
      "Финал",
    ])
    // The text of "Лес" binds "Побег", which has no relation of its own.
    expect(titlesIn(anchors, { kind: "story", storyId: storyIdOf("Лес") }).shown).toEqual(["Побег"])
    expect(titlesIn(anchors, { kind: "story", storyId: storyIdOf("Одна") }).shown).toEqual([])
    // "Потоп" names its universe only, so it is in no story and no text.
    expect(titlesIn(anchors, { kind: "standalone" }).without).toEqual(["Потоп", "Свободный"])
    // "Месть" has no relation either; a chapter of "Дом" binds it.
    expect(titlesIn(arcs, { kind: "story", storyId: storyIdOf("Дом") }).shown).toEqual([
      "Любовь",
      "Месть",
    ])
    expect(titlesIn(arcs, { kind: "story", storyId: storyIdOf("Лес") }).shown).toEqual([])
  })

  it("orders the anchors of a story by its text and marks the pages, from the real rows", () => {
    const house = workshop.stories.find((story) => story.name === "Дом")!
    const textRows = rows["ID:db:text:Дом"]
    const roots = buildTextTree(textRows, house.text!.properties)
    const bindings = readBindings(textRows, house.text!.properties)
    const anchorItems = entityItemsOf(rows["ID:db:anchors"], "ID:db:anchors", workshop.workshopId)
    const belonging = scopeEntities(
      anchorItems,
      { kind: "story", storyId: house.storyId },
      membership,
    ).shown
    const ordered = orderStoryAnchors({
      anchors: belonging,
      textOrder: textOrder(roots),
      bindings,
      manualOrder: [],
      createdOf: () => undefined,
    })
    // "Встреча" is on chapter 1 and chapter 2, "Финал" on chapter 2: the text decides.
    expect(ordered.placed.map((entry) => entry.row.title)).toEqual(["Встреча", "Финал"])
    const titleOf = new Map(textRows.map((row) => [row.noteId, row.title]))
    expect(ordered.placed[0].pageIds.map((id) => titleOf.get(id))).toEqual(["Глава 1", "Глава 2"])
    expect(ordered.ahead).toEqual([])

    const titles = new Map(
      [...rows["ID:db:anchors"], ...rows["ID:db:arcs"]].map((row) => [row.noteId, row.title]),
    )
    const chapter = textRows.find((row) => row.title === "Глава 1")!
    const marks = pageMarks(bindings.get(chapter.noteId), (_kind, id) => titles.get(id))!
    expect(marks.anchorCount).toBe(1)
    expect(marks.dots.map((dot) => dot.title)).toEqual(["Любовь", "Месть"])
    expect(
      pagesOf(bindings, textOrder(roots), "arc", "ID:note:Любовь").map((id) => titleOf.get(id)),
    ).toEqual(["Глава 1", "Глава 2"])
    // The book above them is bound to nothing and has no marks.
    const book = textRows.find((row) => row.title === "Книга")!
    expect(pageMarks(bindings.get(book.noteId), (_kind, id) => titles.get(id))).toBeNull()

    // The story made before the anchors has no relation, so none of its pages is bound.
    const lone = workshop.stories.find((story) => story.name === "Одна")!
    expect(readBindings(rows["ID:db:text:Одна"], lone.text!.properties).size).toBe(0)
  })

  describe("the plot seen from a page, an arc, a universe and the whole workshop", () => {
    const section = (role: string) => workshop.sections.find((entry) => entry.role === role)!
    const anchorRows = rows["ID:db:anchors"]
    const universeProperty = section("anchors").universePropertyId!
    const arcsProperty = section("anchors").arcsPropertyId!
    const universeOf = (noteId: string) => {
      const row = anchorRows.find((candidate) => candidate.noteId === noteId)
      return row ? (relationTargetsOf(row.valuesJson, universeProperty)[0] ?? null) : null
    }
    const arcsOf = (noteId: string) => {
      const row = anchorRows.find((candidate) => candidate.noteId === noteId)
      return row ? relationTargetsOf(row.valuesJson, arcsProperty) : []
    }
    const plotText = (name: string): StoryPlotText => {
      const story = workshop.stories.find((entry) => entry.name === name)!
      const textRows = rows[`ID:db:text:${name}`]
      return {
        storyId: story.storyId,
        storyName: name,
        textOrder: textOrder(buildTextTree(textRows, story.text!.properties)),
        bindings: readBindings(textRows, story.text!.properties),
      }
    }
    const common = { manualOrder: [], createdOf: () => undefined }
    const titleOf = (databaseId: string) => {
      const titles = new Map(rows[databaseId].map((row) => [row.noteId, row.title]))
      return (id: string) => titles.get(id)
    }

    it("sets apart the anchors of no story, and the events of a universe", () => {
      const standalone = bucketAnchors({
        anchors: anchorRows,
        filter: { kind: "standalone" },
        membership,
        universeOf,
        ...common,
      })
      // Every anchor of a story belongs to "Дом" or "Лес", which the universe holds; "Потоп" is
      // an event of it. Only the anchor of no story is left for the standalone scope.
      expect(standalone.shown).toEqual([])
      expect(standalone.events).toEqual([])
      expect(standalone.withoutStory.map((row) => row.title)).toEqual(["Свободный"])

      const inUniverse = bucketAnchors({
        anchors: anchorRows,
        filter: { kind: "universe", universeId: "ID:note:Мир" },
        membership,
        universeOf,
        ...common,
      })
      expect(inUniverse.events.map((row) => row.title)).toEqual(["Потоп"])
      expect(inUniverse.shown.map((row) => row.title)).toEqual(["Встреча", "Побег", "Финал"])
      expect(
        universeEvents({
          anchors: anchorRows,
          universeId: "ID:note:Мир",
          universeOf,
          ...common,
        }).map((row) => row.title),
      ).toEqual(["Потоп"])
    })

    it("finds the neighbours of the pages of a real text", () => {
      const house = workshop.stories.find((story) => story.name === "Дом")!
      const text = plotText("Дом")
      const belonging = scopeEntities(
        entityItemsOf(anchorRows, "ID:db:anchors", workshop.workshopId),
        { kind: "story", storyId: house.storyId },
        membership,
      ).shown
      const ordered = orderStoryAnchors({ anchors: belonging, ...text, ...common })
      const pageId = (title: string) =>
        rows["ID:db:text:Дом"].find((row) => row.title === title)!.noteId
      const names = (list: { title: string }[]) => list.map((row) => row.title)

      const book = pageNeighbours(pageId("Книга"), ordered, text.textOrder, text.bindings)
      expect(book.own).toEqual([])
      expect(book.from).toBeNull()
      expect(book.to?.title).toBe("Встреча")
      const first = pageNeighbours(pageId("Глава 1"), ordered, text.textOrder, text.bindings)
      expect(names(first.own)).toEqual(["Встреча"])
      expect(first.to?.title).toBe("Финал")
      const last = pageNeighbours(pageId("Глава 2"), ordered, text.textOrder, text.bindings)
      expect(names(last.own)).toEqual(["Финал", "Встреча"])
      expect(last.from).toBeNull()
      expect(last.to).toBeNull()
    })

    it("lists the anchors and the chapters of an arc from the real rows", () => {
      const stories = [plotText("Дом"), plotText("Лес")]
      const anchorTitle = titleOf("ID:db:anchors")
      const pageTitle = (id: string) =>
        [...rows["ID:db:text:Дом"], ...rows["ID:db:text:Лес"]].find((row) => row.noteId === id)
          ?.title
      const love = arcAnchors({
        arcId: "ID:note:Любовь",
        anchors: anchorRows,
        arcsOf,
        stories,
        ...common,
      })
      expect(love.byStory.map((g) => [g.storyName, g.anchors.map((r) => r.title)])).toEqual([
        ["Дом", ["Встреча", "Финал"]],
      ])
      expect(love.unbound).toEqual([])
      const revenge = arcAnchors({
        arcId: "ID:note:Месть",
        anchors: anchorRows,
        arcsOf,
        stories,
        ...common,
      })
      expect(revenge.byStory.map((g) => g.anchors.map((r) => r.title))).toEqual([["Финал"]])
      expect(anchorTitle("ID:note:Финал")).toBe("Финал")

      const chapters = arcChapters("ID:note:Любовь", stories)
      expect(chapters).toHaveLength(1)
      expect(chapters[0].pageIds.map(pageTitle)).toEqual(["Глава 1", "Глава 2"])
      expect(pageTitle(chapters[0].span!.from)).toBe("Глава 1")
      expect(pageTitle(chapters[0].span!.to)).toBe("Глава 2")
      // "Месть" is on one chapter only: no span.
      expect(arcChapters("ID:note:Месть", stories)[0].span).toBeNull()
    })

    it("finds the arcs of a character through the arcs' own relation", () => {
      const charactersProperty = section("arcs").charactersPropertyId!
      const references: NoteReference[] = rows["ID:db:arcs"]
        .filter((row) =>
          relationTargetsOf(row.valuesJson, charactersProperty).includes("ID:note:Анна"),
        )
        .map((row) => ({
          direction: "in",
          propertyId: charactersProperty,
          propertyName: "Персонажи",
          databaseId: "ID:db:arcs",
          databaseName: "Арки",
          noteId: row.noteId,
          title: row.title,
        }))
      expect(characterArcs(references, charactersProperty).map((arc) => arc.title)).toEqual([
        "Любовь",
      ])
      // A character no arc names has none.
      expect(characterArcs([], charactersProperty)).toEqual([])
    })
  })
})
