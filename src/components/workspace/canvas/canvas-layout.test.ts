import { describe, expect, it } from "vitest"
import { computeAutoLayout } from "./canvas-layout"
import type { CanvasFlowNode } from "@/lib/canvas-format"
import type { Edge } from "@xyflow/react"

const makeNode = (id: string, x = 0, y = 0): CanvasFlowNode => ({
  id,
  type: "text",
  position: { x, y },
  width: 100,
  height: 50,
  data: { text: id },
})

describe("canvas-layout", () => {
  it("arranges nodes top-to-bottom according to edge directions", () => {
    const nodes = [makeNode("A"), makeNode("B"), makeNode("C")]
    const edges: Edge[] = [
      { id: "e1", source: "A", target: "B" },
      { id: "e2", source: "B", target: "C" },
    ]

    const result = computeAutoLayout(nodes, edges, { direction: "TB" })
    const a = result.find((n) => n.id === "A")!
    const b = result.find((n) => n.id === "B")!
    const c = result.find((n) => n.id === "C")!

    expect(a.position.y).toBeLessThan(b.position.y)
    expect(b.position.y).toBeLessThan(c.position.y)
  })

  it("arranges nodes left-to-right according to edge directions", () => {
    const nodes = [makeNode("A"), makeNode("B")]
    const edges: Edge[] = [{ id: "e1", source: "A", target: "B" }]

    const result = computeAutoLayout(nodes, edges, { direction: "LR" })
    const a = result.find((n) => n.id === "A")!
    const b = result.find((n) => n.id === "B")!

    expect(a.position.x).toBeLessThan(b.position.x)
  })
})
