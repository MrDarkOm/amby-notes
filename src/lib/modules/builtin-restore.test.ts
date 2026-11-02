import { beforeEach, describe, expect, it, vi } from "vitest"

import { loadGlobalModulesRegistry, uninstallModule } from "./index"

describe("built-in modules while the package controls are hidden", () => {
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
  })

  it("brings back a module an earlier version uninstalled, as nothing can install it now", async () => {
    expect((await uninstallModule("amby.ai")).success).toBe(true)
    const registry = await loadGlobalModulesRegistry()
    expect(registry.installed["amby.ai"]?.source).toBe("builtin")
  })
})
