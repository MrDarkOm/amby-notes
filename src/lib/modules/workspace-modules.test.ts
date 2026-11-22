import { describe, expect, it } from "vitest"
import {
  applyProfileToWorkspace,
  disableModuleInWorkspace,
  enableModuleInWorkspace,
  isModuleEnabledInWorkspace,
  readWorkspaceModuleConfig,
  STANDARD_MODULES,
} from "./workspace-modules"
import { toCanonicalModuleId, toShortModuleId } from "./types"

describe("Module ID mappings", () => {
  it("maps short IDs to canonical IDs and back", () => {
    expect(toCanonicalModuleId("tags")).toBe("amby.tags")
    expect(toCanonicalModuleId("amby.tags")).toBe("amby.tags")
    expect(toShortModuleId("amby.tags")).toBe("tags")
    expect(toShortModuleId("tags")).toBe("tags")

    expect(toCanonicalModuleId("excalidraw")).toBe("amby.excalidraw")
    expect(toCanonicalModuleId("canvas")).toBe("amby.canvas")
    expect(toCanonicalModuleId("creative")).toBe("amby.creative")
    expect(toShortModuleId("amby.creative")).toBe("creative")
  })
})

describe("Workspace Modules Management", () => {
  it("enables and disables modules correctly", () => {
    const initial = applyProfileToWorkspace("minimal")
    expect(initial.enabledModules).toEqual([])
    expect(isModuleEnabledInWorkspace("tags", initial)).toBe(false)

    const withTags = enableModuleInWorkspace("tags", initial)
    expect(withTags.enabledModules).toEqual(["amby.tags"])
    expect(isModuleEnabledInWorkspace("tags", withTags)).toBe(true)
    expect(isModuleEnabledInWorkspace("amby.tags", withTags)).toBe(true)

    // Enabling again is idempotent
    const withTagsAgain = enableModuleInWorkspace("amby.tags", withTags)
    expect(withTagsAgain.enabledModules).toEqual(["amby.tags"])

    const disabled = disableModuleInWorkspace("tags", withTags)
    expect(disabled.enabledModules).toEqual([])
    expect(isModuleEnabledInWorkspace("tags", disabled)).toBe(false)
  })

  it("applies standard profile", () => {
    const standard = applyProfileToWorkspace("standard")
    expect(standard.profile.id).toBe("standard")
    expect(standard.enabledModules).toEqual(STANDARD_MODULES)
  })

  it("applies minimal profile", () => {
    const minimal = applyProfileToWorkspace("minimal")
    expect(minimal.profile.id).toBe("minimal")
    expect(minimal.enabledModules).toEqual([])
  })
})

describe("Reading the workspace module configuration", () => {
  it("reads a stored profile and canonicalises module ids", () => {
    const config = readWorkspaceModuleConfig({
      profile: { id: "standard", catalogRevision: "2026-11-20" },
      enabledModules: ["tags", "amby.favorites"],
      moduleSettings: { tags: { a: 1 } },
    })
    expect(config.profile.id).toBe("standard")
    expect(config.enabledModules).toEqual(["amby.tags", "amby.favorites", "amby.supernotes"])
    expect(config.moduleSettings).toEqual({ tags: { a: 1 } })
  })

  it("adds Templates once to a list saved before it, and Daily notes stay opt-in", () => {
    const old = readWorkspaceModuleConfig({
      profile: { id: "custom", catalogRevision: "2026-09-20" },
      enabledModules: ["tags"],
    })
    expect(old.enabledModules).toEqual(["amby.tags", "amby.templates", "amby.supernotes"])
    expect(old.profile.catalogRevision).toBe("2026-11-21")
    // Saved again with the new revision, a switched-off module stays off.
    const current = readWorkspaceModuleConfig({
      profile: { id: "custom", catalogRevision: old.profile.catalogRevision },
      enabledModules: ["amby.tags", "amby.daily"],
    })
    expect(current.enabledModules).toEqual(["amby.tags", "amby.daily"])
    const minimal = readWorkspaceModuleConfig({
      profile: { id: "minimal", catalogRevision: "2026-09-20" },
      enabledModules: [],
    })
    expect(minimal.enabledModules).toEqual([])
  })

  it("lists Templates in the Standard set, keeps Daily notes opt-in and maps their IDs", () => {
    expect(STANDARD_MODULES).toContain("amby.templates")
    expect(STANDARD_MODULES).not.toContain("amby.daily")
    expect(toCanonicalModuleId("daily")).toBe("amby.daily")
    expect(toShortModuleId("amby.templates")).toBe("templates")
  })

  it("falls back to the standard profile when there is no profile or module list", () => {
    const config = readWorkspaceModuleConfig({ layout: { activePresetId: "simple" } } as never)
    expect(config.profile.id).toBe("standard")
    expect(config.enabledModules).toEqual(STANDARD_MODULES)
  })
})
