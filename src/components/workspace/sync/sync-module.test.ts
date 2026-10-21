import { describe, expect, it } from "vitest"
import { moduleHost } from "@/lib/modules/host/module-host"
import { ModuleHost } from "@/lib/modules/host/module-host"
import "@/lib/modules/host/builtins"
import { STANDARD_MODULES } from "@/lib/modules/profiles"
import { findModule, isModuleAvailable, READY_MODULE_IDS } from "../modules"
import { STANDARD_PRESET } from "../presets"
import { SETTINGS_SECTION_IDS, isSettingsSectionId } from "../settings-navigation"
import { SYNC_MODULE_DEFINITION } from "./sync-module"

describe("the optional sync module", () => {
  it("is amby.sync, an official module that needs the network and the key store", () => {
    const { manifest } = SYNC_MODULE_DEFINITION
    expect(manifest.id).toBe("amby.sync")
    expect(manifest.kind).toBe("official")
    expect(manifest.permissions).toEqual(expect.arrayContaining(["network", "secrets.use"]))
    expect(manifest.contributions?.settings).toBe(true)
  })

  it("can be switched on in the settings but is off in every preset and profile", () => {
    // Р12: optional, off by default
    const entry = findModule("sync")
    expect(entry?.status).toBe("beta")
    expect(entry?.optIn).toBe(true)
    expect(isModuleAvailable("sync")).toBe(true)
    expect(STANDARD_PRESET.activeModules).not.toContain("sync")
    expect(READY_MODULE_IDS).not.toContain("sync")
    expect(STANDARD_MODULES).not.toContain("amby.sync")
  })

  it("is registered with the host and activates without a vault", async () => {
    expect(await moduleHost.activateModule("amby.sync", null)).toBe(true)
    expect(moduleHost.isModuleActive("amby.sync")).toBe(true)
    await moduleHost.deactivateModule("amby.sync")
    expect(moduleHost.isModuleActive("amby.sync")).toBe(false)
  })

  it("activates and deactivates cleanly on a host of its own", async () => {
    const host = new ModuleHost()
    host.registerModule(SYNC_MODULE_DEFINITION)
    expect(await host.activateModule("sync", null)).toBe(true)
    await host.deactivateModule("sync")
    expect(host.isModuleActive("sync")).toBe(false)
  })

  it("has a section of the settings of its own", () => {
    expect(SETTINGS_SECTION_IDS).toContain("sync")
    expect(isSettingsSectionId("sync")).toBe(true)
  })
})
