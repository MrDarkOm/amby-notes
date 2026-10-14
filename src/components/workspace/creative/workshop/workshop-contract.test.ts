import { describe, expect, it } from "vitest"
import type { DatabaseRow, WorkshopSummary } from "@/lib/storage"
import fixture from "./real-workshop.fixture.json"
import {
  buildMembership,
  entityItemsOf,
  entityTabs,
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
      relativePath: `${entry.noteId}.md`,
      parentNoteId: null,
      depth: 0,
      categoryPath: [],
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

  it("sets apart the pages that are in no story, and labels the rest", () => {
    const all = titlesIn("ID:db:characters", { kind: "all" })
    expect(all.without).toEqual(["Ева"])
    expect(all.shown).toEqual(["Анна", "Борис", "Вера", "Глеб", "Зоя"])
    const boris = storyLabels(membership.storiesOf("ID:note:Борис"), (id) => storyName.get(id))
    expect(boris).toEqual({ names: ["Дом", "Лес"], more: 0 })
    expect(titlesIn("ID:db:universes", { kind: "all" }).shown).toEqual(["Мир"])
  })
})
