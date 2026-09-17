import type { Edge } from "@xyflow/react"
import type { CanvasFlowNode } from "@/lib/canvas-format"
import { getNodeRect } from "./canvas-alignment"

export interface LayoutOptions {
  direction?: "TB" | "LR"
  gapX?: number
  gapY?: number
  selectedOnly?: boolean
}

export function computeAutoLayout(
  allNodes: CanvasFlowNode[],
  allEdges: Edge[],
  options: LayoutOptions = {},
): CanvasFlowNode[] {
  const { direction = "TB", gapX = 48, gapY = 64, selectedOnly = false } = options

  const targetNodes = selectedOnly ? allNodes.filter((n) => n.selected) : allNodes
  if (targetNodes.length <= 1) return allNodes

  const targetIds = new Set(targetNodes.map((n) => n.id))
  // Relevant edges where both endpoints are in targetIds
  const edges = allEdges.filter((e) => targetIds.has(e.source) && targetIds.has(e.target))

  // In-degree and adjacency
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const n of targetNodes) {
    inDegree.set(n.id, 0)
    adj.set(n.id, [])
  }
  for (const e of edges) {
    if (e.source !== e.target) {
      adj.get(e.source)?.push(e.target)
      inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
    }
  }

  // Calculate ranks (levels) via topological sort / longest path
  const ranks = new Map<string, number>()
  const queue: string[] = []
  for (const n of targetNodes) {
    if ((inDegree.get(n.id) ?? 0) === 0) {
      ranks.set(n.id, 0)
      queue.push(n.id)
    }
  }

  // If there's a cycle and no zero-indegree nodes, seed with first node
  if (queue.length === 0 && targetNodes.length > 0) {
    ranks.set(targetNodes[0].id, 0)
    queue.push(targetNodes[0].id)
  }

  const visited = new Set<string>()
  while (queue.length > 0) {
    const curr = queue.shift()!
    visited.add(curr)
    const currentRank = ranks.get(curr) ?? 0
    const neighbors = adj.get(curr) ?? []
    for (const neighbor of neighbors) {
      const existingRank = ranks.get(neighbor) ?? -1
      if (currentRank + 1 > existingRank) {
        ranks.set(neighbor, currentRank + 1)
      }
      if (!visited.has(neighbor)) {
        queue.push(neighbor)
      }
    }
  }

  // Any remaining unvisited nodes (disconnected components) get rank 0
  for (const n of targetNodes) {
    if (!ranks.has(n.id)) {
      ranks.set(n.id, 0)
    }
  }

  // Group nodes by rank
  const rankGroups = new Map<number, CanvasFlowNode[]>()
  for (const n of targetNodes) {
    const r = ranks.get(n.id) ?? 0
    if (!rankGroups.has(r)) rankGroups.set(r, [])
    rankGroups.get(r)!.push(n)
  }

  const sortedRanks = Array.from(rankGroups.keys()).sort((a, b) => a - b)

  // Find minX, minY of original target nodes to anchor layout in place
  let originX = Infinity
  let originY = Infinity
  for (const n of targetNodes) {
    if (n.position.x < originX) originX = n.position.x
    if (n.position.y < originY) originY = n.position.y
  }

  const newPositions = new Map<string, { x: number; y: number }>()

  if (direction === "TB") {
    // Top-to-Bottom: ranks along Y, siblings along X
    let currentY = originY
    for (const r of sortedRanks) {
      const nodesInRank = rankGroups.get(r)!
      const rects = nodesInRank.map((n) => ({ node: n, rect: getNodeRect(n) }))
      const totalWidth =
        rects.reduce((acc, { rect }) => acc + rect.width, 0) + (rects.length - 1) * gapX
      const maxHeight = Math.max(...rects.map(({ rect }) => rect.height))

      let currentX = originX - totalWidth / 2
      for (const { node, rect } of rects) {
        newPositions.set(node.id, {
          x: Math.round(currentX),
          y: Math.round(currentY),
        })
        currentX += rect.width + gapX
      }
      currentY += maxHeight + gapY
    }
  } else {
    // Left-to-Right: ranks along X, siblings along Y
    let currentX = originX
    for (const r of sortedRanks) {
      const nodesInRank = rankGroups.get(r)!
      const rects = nodesInRank.map((n) => ({ node: n, rect: getNodeRect(n) }))
      const totalHeight =
        rects.reduce((acc, { rect }) => acc + rect.height, 0) + (rects.length - 1) * gapY
      const maxWidth = Math.max(...rects.map(({ rect }) => rect.width))

      let currentY = originY - totalHeight / 2
      for (const { node, rect } of rects) {
        newPositions.set(node.id, {
          x: Math.round(currentX),
          y: Math.round(currentY),
        })
        currentY += rect.height + gapY
      }
      currentX += maxWidth + gapX
    }
  }

  return allNodes.map((n) => {
    const pos = newPositions.get(n.id)
    return pos ? { ...n, position: pos } : n
  })
}
