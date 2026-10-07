import { describe, expect, it } from "vitest"
import {
  applySettingsPatch,
  conditionsToFilter,
  EMPTY_SETTINGS,
  flatConditions,
  mergePatches,
  parseViewSettings,
  settingsAfter,
  toQueryFilter,
  type ViewCondition,
} from "./view-config"

const base = {
  format: "amby-database-view",
  formatVersion: 1,
  databaseId: "db",
  viewId: "v",
  name: "Table",
  layout: "table",
  openMode: "sidePeek",
  fields: [
    { field: { kind: "system", field: "title" }, visible: true, width: null, frozen: true },
    {
      field: { kind: "property", propertyId: "p1" },
      visible: true,
      width: 200,
      frozen: false,
      future: 1,
    },
  ],
  filter: null,
  sorts: [],
  futureTopLevel: { keep: "me" },
  layoutConfig: { rowHeight: "tall", somethingNew: true },
}
const doc = () => JSON.stringify(base)

describe("parseViewSettings", () => {
  it("reads widths, hidden fields, layout settings, sorts and filter", () => {
    const text = JSON.stringify({
      ...base,
      fields: [
        ...base.fields,
        {
          field: { kind: "property", propertyId: "p2" },
          visible: false,
          width: null,
          frozen: false,
        },
      ],
      sorts: [{ field: { kind: "property", propertyId: "p1" }, direction: "desc", nulls: "first" }],
      filter: {
        kind: "condition",
        field: { kind: "property", propertyId: "p1" },
        operator: "contains",
        value: "x",
      },
      layoutConfig: { frozenBoundary: "p1", wrappedFields: ["p1"] },
    })
    expect(parseViewSettings(text)).toMatchObject({
      widths: { p1: 200 },
      hidden: ["p2"],
      frozenKey: "p1",
      wrapped: ["p1"],
      sorts: [{ field: { kind: "property", propertyId: "p1" }, direction: "desc", nulls: "first" }],
    })
  })

  it("survives a broken document with defaults", () => {
    expect(parseViewSettings("not json")).toMatchObject({ hidden: [], sorts: [], filter: null })
  })
})

describe("applySettingsPatch", () => {
  it("changes only the patched settings and keeps everything unknown", () => {
    const next = JSON.parse(
      applySettingsPatch(doc(), { widths: { p1: 320 }, wrapped: ["p1"], frozenKey: "title" }),
    )
    expect(next.futureTopLevel).toEqual({ keep: "me" })
    expect(next.layoutConfig).toEqual({
      rowHeight: "tall",
      somethingNew: true,
      wrappedFields: ["p1"],
      frozenBoundary: "title",
    })
    expect(next.fields[1]).toMatchObject({ width: 320, future: 1 })
    expect(next.fields[0]).toMatchObject({ visible: true, frozen: true })
  })

  it("hides and shows fields, never the title, and adds missing field entries", () => {
    const hidden = JSON.parse(applySettingsPatch(doc(), { hidden: ["p1", "title", "p9"] }))
    const visibility = Object.fromEntries(
      hidden.fields.map(
        (f: { field: { propertyId?: string; field?: string }; visible: boolean }) => [
          f.field.propertyId ?? f.field.field,
          f.visible,
        ],
      ),
    )
    expect(visibility).toEqual({ title: true, p1: false, p9: false })
    const shown = JSON.parse(applySettingsPatch(JSON.stringify(hidden), { hidden: [] }))
    expect(shown.fields.every((f: { visible: boolean }) => f.visible)).toBe(true)
  })

  it("clamps widths into the format's range and can remove one", () => {
    const next = JSON.parse(applySettingsPatch(doc(), { widths: { p1: 5000, title: 10 } }))
    expect(
      next.fields.find((f: { field: { propertyId?: string } }) => f.field.propertyId === "p1")
        .width,
    ).toBe(2000)
    expect(next.fields[0].width).toBe(40)
    const removed = JSON.parse(applySettingsPatch(JSON.stringify(next), { widths: { p1: null } }))
    expect(removed.fields[1].width).toBeNull()
  })

  it("replaces sorts and filter only when patched, and clears layout keys when emptied", () => {
    const withLayout = applySettingsPatch(doc(), { wrapped: ["p1"], frozenKey: "p1" })
    const cleared = JSON.parse(applySettingsPatch(withLayout, { wrapped: [], frozenKey: null }))
    expect(cleared.layoutConfig).toEqual({ rowHeight: "tall", somethingNew: true })
    const filtered = JSON.parse(
      applySettingsPatch(doc(), {
        filter: conditionsToFilter([
          { field: { kind: "property", propertyId: "p1" }, operator: "equals", operand: "a" },
        ]),
      }),
    )
    expect(filtered.filter).toEqual({
      kind: "condition",
      field: { kind: "property", propertyId: "p1" },
      operator: "equals",
      value: "a",
    })
    expect(filtered.sorts).toEqual([])
  })
})

describe("filters", () => {
  const c = (id: string, operator: string, operand?: unknown): ViewCondition => ({
    field: { kind: "property", propertyId: id },
    operator,
    operand,
  })

  it("round-trips a flat AND of conditions", () => {
    for (const conditions of [
      [],
      [c("a", "contains", "x")],
      [c("a", "equals", 1), c("b", "isEmpty")],
    ]) {
      expect(flatConditions(conditionsToFilter(conditions))).toEqual(conditions)
    }
  })

  it("reports OR groups and unknown nodes as not editable, without touching them", () => {
    expect(flatConditions({ kind: "group", operator: "or", children: [] })).toBeNull()
    expect(flatConditions({ kind: "future" })).toBeNull()
  })

  it("converts to the query format with JSON-text operands, and never drops an unknown node", () => {
    const query = toQueryFilter(conditionsToFilter([c("a", "greaterThan", "5"), c("b", "isEmpty")]))
    expect(query).toEqual({
      kind: "group",
      operator: "and",
      children: [
        {
          kind: "condition",
          field: { kind: "property", propertyId: "a" },
          operator: "greaterThan",
          value: '"5"',
        },
        { kind: "condition", field: { kind: "property", propertyId: "b" }, operator: "isEmpty" },
      ],
    })
    expect(toQueryFilter({ kind: "future" })).toMatchObject({ operator: "invalid" })
  })
})

describe("patch helpers", () => {
  it("merges widths per field and lets later values win", () => {
    expect(
      mergePatches({ widths: { a: 100 }, wrapped: ["a"] }, { widths: { b: 200 }, wrapped: [] }),
    ).toEqual({
      widths: { a: 100, b: 200 },
      wrapped: [],
    })
  })

  it("computes the optimistic settings", () => {
    const settings = parseViewSettings(doc())
    expect(
      settingsAfter(settings, { widths: { p1: null, title: 300 }, frozenKey: "title" }),
    ).toMatchObject({
      widths: { title: 300 },
      frozenKey: "title",
    })
  })
})

describe("card settings", () => {
  const gallery = JSON.stringify({ ...base, layout: "gallery" })

  it("does not store the default card size", () => {
    const large = applySettingsPatch(gallery, { cardSize: "large" })
    const back = JSON.parse(applySettingsPatch(large, { cardSize: "medium" }))
    expect(back.layoutConfig.cardSize).toBeUndefined()
  })
})

describe("board grouping and gallery cover", () => {
  const board = JSON.stringify({ ...base, layout: "board", group: null })

  it("sets, reads and clears the property a board is split by", () => {
    const grouped = applySettingsPatch(board, { groupBy: "p1" })
    expect(JSON.parse(grouped).group).toEqual({ field: { kind: "property", propertyId: "p1" } })
    expect(parseViewSettings(grouped).groupBy).toBe("p1")
    const cleared = applySettingsPatch(grouped, { groupBy: null })
    expect(JSON.parse(cleared).group).toBeNull()
    expect(parseViewSettings(cleared).groupBy).toBeNull()
  })

  it("keeps other fields of the group rule and leaves other settings alone", () => {
    const text = JSON.stringify({
      ...JSON.parse(board),
      group: { field: { kind: "property", propertyId: "old" }, future: 1 },
    })
    const next = JSON.parse(applySettingsPatch(text, { groupBy: "p1" }))
    expect(next.group).toEqual({ field: { kind: "property", propertyId: "p1" }, future: 1 })
    expect(next.futureTopLevel).toEqual({ keep: "me" })
    expect(next.layoutConfig).toEqual(base.layoutConfig)
  })

  it("does not treat a title group as a property group", () => {
    const text = JSON.stringify({
      ...JSON.parse(board),
      group: { field: { kind: "system", field: "title" } },
    })
    expect(parseViewSettings(text).groupBy).toBeNull()
  })

  it("shows the gallery cover by default and stores only the hidden state", () => {
    const gallery = JSON.stringify({ ...base, layout: "gallery" })
    expect(parseViewSettings(gallery).coverVisible).toBe(true)
    const hidden = applySettingsPatch(gallery, { coverVisible: false })
    expect(JSON.parse(hidden).layoutConfig.coverVisible).toBe(false)
    expect(parseViewSettings(hidden).coverVisible).toBe(false)
    const shown = JSON.parse(applySettingsPatch(hidden, { coverVisible: true }))
    expect(shown.layoutConfig.coverVisible).toBeUndefined()
    expect(shown.layoutConfig.somethingNew).toBe(true)
  })

  it("keeps board columns uncoloured unless chosen and stores only the chosen state", () => {
    const text = JSON.stringify({ ...base, layout: "board" })
    expect(parseViewSettings(text).colorColumns).toBe(false)
    const colored = applySettingsPatch(text, { colorColumns: true })
    expect(JSON.parse(colored).layoutConfig.colorColumns).toBe(true)
    expect(parseViewSettings(colored).colorColumns).toBe(true)
    const off = JSON.parse(applySettingsPatch(colored, { colorColumns: false }))
    expect(off.layoutConfig.colorColumns).toBeUndefined()
    expect(settingsAfter(parseViewSettings(text), { colorColumns: true }).colorColumns).toBe(true)
  })

  it("stores a board's group settings only when chosen, next to the layout's other fields", () => {
    const text = JSON.stringify({ ...base, layout: "board" })
    expect(parseViewSettings(text)).toMatchObject({
      groupSort: "manual",
      hideEmptyGroups: false,
      groupOrder: [],
      hiddenGroups: [],
    })
    let doc = applySettingsPatch(text, {
      groupSort: "alphabetical",
      hideEmptyGroups: true,
      groupOrder: ["a", "b"],
      hiddenGroups: ["b"],
    })
    expect(parseViewSettings(doc)).toMatchObject({
      groupSort: "alphabetical",
      hideEmptyGroups: true,
      groupOrder: ["a", "b"],
      hiddenGroups: ["b"],
    })
    // Back to the defaults leaves nothing of them in the document.
    doc = applySettingsPatch(doc, {
      groupSort: "manual",
      hideEmptyGroups: false,
      groupOrder: [],
      hiddenGroups: [],
    })
    const layout = JSON.parse(doc).layoutConfig
    expect(layout.groupSort).toBeUndefined()
    expect(layout.hideEmptyGroups).toBeUndefined()
    expect(layout.groupOrder).toBeUndefined()
    expect(layout.hiddenGroups).toBeUndefined()
    expect(layout.somethingNew).toBe(true)
  })

  it("ignores a stored group setting it cannot read", () => {
    const text = JSON.stringify({
      ...base,
      layoutConfig: { groupSort: "sideways", groupOrder: ["a", 3], hiddenGroups: "x" },
    })
    expect(parseViewSettings(text)).toMatchObject({
      groupSort: "manual",
      groupOrder: ["a"],
      hiddenGroups: [],
    })
  })

  it("applies the new settings to the optimistic copy", () => {
    const next = settingsAfter(parseViewSettings(board), { groupBy: "p1", coverVisible: false })
    expect(next).toMatchObject({ groupBy: "p1", coverVisible: false })
  })
})

describe("manual row order", () => {
  it("reads the order stored in the view and writes it back untouched next to other settings", () => {
    const doc = JSON.stringify({ manualOrder: ["a", "b"], layoutConfig: { cardSize: "large" } })
    expect(parseViewSettings(doc).manualOrder).toEqual(["a", "b"])
    const next = JSON.parse(applySettingsPatch(doc, { manualOrder: ["b", "a", "c"] }))
    expect(next.manualOrder).toEqual(["b", "a", "c"])
    expect(next.layoutConfig).toEqual({ cardSize: "large" })
  })

  it("keeps an emptied order as an empty list and leaves it alone when not patched", () => {
    const doc = JSON.stringify({ manualOrder: ["a"] })
    expect(JSON.parse(applySettingsPatch(doc, { manualOrder: [] })).manualOrder).toEqual([])
    expect(JSON.parse(applySettingsPatch(doc, { openMode: "centerPeek" })).manualOrder).toEqual([
      "a",
    ])
    expect(parseViewSettings("{}").manualOrder).toEqual([])
  })

  it("applies a patch to the local copy of the settings", () => {
    expect(settingsAfter(EMPTY_SETTINGS, { manualOrder: ["x"] }).manualOrder).toEqual(["x"])
    expect(settingsAfter({ ...EMPTY_SETTINGS, manualOrder: ["x"] }, {}).manualOrder).toEqual(["x"])
  })
})
