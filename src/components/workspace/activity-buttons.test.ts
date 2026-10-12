import { describe, expect, it } from "vitest"
import { collapseButtonsToLeft } from "./activity-buttons"
import type { ActivityButton } from "./panel-registry"

const button = (defId: string, side: "left" | "right", order: number): ActivityButton =>
  ({ defId, side, order }) as ActivityButton

describe("collapseButtonsToLeft", () => {
  it("puts the right buttons after the left ones, in their own order", () => {
    const stored = [
      button("files", "left", 0),
      button("tags", "left", 1),
      button("info", "right", 1),
      button("properties", "right", 0),
    ]
    const shown = collapseButtonsToLeft(stored)
    expect(shown.every((b) => b.side === "left")).toBe(true)
    const views = shown
      .filter((b) => ["files", "tags", "info", "properties"].includes(b.defId))
      .sort((a, b) => a.order - b.order)
    expect(views.map((b) => b.defId)).toEqual(["files", "tags", "properties", "info"])
    expect(new Set(views.map((b) => b.order)).size).toBe(views.length)
  })

  it("changes nothing in the stored list and returns it as is when nothing is on the right", () => {
    const stored = [button("files", "left", 0)]
    expect(collapseButtonsToLeft(stored)).toBe(stored)
    const withRight = [button("files", "left", 0), button("info", "right", 0)]
    collapseButtonsToLeft(withRight)
    expect(withRight[1].side).toBe("right")
  })
})
