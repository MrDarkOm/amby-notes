export type SplitDirection = "horizontal" | "vertical"
export type PaneDropZone = "left" | "right" | "top" | "bottom" | "center"

export interface PaneLeafNode {
  type: "leaf"
  id: string
  tabKeys: string[]
  activeTabKey: string
}

export interface PaneSplitNode {
  type: "split"
  id: string
  direction: SplitDirection
  /** Fraction allocated to `first` (clamped to [MIN_SPLIT_RATIO, MAX_SPLIT_RATIO]). */
  ratio: number
  first: PaneNode
  second: PaneNode
}

export type PaneNode = PaneLeafNode | PaneSplitNode

export interface PaneRect {
  /** Percentage 0..100 */
  x: number
  /** Percentage 0..100 */
  y: number
  /** Percentage 0..100 */
  w: number
  /** Percentage 0..100 */
  h: number
}

export interface PaneEdgeFlags {
  top: boolean
  bottom: boolean
  left: boolean
  right: boolean
}

export interface LayoutLeafItem {
  leaf: PaneLeafNode
  rect: PaneRect
  edges: PaneEdgeFlags
}

export interface LayoutSplitDivider {
  splitId: string
  direction: SplitDirection
  ratio: number
  /** Position along the split axis in percentage (0..100). */
  position: number
  /** Start along the perpendicular axis in percentage (0..100). */
  crossStart: number
  /** Length along the perpendicular axis in percentage (0..100). */
  crossLength: number
  parentRect: PaneRect
}

export const MIN_SPLIT_RATIO = 0.15
export const MAX_SPLIT_RATIO = 0.85
export const DEFAULT_PANE_ID = "pane-root"

let nextPaneCounter = 1

export function newPaneId(prefix = "pane"): string {
  nextPaneCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${nextPaneCounter.toString(36)}`
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))
}

export function createInitialPaneLeaf(
  tabKeys: string[] = [],
  activeTabKey = "",
  id = DEFAULT_PANE_ID,
): PaneLeafNode {
  const resolvedActive =
    activeTabKey && tabKeys.includes(activeTabKey)
      ? activeTabKey
      : (tabKeys[tabKeys.length - 1] ?? "")
  return {
    type: "leaf",
    id,
    tabKeys: [...tabKeys],
    activeTabKey: resolvedActive,
  }
}

export function listPaneLeaves(node: PaneNode): PaneLeafNode[] {
  if (node.type === "leaf") return [node]
  return [...listPaneLeaves(node.first), ...listPaneLeaves(node.second)]
}

export function findPaneLeaf(node: PaneNode, paneId: string): PaneLeafNode | null {
  if (node.type === "leaf") return node.id === paneId ? node : null
  return findPaneLeaf(node.first, paneId) ?? findPaneLeaf(node.second, paneId)
}

export function findPaneLeafByTabKey(node: PaneNode, tabKey: string): PaneLeafNode | null {
  if (node.type === "leaf") return node.tabKeys.includes(tabKey) ? node : null
  return findPaneLeafByTabKey(node.first, tabKey) ?? findPaneLeafByTabKey(node.second, tabKey)
}

export function updatePaneLeaf(
  node: PaneNode,
  paneId: string,
  updater: (leaf: PaneLeafNode) => PaneLeafNode,
): PaneNode {
  if (node.type === "leaf") {
    return node.id === paneId ? updater(node) : node
  }
  const first = updatePaneLeaf(node.first, paneId, updater)
  const second = updatePaneLeaf(node.second, paneId, updater)
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

export function updateSplitRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (node.type === "leaf") return node
  if (node.id === splitId) {
    return { ...node, ratio: clampSplitRatio(ratio) }
  }
  const first = updateSplitRatio(node.first, splitId, ratio)
  const second = updateSplitRatio(node.second, splitId, ratio)
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

/**
 * Replaces a leaf with a split containing the leaf and `newLeaf`.
 */
export function splitPaneLeaf(
  node: PaneNode,
  targetPaneId: string,
  direction: SplitDirection,
  placement: "before" | "after",
  newLeaf: PaneLeafNode,
  updatedTargetLeaf?: PaneLeafNode,
): PaneNode {
  if (node.type === "leaf") {
    if (node.id !== targetPaneId) return node
    const existingLeaf = updatedTargetLeaf ?? node
    return {
      type: "split",
      id: newPaneId("split"),
      direction,
      ratio: 0.5,
      first: placement === "before" ? newLeaf : existingLeaf,
      second: placement === "before" ? existingLeaf : newLeaf,
    }
  }
  const first = splitPaneLeaf(
    node.first,
    targetPaneId,
    direction,
    placement,
    newLeaf,
    updatedTargetLeaf,
  )
  const second = splitPaneLeaf(
    node.second,
    targetPaneId,
    direction,
    placement,
    newLeaf,
    updatedTargetLeaf,
  )
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

/**
 * Removes a leaf by id, promoting its sibling. If the root itself is the target
 * leaf, returns an empty leaf with the same id.
 */
export function removePaneLeaf(node: PaneNode, targetPaneId: string): PaneNode {
  if (node.type === "leaf") {
    return node.id === targetPaneId ? { ...node, tabKeys: [], activeTabKey: "" } : node
  }
  if (node.first.type === "leaf" && node.first.id === targetPaneId) {
    return node.second
  }
  if (node.second.type === "leaf" && node.second.id === targetPaneId) {
    return node.first
  }
  const first = removePaneLeaf(node.first, targetPaneId)
  const second = removePaneLeaf(node.second, targetPaneId)
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

/**
 * Collapses empty leaves when there are other non-empty leaves in the tree.
 */
function collapseEmptyLeaves(node: PaneNode): PaneNode {
  if (node.type === "leaf") return node
  const first = collapseEmptyLeaves(node.first)
  const second = collapseEmptyLeaves(node.second)
  const firstEmpty = first.type === "leaf" && first.tabKeys.length === 0
  const secondEmpty = second.type === "leaf" && second.tabKeys.length === 0
  if (firstEmpty && !secondEmpty) return second
  if (secondEmpty && !firstEmpty) return first
  if (firstEmpty && secondEmpty) return first
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

/**
 * Keeps the pane tree consistent with the master `validTabKeys` list:
 * - removes deleted tab keys from leaves
 * - appends newly opened tab keys to the active leaf
 * - collapses empty split leaves
 * - ensures every leaf and the workspace have valid active keys
 */
export function reconcilePaneTree(
  root: PaneNode,
  validTabKeys: readonly string[],
  activePaneId: string,
  preferredActiveTabKey?: string,
): {
  rootPane: PaneNode
  activePaneId: string
  activeTabKey: string
} {
  const validSet = new Set(validTabKeys)

  if (validTabKeys.length === 0) {
    const firstLeaf = listPaneLeaves(root)[0]
    const leafId = firstLeaf?.id ?? DEFAULT_PANE_ID
    return {
      rootPane: createInitialPaneLeaf([], "", leafId),
      activePaneId: leafId,
      activeTabKey: "",
    }
  }

  const assigned = new Set<string>()
  const pruneNode = (node: PaneNode): PaneNode => {
    if (node.type === "leaf") {
      const tabKeys = node.tabKeys.filter((key) => {
        if (!validSet.has(key) || assigned.has(key)) return false
        assigned.add(key)
        return true
      })
      const activeTabKey = tabKeys.includes(node.activeTabKey)
        ? node.activeTabKey
        : (tabKeys[tabKeys.length - 1] ?? "")
      return {
        ...node,
        tabKeys,
        activeTabKey,
      }
    }
    return {
      ...node,
      first: pruneNode(node.first),
      second: pruneNode(node.second),
    }
  }

  let nextRoot = pruneNode(root)
  const unassigned = validTabKeys.filter((key) => !assigned.has(key))

  if (unassigned.length > 0) {
    const targetLeaf = findPaneLeaf(nextRoot, activePaneId) ?? listPaneLeaves(nextRoot)[0]
    if (targetLeaf) {
      nextRoot = updatePaneLeaf(nextRoot, targetLeaf.id, (leaf) => {
        const merged = [...leaf.tabKeys, ...unassigned]
        const nextActive =
          preferredActiveTabKey && merged.includes(preferredActiveTabKey)
            ? preferredActiveTabKey
            : leaf.activeTabKey && merged.includes(leaf.activeTabKey)
              ? leaf.activeTabKey
              : (merged[merged.length - 1] ?? "")
        return {
          ...leaf,
          tabKeys: merged,
          activeTabKey: nextActive,
        }
      })
    }
  }

  nextRoot = collapseEmptyLeaves(nextRoot)

  // If preferredActiveTabKey was explicitly provided, ensure its containing leaf selects it.
  if (preferredActiveTabKey && validSet.has(preferredActiveTabKey)) {
    const currentActiveLeaf = findPaneLeaf(nextRoot, activePaneId)
    const targetLeaf =
      currentActiveLeaf && currentActiveLeaf.tabKeys.includes(preferredActiveTabKey)
        ? currentActiveLeaf
        : findPaneLeafByTabKey(nextRoot, preferredActiveTabKey)
    if (targetLeaf) {
      activePaneId = targetLeaf.id
      if (targetLeaf.activeTabKey !== preferredActiveTabKey) {
        nextRoot = updatePaneLeaf(nextRoot, targetLeaf.id, (leaf) => ({
          ...leaf,
          activeTabKey: preferredActiveTabKey,
        }))
      }
    }
  }

  const leaves = listPaneLeaves(nextRoot)
  const activeLeaf = findPaneLeaf(nextRoot, activePaneId) ?? leaves[0]
  const resolvedActivePaneId = activeLeaf?.id ?? DEFAULT_PANE_ID
  const resolvedActiveTabKey = activeLeaf?.activeTabKey ?? validTabKeys[0] ?? ""

  return {
    rootPane: nextRoot,
    activePaneId: resolvedActivePaneId,
    activeTabKey: resolvedActiveTabKey,
  }
}

/**
 * Computes percentage bounding rects for all leaves and dividers so leaves can
 * be rendered in a flat list without remounting when split depth changes.
 */
export function computeSplitLayout(root: PaneNode): {
  leaves: LayoutLeafItem[]
  dividers: LayoutSplitDivider[]
} {
  const leaves: LayoutLeafItem[] = []
  const dividers: LayoutSplitDivider[] = []

  function visit(node: PaneNode, rect: PaneRect, edges: PaneEdgeFlags) {
    if (node.type === "leaf") {
      leaves.push({ leaf: node, rect, edges })
      return
    }
    const r = clampSplitRatio(node.ratio)
    if (node.direction === "horizontal") {
      const firstW = rect.w * r
      const secondW = rect.w - firstW
      const splitX = rect.x + firstW
      dividers.push({
        splitId: node.id,
        direction: "horizontal",
        ratio: r,
        position: splitX,
        crossStart: rect.y,
        crossLength: rect.h,
        parentRect: rect,
      })
      visit(node.first, { x: rect.x, y: rect.y, w: firstW, h: rect.h }, { ...edges, right: false })
      visit(node.second, { x: splitX, y: rect.y, w: secondW, h: rect.h }, { ...edges, left: false })
    } else {
      const firstH = rect.h * r
      const secondH = rect.h - firstH
      const splitY = rect.y + firstH
      dividers.push({
        splitId: node.id,
        direction: "vertical",
        ratio: r,
        position: splitY,
        crossStart: rect.x,
        crossLength: rect.w,
        parentRect: rect,
      })
      visit(node.first, { x: rect.x, y: rect.y, w: rect.w, h: firstH }, { ...edges, bottom: false })
      visit(node.second, { x: rect.x, y: splitY, w: rect.w, h: secondH }, { ...edges, top: false })
    }
  }

  visit(root, { x: 0, y: 0, w: 100, h: 100 }, { top: true, bottom: true, left: true, right: true })

  return { leaves, dividers }
}

/**
 * Determines which drop zone inside a pane rect a pointer (clientX, clientY) hits.
 */
export function detectPaneDropZone(
  clientX: number,
  clientY: number,
  paneBounds: { left: number; top: number; width: number; height: number },
): PaneDropZone {
  const { left, top, width, height } = paneBounds
  if (width <= 0 || height <= 0) return "center"
  const relX = (clientX - left) / width
  const relY = (clientY - top) / height
  const edgeThreshold = 0.24

  const distLeft = relX
  const distRight = 1 - relX
  const distTop = relY
  const distBottom = 1 - relY
  const minDist = Math.min(distLeft, distRight, distTop, distBottom)

  if (minDist > edgeThreshold) return "center"
  if (minDist === distLeft) return "left"
  if (minDist === distRight) return "right"
  if (minDist === distTop) return "top"
  return "bottom"
}
