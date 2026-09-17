import type { Edge } from "@xyflow/react"
import type { CanvasFlowNode } from "@/lib/canvas-format"

export interface CanvasGraphSnapshot {
  nodes: CanvasFlowNode[]
  edges: Edge[]
}

export class CanvasHistory {
  private past: CanvasGraphSnapshot[] = []
  private future: CanvasGraphSnapshot[] = []
  private current: CanvasGraphSnapshot
  private maxDepth: number

  constructor(initial: CanvasGraphSnapshot, maxDepth = 60) {
    this.current = this.cloneSnapshot(initial)
    this.maxDepth = maxDepth
  }

  private cloneSnapshot(snapshot: CanvasGraphSnapshot): CanvasGraphSnapshot {
    return {
      nodes: snapshot.nodes.map((n) => ({
        ...n,
        position: { ...n.position },
        data: { ...n.data },
        style: n.style ? { ...n.style } : undefined,
      })),
      edges: snapshot.edges.map((e) => ({
        ...e,
        data: e.data ? { ...e.data } : undefined,
        style: e.style ? { ...e.style } : undefined,
      })),
    }
  }

  private hasMeaningfulChange(a: CanvasGraphSnapshot, b: CanvasGraphSnapshot): boolean {
    if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return true
    for (let i = 0; i < a.nodes.length; i++) {
      const na = a.nodes[i]
      const nb = b.nodes[i]
      if (
        na.id !== nb.id ||
        na.position.x !== nb.position.x ||
        na.position.y !== nb.position.y ||
        na.width !== nb.width ||
        na.height !== nb.height ||
        na.type !== nb.type ||
        na.zIndex !== nb.zIndex ||
        JSON.stringify(na.data) !== JSON.stringify(nb.data)
      ) {
        return true
      }
    }
    for (let i = 0; i < a.edges.length; i++) {
      const ea = a.edges[i]
      const eb = b.edges[i]
      if (
        ea.id !== eb.id ||
        ea.source !== eb.source ||
        ea.target !== eb.target ||
        ea.sourceHandle !== eb.sourceHandle ||
        ea.targetHandle !== eb.targetHandle ||
        ea.label !== eb.label ||
        JSON.stringify(ea.data) !== JSON.stringify(eb.data)
      ) {
        return true
      }
    }
    return false
  }

  public push(snapshot: CanvasGraphSnapshot): boolean {
    if (!this.hasMeaningfulChange(this.current, snapshot)) {
      return false
    }
    this.past.push(this.current)
    if (this.past.length > this.maxDepth) {
      this.past.shift()
    }
    this.current = this.cloneSnapshot(snapshot)
    this.future = []
    return true
  }

  public undo(): CanvasGraphSnapshot | null {
    if (this.past.length === 0) return null
    const previous = this.past.pop()!
    this.future.unshift(this.current)
    this.current = previous
    return this.cloneSnapshot(this.current)
  }

  public redo(): CanvasGraphSnapshot | null {
    if (this.future.length === 0) return null
    const next = this.future.shift()!
    this.past.push(this.current)
    this.current = next
    return this.cloneSnapshot(this.current)
  }

  public canUndo(): boolean {
    return this.past.length > 0
  }

  public canRedo(): boolean {
    return this.future.length > 0
  }

  public getCurrent(): CanvasGraphSnapshot {
    return this.cloneSnapshot(this.current)
  }

  public reset(snapshot: CanvasGraphSnapshot): void {
    this.current = this.cloneSnapshot(snapshot)
    this.past = []
    this.future = []
  }
}
