import { describe, expect, it } from "vitest"
import type { DatabaseRow, DatabaseSummary } from "@/lib/storage"
import { galleryGroups } from "./section-gallery-model"

const row = (noteId: string, title: string, optionId?: string): DatabaseRow => ({
  noteId,
  title,
  relativePath: `${noteId}.md`,
  parentNoteId: null,
  depth: 0,
  categoryPath: [],
  valuesJson: JSON.stringify(optionId ? { imp: { type: "select", optionId } } : {}),
  rowRevision: "r",
})

const summary = (grouped: boolean): DatabaseSummary => ({
  databaseId: "db",
  title: "Персонажи",
  icon: null,
  attachedNoteId: null,
  manifestRevision: "m",
  locked: false,
  properties: [
    {
      propertyId: "imp",
      name: "Значимость",
      propertyType: "select",
      configJson: "{}",
      options: [
        { optionId: "main", name: "Главные", color: "#d00000" },
        { optionId: "side", name: "Второстепенные", color: "#00d000" },
      ],
    },
  ],
  views: [
    {
      viewId: "v",
      title: "Таблица",
      layout: "table",
      revision: "r",
      groupField: grouped ? { kind: "property", propertyId: "imp" } : null,
    },
  ],
  templates: [],
  diagnostics: [],
})

describe("galleryGroups", () => {
  const rows = [
    row("a", "Зоя", "side"),
    row("b", "Анна", "main"),
    row("c", "Глеб"),
    row("d", "Борис", "main"),
  ]

  it("groups by the property of the first grouped view, in option order, the rest last", () => {
    const groups = galleryGroups(rows, summary(true), "Без категории")
    expect(groups.map((group) => group.label)).toEqual([
      "Главные",
      "Второстепенные",
      "Без категории",
    ])
    expect(groups.map((group) => group.rows.map((r) => r.title))).toEqual([
      ["Анна", "Борис"],
      ["Зоя"],
      ["Глеб"],
    ])
    expect(groups[0].color).toBe("#d00000")
    expect(groups[2].color).toBeNull()
  })

  it("is one group without a heading when the database groups by nothing", () => {
    const groups = galleryGroups(rows, summary(false), "Без категории")
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBeNull()
    expect(groups[0].rows).toHaveLength(4)
  })

  it("needs no heading when every page falls in one group", () => {
    const groups = galleryGroups([row("a", "Анна", "main")], summary(true), "Без категории")
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBeNull()
  })

  it("is empty for no rows, and one plain group when the database is not known", () => {
    expect(galleryGroups([], summary(true), "x")).toEqual([])
    const groups = galleryGroups(rows, undefined, "x")
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBeNull()
  })
})
