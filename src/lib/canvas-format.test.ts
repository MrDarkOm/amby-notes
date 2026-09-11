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

  it("rejects malformed or incomplete Canvas JSON", () => {
    expect(() => validateAndSerializeCanvas("not json")).toThrow("valid JSON")
    expect(() => validateAndSerializeCanvas('{"nodes":[]}')).toThrow("nodes and edges")
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
