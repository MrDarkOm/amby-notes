import { describe, expect, it } from "vitest"

import { PERSISTENT_ACTION_BUTTONS } from "./panel-definitions"
import { SIMPLE_PRESET, STANDARD_PRESET, visibleLayout } from "./presets"

describe("preset activity zones", () => {
  it("keeps global actions available in the minimal preset", () => {
    const ids = visibleLayout(SIMPLE_PRESET).map((button) => button.defId)

    expect(ids).toContain("files")
    expect(ids).toContain("search")
    for (const action of PERSISTENT_ACTION_BUTTONS) expect(ids).toContain(action.defId)
  })

  it("does not duplicate persistent actions in the standard preset", () => {
    const ids = visibleLayout(STANDARD_PRESET).map((button) => button.defId)

    for (const action of PERSISTENT_ACTION_BUTTONS) {
      expect(ids.filter((id) => id === action.defId)).toHaveLength(1)
    }
  })
})
