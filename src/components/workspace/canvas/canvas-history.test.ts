import { describe, expect, it } from "vitest"
import { CanvasHistory, type CanvasGraphSnapshot } from "./canvas-history"
import type { CanvasFlowNode } from "@/lib/canvas-format"

const makeNode = (id: string, x: number, y: number, text = "hello"): CanvasFlowNode => ({
  id,
  type: "text",
  position: { x, y },
  data: { text },
  width: 200,
  height: 100,
})

describe("CanvasHistory", () => {
  it("initializes with initial snapshot", () => {
    const initial: CanvasGraphSnapshot = {
      nodes: [makeNode("n1", 0, 0)],
      edges: [],
    }
    const history = new CanvasHistory(initial)
    expect(history.canUndo()).toBe(false)
    expect(history.canRedo()).toBe(false)
    expect(history.getCurrent().nodes).toHaveLength(1)
  })

  it("pushes a new state and supports undo/redo", () => {
    const initial: CanvasGraphSnapshot = {
      nodes: [makeNode("n1", 0, 0)],
      edges: [],
    }
    const history = new CanvasHistory(initial)

    const step1: CanvasGraphSnapshot = {
      nodes: [makeNode("n1", 100, 50)],
      edges: [],
    }
    expect(history.push(step1)).toBe(true)
    expect(history.canUndo()).toBe(true)
    expect(history.canRedo()).toBe(false)

    const undone = history.undo()
    expect(undone).not.toBeNull()
    expect(undone!.nodes[0].position.x).toBe(0)
    expect(history.canUndo()).toBe(false)
    expect(history.canRedo()).toBe(true)

    const redone = history.redo()
    expect(redone).not.toBeNull()
    expect(redone!.nodes[0].position.x).toBe(100)
    expect(history.canUndo()).toBe(true)
    expect(history.canRedo()).toBe(false)
  })

  it("ignores pushes without meaningful changes", () => {
    const initial: CanvasGraphSnapshot = {
      nodes: [makeNode("n1", 0, 0)],
      edges: [],
    }
    const history = new CanvasHistory(initial)
    // Same content
    expect(history.push({ nodes: [makeNode("n1", 0, 0)], edges: [] })).toBe(false)
    expect(history.canUndo()).toBe(false)
  })

  it("respects max history depth", () => {
    const history = new CanvasHistory({ nodes: [], edges: [] }, 3)
    history.push({ nodes: [makeNode("1", 1, 1)], edges: [] })
    history.push({ nodes: [makeNode("2", 2, 2)], edges: [] })
    history.push({ nodes: [makeNode("3", 3, 3)], edges: [] })
    history.push({ nodes: [makeNode("4", 4, 4)], edges: [] })

    // Max depth is 3 past states
    expect(history.undo()?.nodes[0].id).toBe("3")
    expect(history.undo()?.nodes[0].id).toBe("2")
    expect(history.undo()?.nodes[0].id).toBe("1")
    expect(history.undo()).toBeNull()
  })
})
