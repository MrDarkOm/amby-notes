import { describe, expect, it } from "vitest"
import {
  availableWidgets,
  deskColumns,
  defaultDeskLayout,
  effectiveSpan,
  moveWidget,
  nextSpan,
  reconcileDeskLayout,
  setWidgetHidden,
  setWidgetSpan,
  worldWidgetId,
  type DeskItem,
} from "./desk-layout-model"

describe("the widgets a story can show", () => {
  it("lists the fixed ones, the notes, the world by role, then the author's own sections", () => {
    const available = availableWidgets({
      hasNotes: true,
      worldSections: [
        { id: "s_loc", role: "locations" },
        { id: "s_own", role: "custom" },
        { id: "s_arcs", role: "arcs" },
        { id: "s_chars", role: "characters" },
      ],
    })
    expect(available).toEqual([
      "continue",
      "progress",
      "chapters",
      "notes",
      "characters",
      "locations",
      "arcs",
      "section:s_own",
    ])
  })

  it("leaves out the notes and the world a workshop does not have", () => {
    expect(availableWidgets({ hasNotes: false, worldSections: [] })).toEqual([
      "continue",
      "progress",
      "chapters",
    ])
  })

  it("names a world section's widget by its role, or by its own ID", () => {
    expect(worldWidgetId({ id: "x", role: "characters" })).toBe("characters")
    expect(worldWidgetId({ id: "x", role: "custom" })).toBe("section:x")
    expect(worldWidgetId({ id: "x", role: null })).toBe("section:x")
  })

  it("gives the default layout: Continue and Chapters two columns wide, the rest one", () => {
    const layout = defaultDeskLayout(["continue", "progress", "chapters", "notes", "characters"])
    expect(layout.map((item) => [item.id, item.span, item.hidden])).toEqual([
      ["continue", 2, false],
      ["progress", 1, false],
      ["chapters", 2, false],
      ["notes", 1, false],
      ["characters", 1, false],
    ])
  })
})

describe("reconcileDeskLayout", () => {
  const available = ["continue", "progress", "chapters", "notes"]

  it("keeps the saved order, widths and hidden widgets", () => {
    const result = reconcileDeskLayout(
      [
        { id: "chapters", span: 3, hidden: false },
        { id: "continue", span: 1, hidden: true },
        { id: "progress", span: 2, hidden: false },
        { id: "notes", span: 1, hidden: false },
      ],
      available,
    )
    expect(result).toEqual([
      { id: "chapters", span: 3, hidden: false },
      { id: "continue", span: 1, hidden: true },
      { id: "progress", span: 2, hidden: false },
      { id: "notes", span: 1, hidden: false },
    ])
  })

  it("adds a widget the layout does not know after the rest, shown and at its default width", () => {
    const result = reconcileDeskLayout([{ id: "chapters", span: 3, hidden: false }], available)
    expect(result.map((item) => item.id)).toEqual(["chapters", "continue", "progress", "notes"])
    expect(result[1]).toEqual({ id: "continue", span: 2, hidden: false })
  })

  it("drops a widget this story cannot show, an unknown one and a repeat", () => {
    const result = reconcileDeskLayout(
      [
        { id: "arcs", span: 1, hidden: false },
        { id: "gone", span: 1, hidden: false },
        { id: "progress", span: 1, hidden: false },
        { id: "progress", span: 3, hidden: true },
      ],
      ["progress", "chapters"],
    )
    expect(result).toEqual([
      { id: "progress", span: 1, hidden: false },
      { id: "chapters", span: 2, hidden: false },
    ])
  })

  it("falls back to the defaults for what cannot be read", () => {
    expect(reconcileDeskLayout(undefined, ["continue"])).toEqual(defaultDeskLayout(["continue"]))
    expect(reconcileDeskLayout("nope", ["continue"])).toEqual(defaultDeskLayout(["continue"]))
    expect(
      reconcileDeskLayout([null, 3, { id: "continue", span: 9, hidden: "yes" }], ["continue"]),
    ).toEqual([{ id: "continue", span: 2, hidden: false }])
  })
})

describe("the columns of the desk", () => {
  it("is three wide, two medium and one narrow; unmeasured is wide", () => {
    expect(deskColumns(1100)).toBe(3)
    expect(deskColumns(860)).toBe(3)
    expect(deskColumns(700)).toBe(2)
    expect(deskColumns(559)).toBe(1)
    expect(deskColumns(0)).toBe(3)
  })

  it("never lets a widget take more columns than the desk has", () => {
    expect(effectiveSpan(3, 2)).toBe(2)
    expect(effectiveSpan(2, 1)).toBe(1)
    expect(effectiveSpan(1, 3)).toBe(1)
  })
})

describe("changing the layout", () => {
  const item = (id: string, span: DeskItem["span"] = 1, hidden = false): DeskItem => ({
    id,
    span,
    hidden,
  })
  const ids = (items: DeskItem[]) => items.map((entry) => entry.id)

  it("moves a widget one place earlier or later", () => {
    const items = [item("a"), item("b"), item("c")]
    expect(ids(moveWidget(items, "b", -1))).toEqual(["b", "a", "c"])
    expect(ids(moveWidget(items, "b", 1))).toEqual(["a", "c", "b"])
  })

  it("does not move past either end, and leaves what it is given untouched", () => {
    const items = [item("a"), item("b")]
    expect(ids(moveWidget(items, "a", -1))).toEqual(["a", "b"])
    expect(ids(moveWidget(items, "b", 1))).toEqual(["a", "b"])
    expect(ids(moveWidget(items, "nope", 1))).toEqual(["a", "b"])
    moveWidget(items, "a", 1)
    expect(ids(items)).toEqual(["a", "b"])
  })

  it("trades places with the nearest shown widget, so a hidden one keeps its place", () => {
    const items = [item("a"), item("h", 1, true), item("b"), item("c")]
    expect(ids(moveWidget(items, "b", -1))).toEqual(["b", "h", "a", "c"])
    expect(ids(moveWidget(items, "a", 1))).toEqual(["b", "h", "a", "c"])
    // A hidden widget is not moved.
    expect(ids(moveWidget(items, "h", 1))).toEqual(["a", "h", "b", "c"])
  })

  it("cycles the width: a third, two thirds, the whole row, a third", () => {
    expect(nextSpan(1)).toBe(2)
    expect(nextSpan(2)).toBe(3)
    expect(nextSpan(3)).toBe(1)
    const items = [item("a", 2), item("b", 1)]
    expect(setWidgetSpan(items, "a", nextSpan(2))).toEqual([item("a", 3), item("b", 1)])
  })

  it("hides a widget and brings it back where it stood", () => {
    const items = [item("a"), item("b"), item("c")]
    const hidden = setWidgetHidden(items, "b", true)
    expect(hidden.map((entry) => entry.hidden)).toEqual([false, true, false])
    expect(setWidgetHidden(hidden, "b", false)).toEqual(items)
    expect(ids(hidden)).toEqual(["a", "b", "c"])
  })
})
