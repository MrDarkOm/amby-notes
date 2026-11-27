import { describe, expect, it } from "vitest"
import {
  computeSplitLayout,
  createInitialPaneLeaf,
  detectPaneDropZone,
  listPaneLeaves,
  reconcilePaneTree,
  removePaneLeaf,
  splitPaneLeaf,
  updateSplitRatio,
} from "./split-tree"

describe("split-tree model", () => {
  it("splits horizontally and vertically and computes flat layout rects and edge flags", () => {
    const root = createInitialPaneLeaf(["tab-1"], "tab-1", "pane-left")
    const middleLeaf = createInitialPaneLeaf(["tab-2"], "tab-2", "pane-mid")
    const rightTopLeaf = createInitialPaneLeaf(["tab-3"], "tab-3", "pane-right-top")
    const rightBottomLeaf = createInitialPaneLeaf(["tab-4"], "tab-4", "pane-right-bottom")

    const twoCols = splitPaneLeaf(root, "pane-left", "horizontal", "after", middleLeaf)
    const threeCols = splitPaneLeaf(twoCols, "pane-mid", "horizontal", "after", rightTopLeaf)
    const withRightVertical = splitPaneLeaf(
      threeCols,
      "pane-right-top",
      "vertical",
      "after",
      rightBottomLeaf,
    )

    const { leaves, dividers } = computeSplitLayout(withRightVertical)
    expect(leaves).toHaveLength(4)
    expect(dividers).toHaveLength(3)

    const byId = Object.fromEntries(leaves.map((item) => [item.leaf.id, item]))
    expect(byId["pane-left"].edges).toEqual({
      top: true,
      bottom: true,
      left: true,
      right: false,
    })
    expect(byId["pane-mid"].edges).toEqual({
      top: true,
      bottom: true,
      left: false,
      right: false,
    })
    expect(byId["pane-right-top"].edges).toEqual({
      top: true,
      bottom: false,
      left: false,
      right: true,
    })
    expect(byId["pane-right-bottom"].edges).toEqual({
      top: false,
      bottom: true,
      left: false,
      right: true,
    })
  })

  it("reconciles removed tabs and collapses empty split panes", () => {
    const root = createInitialPaneLeaf(["tab-1"], "tab-1", "pane-1")
    const leaf2 = createInitialPaneLeaf(["tab-2"], "tab-2", "pane-2")
    const tree = splitPaneLeaf(root, "pane-1", "horizontal", "after", leaf2)

    const reconciled = reconcilePaneTree(tree, ["tab-1"], "pane-2")
    const leaves = listPaneLeaves(reconciled.rootPane)
    expect(leaves).toHaveLength(1)
    expect(leaves[0].id).toBe("pane-1")
    expect(reconciled.activePaneId).toBe("pane-1")
    expect(reconciled.activeTabKey).toBe("tab-1")
  })

  it("clamps split ratios and removes leaves cleanly", () => {
    const root = createInitialPaneLeaf(["tab-1"], "tab-1", "pane-1")
    const leaf2 = createInitialPaneLeaf(["tab-2"], "tab-2", "pane-2")
    const tree = splitPaneLeaf(root, "pane-1", "horizontal", "after", leaf2)
    if (tree.type !== "split") throw new Error("Expected split node")

    const resized = updateSplitRatio(tree, tree.id, 0.99)
    expect(resized.type === "split" && resized.ratio).toBe(0.85)

    const afterRemove = removePaneLeaf(resized, "pane-2")
    expect(afterRemove).toEqual(root)
  })

  it("detects drop zones at edges and center", () => {
    const bounds = { left: 100, top: 100, width: 400, height: 300 }
    expect(detectPaneDropZone(120, 250, bounds)).toBe("left")
    expect(detectPaneDropZone(480, 250, bounds)).toBe("right")
    expect(detectPaneDropZone(300, 115, bounds)).toBe("top")
    expect(detectPaneDropZone(300, 385, bounds)).toBe("bottom")
    expect(detectPaneDropZone(300, 250, bounds)).toBe("center")
  })
})
