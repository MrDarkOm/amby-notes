import { describe, expect, it } from "vitest"
import {
  buildGraphView,
  DEFAULT_GRAPH_SETTINGS,
  groupColorFor,
  normalizeGraphSettings,
  parseGraphQuery,
} from "./graph-settings"

const graph = {
  nodes: [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
    { id: "lonely", label: "Lonely" },
    { id: "missing:Ghost", label: "Ghost", unresolved: true },
    { id: "missing:pic.png", label: "pic.png", unresolved: true },
  ],
  edges: [
    { source: "a", target: "b", label: "" },
    { source: "a", target: "missing:Ghost", label: "", unresolved: true },
    { source: "b", target: "missing:pic.png", label: "", unresolved: true },
  ],
}
const ids = (view: ReturnType<typeof buildGraphView>) => view.nodes.map((n) => n.id).sort()

describe("buildGraphView", () => {
  it("hides attachments by default and keeps notes, orphans and missing notes", () => {
    expect(ids(buildGraphView(graph, DEFAULT_GRAPH_SETTINGS))).toEqual([
      "a",
      "b",
      "lonely",
      "missing:Ghost",
    ])
  })

  it("applies the existing-only, orphan and attachment filters", () => {
    const view = buildGraphView(graph, {
      ...DEFAULT_GRAPH_SETTINGS,
      existingOnly: true,
      showOrphans: false,
      showAttachments: true,
    })
    expect(ids(view)).toEqual(["a", "b", "missing:pic.png"])
    expect(view.edges).toHaveLength(2)
  })

  it("adds tag nodes linked to their notes and drops tags without notes after search", () => {
    const tags = new Map([
      ["a", ["work"]],
      ["b", ["home"]],
    ])
    const view = buildGraphView(
      graph,
      { ...DEFAULT_GRAPH_SETTINGS, showTags: true, search: "alp" },
      tags,
    )
    expect(ids(view)).toEqual(["a", "tag:work"])
    expect(view.edges).toEqual([{ source: "a", target: "tag:work" }])
  })
})

describe("graph queries", () => {
  it("matches words, nested tags and paths", () => {
    const node = {
      id: "a",
      label: "Alpha note",
      kind: "note" as const,
      tags: ["project/amby"],
      path: "Work/Alpha note.md",
    }
    const groups = [
      { color: "#111111", terms: parseGraphQuery("tag:#other") },
      { color: "#222222", terms: parseGraphQuery("#project path:work alpha") },
    ]
    expect(groupColorFor(node, groups)).toBe("#222222")
    expect(parseGraphQuery("   ")).toBeNull()
  })
})

describe("normalizeGraphSettings", () => {
  it("clamps numbers and falls back for broken fields", () => {
    const settings = normalizeGraphSettings({
      nodeSize: 99,
      showTags: "yes",
      groups: [{ query: "x", color: "red" }, null],
    })
    expect(settings.nodeSize).toBe(5)
    expect(settings.showTags).toBe(false)
    expect(settings.groups).toHaveLength(1)
    expect(settings.groups[0].color).toMatch(/^#[0-9a-f]{6}$/iu)
  })
})
