import { describe, expect, it } from "vitest"
import type { DatabasePropertySummary } from "@/lib/storage"
import {
  cardProperties,
  formatComputedValue,
  formatRowProperties,
  safeOptionColor,
} from "./value-format"

const property = (
  propertyId: string,
  propertyType: string,
  extra: Partial<DatabasePropertySummary> = {},
): DatabasePropertySummary => ({
  propertyId,
  name: propertyId,
  propertyType,
  configJson: "{}",
  options: [],
  ...extra,
})

const status = property("status", "status", {
  name: "Status",
  options: [
    { optionId: "o1", name: "In progress", color: "#3b82f6" },
    { optionId: "o2", name: "Done", color: "javascript:alert(1)" },
  ],
})

describe("formatRowProperties", () => {
  it("names options and keeps only safe hex colors", () => {
    const [shown] = formatRowProperties(
      JSON.stringify({ status: { type: "status", optionId: "o1" } }),
      [status],
    )
    expect(shown.chips).toEqual([
      { key: "status", kind: "option", label: "In progress", color: "#3b82f6" },
    ])
    const [done] = formatRowProperties(
      JSON.stringify({ status: { type: "status", optionId: "o2" } }),
      [status],
    )
    expect(done.chips[0].color).toBeNull()
    expect(safeOptionColor("url(x)")).toBeNull()
  })

  it("never shows a raw option ID: a removed option becomes a missing chip", () => {
    const [shown] = formatRowProperties(
      JSON.stringify({ status: { type: "status", optionId: "gone" } }),
      [status],
    )
    expect(shown.chips[0]).toMatchObject({ label: null, state: "missing" })
  })

  it("lists multi-select options by name in value order", () => {
    const tags = property("tags", "multiSelect", {
      options: [
        { optionId: "a", name: "Alpha", color: "#111111" },
        { optionId: "b", name: "Beta", color: "#222222" },
      ],
    })
    const [shown] = formatRowProperties(
      JSON.stringify({ tags: { type: "multiSelect", optionIds: ["b", "a"] } }),
      [tags],
    )
    expect(shown.chips.map((chip) => chip.label)).toEqual(["Beta", "Alpha"])
  })

  it("uses a known relation title and a pending chip, never the note ID", () => {
    const rel = property("rel", "relation")
    const values = JSON.stringify({ rel: { type: "relation", targetNoteIds: ["n1", "n2"] } })
    const [shown] = formatRowProperties(values, [rel], { relationTitles: { n1: "Acme" } })
    expect(shown.chips).toMatchObject([{ label: "Acme" }, { label: null, state: "pending" }])
    expect(shown.chips.map((chip) => chip.label)).not.toContain("n2")
  })

  it("formats numbers and dates by property config", () => {
    const percent = property("p", "number", { configJson: '{"format":"percent"}' })
    const currency = property("c", "number", {
      configJson: '{"format":"currency","currency":"USD"}',
    })
    const badCurrency = property("b", "number", {
      configJson: '{"format":"currency","currency":"??"}',
    })
    const date = property("d", "date", { configJson: '{"includeTime":false}' })
    const values = JSON.stringify({
      p: { type: "number", decimal: "42" },
      c: { type: "number", decimal: "1234.5" },
      b: { type: "number", decimal: "7" },
      d: { type: "date", start: "2026-10-02", end: "2026-10-04", timeZone: null },
    })
    const shown = formatRowProperties(values, [percent, currency, badCurrency, date], {
      locale: "en-US",
    })
    expect(shown[0].chips[0].label).toBe("42%")
    expect(shown[1].chips[0].label).toBe("$1,234.5")
    expect(shown[2].chips[0].label).toBe("7")
    expect(shown[3].chips[0].label).toBe("Oct 2, 2026 – Oct 4, 2026")
  })

  it("keeps huge or malformed numbers exactly as stored", () => {
    const currency = property("c", "number", {
      configJson: '{"format":"currency","currency":"USD"}',
    })
    const huge = "1e999999999999999999999"
    const [shown] = formatRowProperties(JSON.stringify({ c: { type: "number", decimal: huge } }), [
      currency,
    ])
    expect(shown.chips[0].label).toBe(huge)
  })

  it("follows schema order, skips empty and unknown values, and tolerates bad JSON", () => {
    const a = property("a", "text")
    const b = property("b", "text")
    const values = JSON.stringify({
      b: { type: "text", value: "second" },
      a: { type: "text", value: "first" },
      zz: { type: "text", value: "orphan" },
      empty: { type: "text", value: "" },
    })
    expect(formatRowProperties(values, [a, b]).map((p) => p.propertyId)).toEqual(["a", "b"])
    expect(formatRowProperties("not json", [a])).toEqual([])
    expect(formatRowProperties("null", [a])).toEqual([])
  })

  it("treats an unchecked checkbox as empty", () => {
    const box = property("x", "checkbox")
    expect(
      formatRowProperties(JSON.stringify({ x: { type: "checkbox", checked: false } }), [box]),
    ).toEqual([])
    expect(
      formatRowProperties(JSON.stringify({ x: { type: "checkbox", checked: true } }), [box])[0]
        .chips[0].label,
    ).toBe("✓")
  })
})

describe("computed values", () => {
  const rollup = (aggregation: string) =>
    property("r", "rollup", { configJson: JSON.stringify({ aggregation }) })

  it("keeps zero, no data and a missing value apart", () => {
    const show = (value: unknown, aggregation = "sum") =>
      formatRowProperties(JSON.stringify(value === undefined ? {} : { r: value }), [
        rollup(aggregation),
      ])
    expect(show({ type: "number", decimal: "0" })[0].chips[0].label).toBe("0")
    // Stored null = nothing to aggregate: no chip. Absent = calculation failed or pending: no chip.
    expect(show({ type: "null" })).toEqual([])
    expect(show(undefined)).toEqual([])
  })

  it("shows a share with a percent sign and without trailing zeros", () => {
    expect(
      formatComputedValue({ type: "number", decimal: "50.00" }, rollup("percentChecked")),
    ).toBe("50%")
    expect(
      formatComputedValue({ type: "number", decimal: "33.33" }, rollup("percentChecked")),
    ).toBe("33.33%")
    expect(
      formatComputedValue({ type: "number", decimal: "100.00" }, rollup("percentChecked")),
    ).toBe("100%")
    expect(formatComputedValue({ type: "number", decimal: "7" }, rollup("sum"))).toBe("7")
  })

  it("formats computed text, booleans and dates", () => {
    const formula = property("f", "formula")
    expect(formatComputedValue({ type: "text", value: "ok" }, formula)).toBe("ok")
    expect(formatComputedValue({ type: "checkbox", checked: true }, formula)).toBe("✓")
    expect(formatComputedValue({ type: "date", start: "2026-10-02" }, formula, "en-US")).toBe(
      "Oct 2, 2026",
    )
    expect(formatComputedValue(null, formula)).toBeNull()
  })
})

describe("cardProperties", () => {
  const props = ["a", "b", "c", "d"].map((id) => property(id, "text"))
  const values = JSON.stringify(
    Object.fromEntries(props.map((p) => [p.propertyId, { type: "text", value: p.propertyId }])),
  )

  it("shows at most three non-empty properties in schema order", () => {
    expect(cardProperties(values, props).map((p) => p.propertyId)).toEqual(["a", "b", "c"])
  })

  it("shows exactly the chosen properties, without the compact limit", () => {
    expect(
      cardProperties(values, props, { fields: ["d", "a", "c", "b"] }).map((p) => p.propertyId),
    ).toEqual(["a", "b", "c", "d"])
    expect(cardProperties(values, props, { fields: [] })).toEqual([])
    expect(cardProperties(values, props, { fields: null })).toHaveLength(3)
  })

  it("can exclude properties shown elsewhere", () => {
    expect(cardProperties(values, props, { exclude: ["a"] }).map((p) => p.propertyId)).toEqual([
      "b",
      "c",
      "d",
    ])
  })
})
