import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  installBuiltinModule,
  isBuiltinModuleId,
  loadGlobalModulesRegistry,
  uninstallModule,
} from "./index"

describe("installing a module that ships with the application", () => {
  const store = new Map<string, string>()

  beforeEach(() => {
    store.clear()
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      get length() {
        return store.size
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
    })
    // Nothing may be downloaded.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("no network expected"))),
    )
  })

  it("brings an uninstalled built-in module back without a download", async () => {
    expect(isBuiltinModuleId("ai")).toBe(true)
    expect((await uninstallModule("amby.ai")).success).toBe(true)
    let registry = await loadGlobalModulesRegistry()
    expect(registry.installed["amby.ai"]).toBeUndefined()
    expect(registry.uninstalled).toContain("amby.ai")

    expect(await installBuiltinModule("amby.ai")).toBe(true)
    registry = await loadGlobalModulesRegistry()
    expect(registry.installed["amby.ai"]?.activeVersion).toBe("1.0.0")
    expect(registry.uninstalled).not.toContain("amby.ai")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("leaves a module that is not built in to the download path", async () => {
    expect(isBuiltinModuleId("someone.else")).toBe(false)
    expect(await installBuiltinModule("someone.else")).toBe(false)
  })
})
