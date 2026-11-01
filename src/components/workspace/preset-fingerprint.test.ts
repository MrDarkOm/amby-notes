import { describe, expect, it } from "vitest"

import type { ActivityButton } from "./panel-registry"
import { presetFingerprint } from "./presets"

const dock: ActivityButton[] = [
  { defId: "files", side: "left", order: 0 },
  { defId: "tags", side: "left", order: 1 },
  { defId: "info", side: "right", order: 0 },
]

describe("presetFingerprint", () => {
  it("ignores order numbers and module id spelling", () => {
    const renumbered = dock.map((button, index) => ({ ...button, order: index * 10 }))
    expect(presetFingerprint(["amby.tags"], renumbered)).toBe(presetFingerprint(["tags"], dock))
  })

  it("sees a moved, hidden or added button and a different module set", () => {
    const base = presetFingerprint(["tags"], dock)
    expect(presetFingerprint(["tags"], [dock[1], { ...dock[0], order: 5 }, dock[2]])).not.toBe(base)
    expect(presetFingerprint(["tags"], [{ ...dock[0], hidden: true }, dock[1], dock[2]])).not.toBe(
      base,
    )
    expect(presetFingerprint(["tags", "links"], dock)).not.toBe(base)
  })

  it("never counts the favorites button, which its own setting governs", () => {
    const withFavorites = [...dock, { defId: "favorites", side: "left" as const, order: 2 }]
    const hidden = withFavorites.map((b) => (b.defId === "favorites" ? { ...b, hidden: true } : b))
    expect(presetFingerprint([], hidden)).toBe(presetFingerprint([], withFavorites))
  })
})
