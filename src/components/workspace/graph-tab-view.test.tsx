// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { GraphTabView } from "./graph-tab-view"

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
  expect(container.querySelectorAll("line").length).toBe(1)
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
  expect(container.querySelectorAll("line").length).toBe(2)
})
