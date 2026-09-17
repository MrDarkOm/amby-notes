import type { CanvasFlowNode } from "@/lib/canvas-format"

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export function getNodeRect(node: CanvasFlowNode): Rect {
  const w =
    (node.style?.width as number | undefined) ??
    (node.width as number | undefined) ??
    (node.measured?.width as number | undefined) ??
    240
  const h =
    (node.style?.height as number | undefined) ??
    (node.height as number | undefined) ??
    (node.measured?.height as number | undefined) ??
    120
  return {
    x: node.position.x,
    y: node.position.y,
    width: Number(w),
    height: Number(h),
  }
}

export type AlignmentType = "left" | "center" | "right" | "top" | "middle" | "bottom"
export type DistributionAxis = "horizontal" | "vertical"

export function alignNodes(
  allNodes: CanvasFlowNode[],
  selectedIds: Set<string>,
  type: AlignmentType,
): CanvasFlowNode[] {
  const targets = allNodes.filter((n) => selectedIds.has(n.id))
  if (targets.length < 2) return allNodes

  const rects = targets.map((n) => ({ node: n, rect: getNodeRect(n) }))

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const { rect } of rects) {
    if (rect.x < minX) minX = rect.x
    if (rect.x + rect.width > maxX) maxX = rect.x + rect.width
    if (rect.y < minY) minY = rect.y
    if (rect.y + rect.height > maxY) maxY = rect.y + rect.height
  }

  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2

  const updatedPositions = new Map<string, { x: number; y: number }>()

  for (const { node, rect } of rects) {
    let x = rect.x
    let y = rect.y

    switch (type) {
      case "left":
        x = minX
        break
      case "center":
        x = Math.round(centerX - rect.width / 2)
        break
      case "right":
        x = maxX - rect.width
        break
      case "top":
        y = minY
        break
      case "middle":
        y = Math.round(centerY - rect.height / 2)
        break
      case "bottom":
        y = maxY - rect.height
        break
    }
    updatedPositions.set(node.id, { x, y })
  }

  return allNodes.map((n) => {
    const pos = updatedPositions.get(n.id)
    return pos ? { ...n, position: pos } : n
  })
}

export function distributeNodes(
  allNodes: CanvasFlowNode[],
  selectedIds: Set<string>,
  axis: DistributionAxis,
): CanvasFlowNode[] {
  const targets = allNodes.filter((n) => selectedIds.has(n.id))
  if (targets.length < 3) return allNodes

  const rects = targets.map((n) => ({ node: n, rect: getNodeRect(n) }))

  if (axis === "horizontal") {
    rects.sort((a, b) => a.rect.x - b.rect.x)
    const first = rects[0]
    const last = rects[rects.length - 1]
    const totalSpan = last.rect.x - (first.rect.x + first.rect.width)
    let totalInnerWidths = 0
    for (let i = 1; i < rects.length - 1; i++) {
      totalInnerWidths += rects[i].rect.width
    }
    const gap = (totalSpan - totalInnerWidths) / (rects.length - 1)

    const updated = new Map<string, { x: number; y: number }>()
    let currentX = first.rect.x + first.rect.width + gap
    for (let i = 1; i < rects.length - 1; i++) {
      updated.set(rects[i].node.id, {
        x: Math.round(currentX),
        y: rects[i].rect.y,
      })
      currentX += rects[i].rect.width + gap
    }

    return allNodes.map((n) => {
      const pos = updated.get(n.id)
      return pos ? { ...n, position: pos } : n
    })
  } else {
    rects.sort((a, b) => a.rect.y - b.rect.y)
    const first = rects[0]
    const last = rects[rects.length - 1]
    const totalSpan = last.rect.y - (first.rect.y + first.rect.height)
    let totalInnerHeights = 0
    for (let i = 1; i < rects.length - 1; i++) {
      totalInnerHeights += rects[i].rect.height
    }
    const gap = (totalSpan - totalInnerHeights) / (rects.length - 1)

    const updated = new Map<string, { x: number; y: number }>()
    let currentY = first.rect.y + first.rect.height + gap
    for (let i = 1; i < rects.length - 1; i++) {
      updated.set(rects[i].node.id, {
        x: rects[i].rect.x,
        y: Math.round(currentY),
      })
      currentY += rects[i].rect.height + gap
    }

    return allNodes.map((n) => {
      const pos = updated.get(n.id)
      return pos ? { ...n, position: pos } : n
    })
  }
}

export interface SnapResult {
  x: number
  y: number
  verticalLine: number | null
  horizontalLine: number | null
}

export function snapPosition(activeRect: Rect, otherRects: Rect[], threshold = 6): SnapResult {
  let snappedX = activeRect.x
  let snappedY = activeRect.y
  let minDx = threshold + 1
  let minDy = threshold + 1
  let verticalLine: number | null = null
  let horizontalLine: number | null = null

  const activeLeft = activeRect.x
  const activeCenter = activeRect.x + activeRect.width / 2
  const activeRight = activeRect.x + activeRect.width

  const activeTop = activeRect.y
  const activeMiddle = activeRect.y + activeRect.height / 2
  const activeBottom = activeRect.y + activeRect.height

  for (const other of otherRects) {
    const oLeft = other.x
    const oCenter = other.x + other.width / 2
    const oRight = other.x + other.width

    // X alignment checks: Left-Left, Center-Center, Right-Right, Left-Right, Right-Left
    const xChecks = [
      { diff: oLeft - activeLeft, line: oLeft, newX: oLeft },
      { diff: oCenter - activeCenter, line: oCenter, newX: oCenter - activeRect.width / 2 },
      { diff: oRight - activeRight, line: oRight, newX: oRight - activeRect.width },
      { diff: oRight - activeLeft, line: oRight, newX: oRight },
      { diff: oLeft - activeRight, line: oLeft, newX: oLeft - activeRect.width },
    ]

    for (const check of xChecks) {
      const absDiff = Math.abs(check.diff)
      if (absDiff <= threshold && absDiff < minDx) {
        minDx = absDiff
        snappedX = Math.round(check.newX)
        verticalLine = check.line
      }
    }

    const oTop = other.y
    const oMiddle = other.y + other.height / 2
    const oBottom = other.y + other.height

    // Y alignment checks: Top-Top, Middle-Middle, Bottom-Bottom, Top-Bottom, Bottom-Top
    const yChecks = [
      { diff: oTop - activeTop, line: oTop, newY: oTop },
      { diff: oMiddle - activeMiddle, line: oMiddle, newY: oMiddle - activeRect.height / 2 },
      { diff: oBottom - activeBottom, line: oBottom, newY: oBottom - activeRect.height },
      { diff: oBottom - activeTop, line: oBottom, newY: oBottom },
      { diff: oTop - activeBottom, line: oTop, newY: oTop - activeRect.height },
    ]

    for (const check of yChecks) {
      const absDiff = Math.abs(check.diff)
      if (absDiff <= threshold && absDiff < minDy) {
        minDy = absDiff
        snappedY = Math.round(check.newY)
        horizontalLine = check.line
      }
    }
  }

  return {
    x: snappedX,
    y: snappedY,
    verticalLine,
    horizontalLine,
  }
}
