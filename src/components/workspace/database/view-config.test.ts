import { describe, expect, it } from "vitest"
import {
  applySettingsPatch,
  conditionsToFilter,
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

  it("stores the card property list under the key of the view's own layout", () => {
    for (const [layout, key] of [
      ["board", "cardFields"],
      ["list", "secondaryFields"],
      ["gallery", "fieldList"],
    ] as const) {
      const text = JSON.stringify({ ...base, layout })
      const next = applySettingsPatch(text, { cardFields: ["p1"] })
      expect(JSON.parse(next).layoutConfig[key]).toEqual(["p1"])
      expect(parseViewSettings(next).cardFields).toEqual(["p1"])
    }
  })

  it("distinguishes automatic (no key) from an explicit empty list, and resets", () => {
    expect(parseViewSettings(gallery).cardFields).toBeNull()
    const none = applySettingsPatch(gallery, { cardFields: [] })
    expect(parseViewSettings(none).cardFields).toEqual([])
    const reset = applySettingsPatch(none, { cardFields: null })
    expect(JSON.parse(reset).layoutConfig.fieldList).toBeUndefined()
    expect(parseViewSettings(reset).cardFields).toBeNull()
  })

  it("keeps card settings of another layout when the layout is switched", () => {
    const withFields = applySettingsPatch(gallery, { cardFields: ["p1"], cardSize: "large" })
    const asBoard = JSON.stringify({ ...JSON.parse(withFields), layout: "board" })
    expect(parseViewSettings(asBoard).cardFields).toBeNull()
    expect(JSON.parse(asBoard).layoutConfig.fieldList).toEqual(["p1"])
    expect(parseViewSettings(withFields)).toMatchObject({ cardFields: ["p1"], cardSize: "large" })
  })

  it("does not store the default card size", () => {
    const large = applySettingsPatch(gallery, { cardSize: "large" })
    const back = JSON.parse(applySettingsPatch(large, { cardSize: "medium" }))
    expect(back.layoutConfig.cardSize).toBeUndefined()
  })
})
