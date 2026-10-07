import { describe, expect, it } from "vitest"
import {
  addView,
  duplicateView,
  newLinkedBlock,
  parseLinkedBlock,
  removeView,
  serializeLinkedBlock,
  stringifyLinkedBlock,
  viewLabel,
  type LinkedView,
} from "./linked-block"

const DB = "01J00000000000000000000010"
const OTHER = "01J00000000000000000000011"

const view = (id: string, extra: Partial<LinkedView> = {}): LinkedView => ({
  id,
  databaseId: DB,
  title: "Tasks",
  layout: "board",
  config: { sorts: [] },
  extra: {},
  ...extra,
})

describe("linked block", () => {
  it("round-trips a shortcut and keeps what this version does not know", () => {
    const raw = JSON.stringify({
      version: 2,
      future: { a: 1 },
      views: [
        { id: "a", databaseId: DB, title: "T", icon: "📚", layout: "list", config: {}, note: 1 },
      ],
      height: 300,
      width: 640,
    })
    const parsed = parseLinkedBlock(raw)!
    expect(parsed.block.views[0]).toMatchObject({ id: "a", icon: "📚", layout: "list" })
    expect(serializeLinkedBlock(parsed)).toBe(raw)
    const written = JSON.parse(stringifyLinkedBlock(parsed.block))
    expect(written.future).toEqual({ a: 1 })
    expect(written.views[0].note).toBe(1)
    // A size saved by an earlier build is no longer used, but it is not lost.
    expect(written.height).toBe(300)
    expect(written.width).toBe(640)
  })

  it("opens the first format as a one-view shortcut and rewrites it only when edited", () => {
    const raw = JSON.stringify({ databaseId: DB, viewId: OTHER, layout: "gallery" })
    const parsed = parseLinkedBlock(raw)!
    expect(parsed.block.views).toHaveLength(1)
    expect(parsed.block.views[0]).toMatchObject({ databaseId: DB, layout: "gallery", title: "" })
    expect(serializeLinkedBlock(parsed)).toBe(raw)
    expect(JSON.parse(serializeLinkedBlock(parsed, parsed.block)).version).toBe(2)
  })

  it("rejects what it cannot show without guessing", () => {
    for (const raw of [
      "legacy-id",
      JSON.stringify({ version: 3, views: [] }),
      JSON.stringify({ version: 2, views: [] }),
      JSON.stringify({ version: 2, views: [{ id: "a", databaseId: "bad" }] }),
      JSON.stringify({
        version: 2,
        views: [
          { id: "a", databaseId: DB },
          { id: "a", databaseId: DB },
        ],
      }),
    ]) {
      expect(parseLinkedBlock(raw)).toBeNull()
    }
  })

  it("adds, duplicates and removes views, keeping the last one", () => {
    const block = newLinkedBlock(view("a"))
    const two = addView(block, view("b"), "a")
    expect(two.views.map((v) => v.id)).toEqual(["a", "b"])
    const copy = duplicateView(two.views[0])
    expect(copy.id).not.toBe("a")
    copy.config.sorts = ["changed"]
    expect(two.views[0].config.sorts).toEqual([])
    expect(removeView(two, "a").views.map((v) => v.id)).toEqual(["b"])
    expect(removeView(block, "a")).toBe(block)
  })

  it("labels a tab with its own name or the database's", () => {
    expect(viewLabel(view("a", { title: " Mine " }), "Tasks DB")).toBe("Mine")
    expect(viewLabel(view("a", { title: "" }), "Tasks DB")).toBe("Tasks DB")
  })
})
