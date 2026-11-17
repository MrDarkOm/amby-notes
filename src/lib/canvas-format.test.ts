import { describe, expect, it } from "vitest"
import {
  fromReactFlow,
  parseCanvas,
  toReactFlow,
  validateAndSerializeCanvas,
} from "./canvas-format"

describe("validateAndSerializeCanvas", () => {
  it("normalizes a valid Canvas document before persistence", () => {
    expect(validateAndSerializeCanvas('{"edges":[],"nodes":[],"pluginData":{"x":1}}')).toBe(
      '{\n  "nodes": [],\n  "edges": [],\n  "pluginData": {\n    "x": 1\n  }\n}\n',
    )
  })

  it("normalizes an empty JSON object into canonical empty canvas", () => {
    expect(validateAndSerializeCanvas("{}")).toBe('{\n  "nodes": [],\n  "edges": []\n}\n')
  })

  // SAVE-01: these real files used to fail the strict check and open as an empty canvas.
  it("accepts a UTF-8 BOM and a canvas without nodes or edges (both are optional in JSON Canvas)", () => {
    expect(validateAndSerializeCanvas('\uFEFF{"nodes":[],"edges":[]}')).toBe(
      validateAndSerializeCanvas('{"nodes":[],"edges":[]}'),
    )
    const onlyNodes = JSON.parse(
      validateAndSerializeCanvas(
        '{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":1,"height":1,"text":"t"}],"extra":1}',
      ),
    )
    expect(onlyNodes.nodes).toHaveLength(1)
    expect(onlyNodes.edges).toEqual([])
    expect(onlyNodes.extra).toBe(1)
    expect(JSON.parse(validateAndSerializeCanvas('{"edges":[]}')).nodes).toEqual([])
  })

  it("rejects malformed or incomplete Canvas JSON", () => {
    expect(() => validateAndSerializeCanvas("not json")).toThrow("valid JSON")
    expect(() => validateAndSerializeCanvas('{"nodes":{}}')).toThrow("nodes and edges")
  })

  it("preserves unknown top-level, node, link, group, and edge fields", () => {
    const source = {
      nodes: [
        {
          id: "link",
          type: "link",
          x: 1,
          y: 2,
          width: 100,
          height: 80,
          url: "https://example.com",
          plugin: { keep: true },
        },
        {
          id: "group",
          type: "group",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          label: "Group",
          background: "#fff",
        },
      ],
      edges: [{ id: "edge", fromNode: "link", toNode: "group", toEnd: "arrow", custom: "keep" }],
      pluginData: { keep: true },
    }
    const flow = toReactFlow(parseCanvas(JSON.stringify(source)))
    const roundTrip = fromReactFlow(flow.nodes, flow.edges)
    expect(roundTrip.nodes[0]).toMatchObject({
      type: "link",
      url: "https://example.com",
      plugin: { keep: true },
    })
    expect(roundTrip.nodes[1]).toMatchObject({ background: "#fff" })
    expect(roundTrip.edges[0]).toMatchObject({ custom: "keep" })
  })
})

// CRE-02: nodes of types this app does not know (spec extensions, other apps) and
// the exact coordinates of untouched nodes must survive a load/edit/save round trip.
describe("canvas round trip keeps what it does not understand (CRE-02)", () => {
  const unknownNode = {
    id: "u1",
    type: "whiteboard",
    x: 10.5,
    y: -20.25,
    width: 300.5,
    height: 200,
    color: "3",
    strokes: [{ p: [1, 2, 3] }],
    pluginMeta: { a: 1 },
  }
  const textNode = { id: "t1", type: "text", x: 0.5, y: 1.5, width: 250.4, height: 120, text: "hi" }
  const source = JSON.stringify({ nodes: [unknownNode, textNode], edges: [] })

  function roundTripWith(edit?: (nodes: ReturnType<typeof toReactFlow>["nodes"]) => void) {
    const { nodes, edges } = toReactFlow(parseCanvas(source))
    edit?.(nodes)
    return fromReactFlow(nodes, edges)
  }

  it("writes an unknown node back unchanged after another node was edited", () => {
    const out = roundTripWith((nodes) => {
      const t = nodes.find((n) => n.id === "t1")!
      t.data = { ...t.data, text: "edited" }
    })
    expect(out.nodes.find((n) => n.id === "u1")).toEqual(unknownNode)
    expect((out.nodes.find((n) => n.id === "t1") as { text: string }).text).toBe("edited")
  })

  it("does not round the coordinates of untouched nodes", () => {
    const out = roundTripWith()
    expect(out.nodes.find((n) => n.id === "t1")).toMatchObject({ x: 0.5, y: 1.5, width: 250.4 })
    expect(out.nodes.find((n) => n.id === "u1")).toMatchObject({ x: 10.5, width: 300.5 })
  })

  it("moves an unknown node by changing only its geometry", () => {
    const out = roundTripWith((nodes) => {
      nodes.find((n) => n.id === "u1")!.position = { x: 40, y: 50 }
    })
    expect(out.nodes.find((n) => n.id === "u1")).toEqual({ ...unknownNode, x: 40, y: 50 })
  })

  it("renders unknown nodes with a read-only placeholder node type", () => {
    const { nodes } = toReactFlow(parseCanvas(source))
    expect(nodes.find((n) => n.id === "u1")!.type).toBe("unknown")
  })
})
