import { describe, expect, it } from "vitest"
import { parseMermaidFlowchart, convertMermaidToCanvas } from "./canvas-mermaid"
import type { TextNodeData } from "@/lib/canvas-format"

describe("canvas-mermaid", () => {
  it("parses simple flowchart TD with 2 nodes and arrow", () => {
    const code = `
flowchart TD
  A[Start] --> B[End]
`
    const parsed = parseMermaidFlowchart(code)
    expect(parsed.isValid).toBe(true)
    expect(parsed.direction).toBe("TD")
    expect(parsed.nodes.size).toBe(2)
    expect(parsed.nodes.get("A")?.label).toBe("Start")
    expect(parsed.nodes.get("B")?.label).toBe("End")
    expect(parsed.edges).toHaveLength(1)
    expect(parsed.edges[0].source).toBe("A")
    expect(parsed.edges[0].target).toBe("B")
    expect(parsed.edges[0].arrow).toBe("arrow")
  })

  it("parses different node shapes", () => {
    const code = `
flowchart LR
  a(Rounded) --> b([Stadium])
  b --> c[[Subroutine]]
  c --> d[(Cylinder)]
  d --> e((Circle))
  e --> f>Flag]
`
    const parsed = parseMermaidFlowchart(code)
    expect(parsed.isValid).toBe(true)
    expect(parsed.direction).toBe("LR")
    expect(parsed.nodes.get("a")?.shape).toBe("rounded")
    expect(parsed.nodes.get("b")?.shape).toBe("stadium")
    expect(parsed.nodes.get("c")?.shape).toBe("subroutine")
    expect(parsed.nodes.get("d")?.shape).toBe("cylinder")
    expect(parsed.nodes.get("e")?.shape).toBe("circle")
    expect(parsed.nodes.get("f")?.shape).toBe("asymmetric")
  })

  it("parses labeled edges", () => {
    const code = `
flowchart TD
  A[Choice] -->|Yes| B[Proceed]
  A -->|No| C[Cancel]
`
    const parsed = parseMermaidFlowchart(code)
    expect(parsed.isValid).toBe(true)
    expect(parsed.edges).toHaveLength(2)
    expect(parsed.edges[0].label).toBe("Yes")
    expect(parsed.edges[1].label).toBe("No")
  })

  it("handles unsupported constructs with warnings without failing valid parts", () => {
    const code = `
flowchart TD
  subgraph Cluster
    A[Start] --> B[End]
  end
`
    const parsed = parseMermaidFlowchart(code)
    expect(parsed.diagnostics.some((d) => d.severity === "warning")).toBe(true)
    // The inner edge A --> B is still captured
    expect(parsed.nodes.has("A")).toBe(true)
    expect(parsed.nodes.has("B")).toBe(true)
  })

  it("converts parsed flowchart to canvas nodes and edges with layout", () => {
    const code = `
flowchart LR
  A[Source] -->|data| B[Target]
`
    const parsed = parseMermaidFlowchart(code)
    const canvasGraph = convertMermaidToCanvas(parsed, { x: 100, y: 100 })
    expect(canvasGraph.nodes).toHaveLength(2)
    expect(canvasGraph.edges).toHaveLength(1)
    expect(canvasGraph.edges[0].data?.label).toBe("data")

    // In LR layout, Target should be to the right of Source
    const sourceNode = canvasGraph.nodes.find((n) => (n.data as TextNodeData).text === "Source")!
    const targetNode = canvasGraph.nodes.find((n) => (n.data as TextNodeData).text === "Target")!
    expect(sourceNode.position.x).toBeLessThan(targetNode.position.x)
  })
})
