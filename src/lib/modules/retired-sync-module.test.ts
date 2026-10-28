import { describe, expect, it } from "vitest"
import { ModuleHost } from "@/lib/modules/host/module-host"
import { moduleHost } from "@/lib/modules/host/module-host"
import "@/lib/modules/host/builtins"
import { MODULE_ID_MAP } from "@/lib/modules/types"
import { STANDARD_MODULES } from "@/lib/modules/profiles"
import { findModule, MODULE_REGISTRY } from "@/components/workspace/modules"
import { SETTINGS_SECTION_IDS } from "@/components/workspace/settings-navigation"

describe("sync is not a module", () => {
  it("has no module entry, no canonical id and no host definition", async () => {
    expect(findModule("sync")).toBeUndefined()
    expect(MODULE_REGISTRY.map((m) => m.id)).not.toContain("sync")
    expect(Object.values(MODULE_ID_MAP)).not.toContain("amby.sync")
    expect(STANDARD_MODULES).not.toContain("amby.sync")
    expect(await moduleHost.activateModule("amby.sync", null)).toBe(false)
  })

  it("keeps the Synchronization settings section", () => {
    expect(SETTINGS_SECTION_IDS).toContain("sync")
  })

  it("ignores amby.sync left in saved settings", async () => {
    const host = new ModuleHost()
    await expect(host.syncWithWorkspace(["amby.sync", "amby.tags"], null)).resolves.toBeUndefined()
    expect(host.isModuleActive("amby.sync")).toBe(false)
  })
})
