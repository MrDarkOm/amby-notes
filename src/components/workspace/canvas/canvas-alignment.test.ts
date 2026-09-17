import { describe, expect, it } from "vitest"
import { alignNodes, distributeNodes, snapPosition, type Rect } from "./canvas-alignment"
import type { CanvasFlowNode } from "@/lib/canvas-format"

const makeNode = (id: string, x: number, y: number, width = 100, height = 50): CanvasFlowNode => ({
  id,
  type: "text",
  position: { x, y },
  width,
  height,
  data: { text: id },
})

describe("canvas-alignment", () => {
  it("aligns nodes to the left", () => {
    const nodes = [makeNode("a", 10, 0), makeNode("b", 50, 20), makeNode("c", 100, 40)]
    const aligned = alignNodes(nodes, new Set(["a", "b", "c"]), "left")
    expect(aligned.map((n) => n.position.x)).toEqual([10, 10, 10])
  })

  it("aligns nodes to the center horizontally", () => {
    // a: x=0, w=100 (range 0..100)
    // b: x=200, w=100 (range 200..300)
    // bounding box: 0..300, center = 150
    const nodes = [makeNode("a", 0, 0, 100, 50), makeNode("b", 200, 0, 100, 50)]
    const aligned = alignNodes(nodes, new Set(["a", "b"]), "center")
    // Each center should be 150, so x = 150 - 50 = 100
    expect(aligned.map((n) => n.position.x)).toEqual([100, 100])
  })

  it("aligns nodes to the top", () => {
    const nodes = [makeNode("a", 0, 50), makeNode("b", 100, 10), makeNode("c", 200, 80)]
    const aligned = alignNodes(nodes, new Set(["a", "b", "c"]), "top")
    expect(aligned.map((n) => n.position.y)).toEqual([10, 10, 10])
  })

  it("distributes nodes horizontally with equal spacing", () => {
    // 3 nodes with width 100:
    // a: 0..100
    // b: 50..150 (initial)
    // c: 400..500
    // total span between a and c = 400 - 100 = 300.
    // inner width of b = 100.
    // remaining space = 200 / 2 = 100 gap.
    // b should be placed at 100 + 100 = 200.
    const nodes = [
      makeNode("a", 0, 0, 100, 50),
      makeNode("b", 50, 0, 100, 50),
      makeNode("c", 400, 0, 100, 50),
    ]
    const distributed = distributeNodes(nodes, new Set(["a", "b", "c"]), "horizontal")
    expect(distributed.find((n) => n.id === "b")?.position.x).toBe(200)
  })

  it("snaps to nearby node bounds within threshold", () => {
    const active: Rect = { x: 102, y: 50, width: 100, height: 50 }
    const other: Rect = { x: 100, y: 200, width: 100, height: 50 }

    const res = snapPosition(active, [other], 5)
    // Diff is 2 (<= 5 threshold), so should snap to 100
    expect(res.x).toBe(100)
    expect(res.verticalLine).toBe(100)
  })

  it("does not snap when distance exceeds threshold", () => {
    const active: Rect = { x: 120, y: 50, width: 100, height: 50 }
    const other: Rect = { x: 100, y: 200, width: 100, height: 50 }

    const res = snapPosition(active, [other], 5)
    expect(res.x).toBe(120)
    expect(res.verticalLine).toBeNull()
  })
})
