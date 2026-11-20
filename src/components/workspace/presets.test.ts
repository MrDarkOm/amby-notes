import { describe, expect, it } from "vitest"

import { ACTION_DEFS, PERSISTENT_ACTION_BUTTONS } from "./panel-definitions"
import { availableModuleIds, findModule, isModuleAvailable, MODULE_REGISTRY } from "./modules"
import { STANDARD_MODULES } from "@/lib/modules/profiles"
import {
  mergeMissingButtons,
  SIMPLE_PRESET,
  STANDARD_PRESET,
  visibleLayout,
  type Preset,
} from "./presets"

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
      expect(STANDARD_PRESET.activeModules.includes(module.id)).toBe(
        module.status === "ready" && !module.optIn,
      )
    }
  })

  it("leaves the creative module out of the standard preset and profile", () => {
    expect(findModule("creative")?.status).toBe("ready")
    expect(STANDARD_PRESET.activeModules).not.toContain("creative")
    expect(STANDARD_MODULES).not.toContain("amby.creative")
    // Everything the preset turns on is also in the workspace profile.
    const profile = STANDARD_MODULES.map((id) => id.replace(/^amby\./u, ""))
    for (const id of STANDARD_PRESET.activeModules) expect(profile).toContain(id)
  })

  it("keeps the beta database module available without enabling it in new presets", () => {
    expect(isModuleAvailable("databases")).toBe(true)
    expect(availableModuleIds()).toContain("databases")
    expect(availableModuleIds({ databasesV1: true })).toContain("databases")
    expect(STANDARD_PRESET.activeModules).not.toContain("databases")
  })

  it("keeps the beta canvas module available without enabling it in the standard preset", () => {
    expect(isModuleAvailable("canvas")).toBe(true)
    expect(availableModuleIds()).toContain("canvas")
    expect(STANDARD_PRESET.activeModules).not.toContain("canvas")
  })

  it("does not expose unimplemented notification action, exposes help", () => {
    const ids = ACTION_DEFS.map((action) => action.id)
    expect(ids).not.toContain("notifications")
    expect(ids).toContain("help")
    expect(ACTION_DEFS.find((action) => action.id === "presets")?.invoke).toBeUndefined()
  })
})

describe("mergeMissingButtons", () => {
  const custom: Preset = {
    id: "custom-1",
    labelKey: "presets.custom",
    activeModules: ["tags", "graph", "daily"],
    layout: [],
    activeBySide: { left: "files", right: null },
  }
  const saved = [
    { defId: "files", side: "left" as const, order: 0 },
    { defId: "tags", side: "left" as const, order: 1 },
    { defId: "network", side: "left" as const, order: 2 },
  ]

  it("adds the button of an enabled module that a saved custom layout does not know", () => {
    const merged = mergeMissingButtons(saved, custom, custom.activeModules)
    expect(merged.map((button) => button.defId)).toContain("daily")
    expect(merged.find((button) => button.defId === "daily")?.side).toBe("left")
  })

  it("keeps a hidden button hidden and adds nothing for a switched-off module", () => {
    const hidden = [...saved, { defId: "daily", side: "left" as const, order: 3, hidden: true }]
    const merged = mergeMissingButtons(hidden, custom, custom.activeModules)
    expect(merged.filter((button) => button.defId === "daily")).toEqual([
      { defId: "daily", side: "left", order: 3, hidden: true },
    ])
    const without = mergeMissingButtons(saved, custom, ["tags", "graph"])
    expect(without.map((button) => button.defId)).not.toContain("daily")
  })
})
