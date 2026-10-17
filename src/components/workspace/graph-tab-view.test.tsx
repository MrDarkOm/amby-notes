// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { listTags } from "@/lib/storage"
import { GraphTabView } from "./graph-tab-view"
import { DEFAULT_GRAPH_SETTINGS } from "./graph/graph-settings"
import { useGraphSettingsStore } from "./graph/graph-settings-store"

vi.mock("@/lib/storage", () => ({ listTags: vi.fn(async () => []) }))

// The graph's own edges, not the lines drawn inside toolbar icons.
const EDGE_SELECTOR = "svg > g > line"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it("mounts SVG edges when graph topology changes after the initial render", async () => {
  vi.useFakeTimers()
  const nodes = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ]
  const onSelect = vi.fn()
  const initial = { nodes, edges: [{ source: "a", target: "b", label: "" }] }
  const { container, rerender } = render(
    <GraphTabView graph={initial} selectedId={null} onSelect={onSelect} />,
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(container.querySelectorAll(EDGE_SELECTOR).length).toBe(1)
  rerender(
    <GraphTabView
      graph={{
        nodes,
        edges: [...initial.edges, { source: "b", target: "c", label: "" }],
      }}
      selectedId={null}
      onSelect={onSelect}
    />,
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(container.querySelectorAll(EDGE_SELECTOR).length).toBe(2)
})

it("shows a clicked tag in the tags panel and opens a folder that a link names", async () => {
  vi.useFakeTimers()
  useGraphSettingsStore.setState({
    settings: { ...DEFAULT_GRAPH_SETTINGS, showTags: true },
    load: async () => {},
  })
  vi.mocked(listTags).mockResolvedValue([
    {
      tag: "work",
      notes: [{ id: "a", path: "/v/A.md", title: "A", modified: undefined, wordCount: 0 }],
    },
  ])
  const onSelect = vi.fn()
  const onTagClick = vi.fn()
  const { container } = render(
    <GraphTabView
      graph={{
        nodes: [
          { id: "a", label: "A" },
          { id: "missing:Projects", label: "Projects", unresolved: true },
        ],
        edges: [{ source: "a", target: "missing:Projects", label: "", unresolved: true }],
      }}
      vault="/v"
      treeItems={[
        { id: "a", path: "/v/A.md", name: "A", type: "file" },
        { id: "/v/Projects", path: "/v/Projects", name: "Projects", type: "folder", children: [] },
      ]}
      onSelect={onSelect}
      onTagClick={onTagClick}
    />,
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  const click = (id: string) => {
    const node = container.querySelector(`[data-node-id="${id}"]`)!
    fireEvent.pointerDown(node, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(container.querySelector("svg.amby-graph")!, {
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    })
  }
  click("tag:work")
  expect(onTagClick).toHaveBeenCalledWith("work")
  click("missing:Projects")
  expect(onSelect).toHaveBeenCalledWith("/v/Projects")
})
