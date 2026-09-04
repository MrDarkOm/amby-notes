import { describe, expect, it } from "vitest"
import {
  settingsLabelKeyForActivityButton,
  settingsTargetForActivityButton,
} from "./settings-navigation"

describe("settingsTargetForActivityButton", () => {
  it("opens history directly in its module settings", () => {
    expect(settingsTargetForActivityButton("history")).toEqual({
      section: "modules",
      moduleId: "history",
    })
  })

  it("opens other module controls in their matching settings", () => {
    expect(settingsTargetForActivityButton("ai")).toEqual({ section: "modules", moduleId: "ai" })
    expect(settingsTargetForActivityButton("network")).toEqual({
      section: "modules",
      moduleId: "graph",
    })
  })

  it("uses a module-specific label when available", () => {
    expect(settingsLabelKeyForActivityButton("history")).toBe("activityBar.historySettings")
    expect(settingsLabelKeyForActivityButton("network")).toBe("activityBar.graphSettings")
    expect(settingsLabelKeyForActivityButton("tags")).toBe("activityBar.tagsSettings")
  })

  it("uses General for controls without dedicated settings", () => {
    expect(settingsTargetForActivityButton("refresh")).toEqual({ section: "general" })
  })
})
