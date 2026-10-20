import { describe, expect, it } from "vitest"
import { parseGraphLayout } from "./graph-layout-store"

describe("parseGraphLayout", () => {
  it("reads the pinned positions and the view of a locked graph", () => {
    const parsed = parseGraphLayout({
      version: 1,
      locked: true,
      nodes: { a: [1.5, -2], b: ["x", 3], c: [4] },
      camera: { cx: 10, cy: 20, zoom: 1.5 },
    })
    expect(parsed.locked).toBe(true)
    expect([...parsed.positions]).toEqual([["a", { x: 1.5, y: -2 }]])
    expect(parsed.camera).toEqual({ cx: 10, cy: 20, zoom: 1.5 })
  })

  it("leaves the graph free for a missing, unlocked or unknown file", () => {
    for (const raw of [null, { version: 1, locked: false }, { version: 2, locked: true }]) {
      expect(parseGraphLayout(raw)).toEqual({ locked: false, positions: new Map(), camera: null })
    }
  })

  it("drops a camera that cannot be shown", () => {
    expect(
      parseGraphLayout({ version: 1, locked: true, camera: { cx: 0, cy: 0, zoom: 0 } }).camera,
    ).toBeNull()
  })
})
