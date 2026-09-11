// @vitest-environment happy-dom
import * as React from "react"
import { act, cleanup, renderHook } from "@testing-library/react"
import { ReactFlowProvider } from "@xyflow/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushAutosaveGeneration } from "../autosave/autosave-lifecycle"
import { fromReactFlow, serializeCanvas, toReactFlow, type CanvasFile } from "@/lib/canvas-format"
import { useCanvasDocument } from "./use-canvas-document"
import * as canvasFormat from "@/lib/canvas-format"

const initial: CanvasFile = {
  nodes: [{ id: "n1", type: "text", x: 0, y: 0, width: 240, height: 120, text: "original" }],
  edges: [],
}
const flow = toReactFlow(initial)
const value = serializeCanvas(fromReactFlow(flow.nodes, flow.edges))
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ReactFlowProvider>{children}</ReactFlowProvider>
)

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("useCanvasDocument lifecycle", () => {
  it("does not reparse unchanged JSON on every drag frame", () => {
    const parsing = vi.spyOn(canvasFormat, "parseCanvas")
    const { result } = renderHook(
      () => useCanvasDocument({ value, onChange: vi.fn(), wrapRef: { current: null } }),
      { wrapper },
    )
    parsing.mockClear()
    for (let i = 1; i <= 20; i++) {
      act(() =>
        result.current.onNodesChange([
          { id: "n1", type: "position", position: { x: i, y: 0 }, dragging: true },
        ]),
      )
    }
    expect(parsing).not.toHaveBeenCalled()
  })

  it("publishes a pending canvas edit during a global flush", async () => {
    const onChange = vi.fn()
    const { result } = renderHook(
      () => useCanvasDocument({ value, onChange, wrapRef: { current: null } }),
      { wrapper },
    )
    act(() => result.current.updateNodeData("n1", { text: "latest unsaved edit" }))
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => {
      await flushAutosaveGeneration(1)
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(JSON.parse(onChange.mock.calls[0][0]).nodes[0].text).toBe("latest unsaved edit")
  })

  it("keeps bounded checkpoints during a long active drag", () => {
    const onChange = vi.fn()
    const { result } = renderHook(
      () => useCanvasDocument({ value, onChange, wrapRef: { current: null } }),
      { wrapper },
    )
    for (let i = 1; i <= 20; i++) {
      act(() =>
        result.current.onNodesChange([
          { id: "n1", type: "position", position: { x: i, y: 0 }, dragging: true },
        ]),
      )
      act(() => vi.advanceTimersByTime(250))
    }
    expect(onChange.mock.calls.length).toBeGreaterThan(0)
  })

  it("does not serialize every resize frame", () => {
    const serialization = vi.spyOn(canvasFormat, "serializeCanvas")
    const { result } = renderHook(
      () => useCanvasDocument({ value, onChange: vi.fn(), wrapRef: { current: null } }),
      { wrapper },
    )
    serialization.mockClear()
    for (let i = 1; i <= 20; i++) {
      act(() =>
        result.current.onNodesChange([
          {
            id: "n1",
            type: "dimensions",
            dimensions: { width: 240 + i, height: 120 },
            resizing: true,
            setAttributes: true,
          },
        ]),
      )
      act(() => vi.advanceTimersByTime(16))
    }
    expect(serialization.mock.calls.length).toBeLessThanOrEqual(1)
  })
})
