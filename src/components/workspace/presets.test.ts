import { describe, expect, it } from "vitest"

import { ACTION_DEFS, PERSISTENT_ACTION_BUTTONS } from "./panel-definitions"
import { availableModuleIds, isModuleAvailable, MODULE_REGISTRY } from "./modules"
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

  it("keeps preview modules discoverable but disabled in the standard preset", () => {
    for (const module of MODULE_REGISTRY) {
      expect(STANDARD_PRESET.activeModules.includes(module.id)).toBe(module.status === "ready")
    }
  })

  it("keeps the released database module available without the legacy gate", () => {
    expect(isModuleAvailable("databases")).toBe(true)
    expect(availableModuleIds()).toContain("databases")
    expect(availableModuleIds({ databasesV1: true })).toContain("databases")
    expect(STANDARD_PRESET.activeModules).toContain("databases")
  })

  it("does not expose unimplemented notification or help actions", () => {
    const ids = ACTION_DEFS.map((action) => action.id)
    expect(ids).not.toContain("notifications")
    expect(ids).not.toContain("help")
    expect(ACTION_DEFS.find((action) => action.id === "presets")?.invoke).toBeUndefined()
  })
})
