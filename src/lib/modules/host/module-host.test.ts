import { describe, expect, it, vi } from "vitest"
import { ModuleHost } from "./module-host"
import type { PanelId } from "@/components/workspace/panel-registry"
import type { ModuleDefinition } from "./sdk"

describe("ModuleHost", () => {
  it("manages module lifecycle (activate, deactivate, dispose)", async () => {
    const host = new ModuleHost()

    const onActivate = vi.fn()
    const onDeactivate = vi.fn()
    const onDispose = vi.fn()
    const stopTask = vi.fn()

    const testModule: ModuleDefinition = {
      manifest: {
        formatVersion: 1,
        id: "test.module",
        name: "Test Module",
        version: "1.0.0",
        publisher: "Test",
        kind: "official",
        minAppVersion: "0.1.5",
        permissions: ["ui-panel"],
      },
      activate: (api) => {
        onActivate()
        api.panels.register({
          id: "tags" as PanelId,
          labelKey: "test",
          icon: () => null,
          kind: "view",
          render: () => null,
        })
        api.tasks.register({
          id: "test-task",
          moduleId: "test.module",
          stop: stopTask,
        })
      },
      deactivate: () => {
        onDeactivate()
      },
      dispose: () => {
        onDispose()
      },
    }

    host.registerModule(testModule)
    expect(host.getModuleDefinition("test.module")).toBe(testModule)
    expect(host.isModuleActive("test.module")).toBe(false)

    // 1. Activate
    const activated = await host.activateModule("test.module", "/test/vault")
    expect(activated).toBe(true)
    expect(host.isModuleActive("test.module")).toBe(true)
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(host.panels.getPanel("tags" as PanelId)).toBeDefined()

    // 2. Deactivate
    await host.deactivateModule("test.module")
    expect(host.isModuleActive("test.module")).toBe(false)
    expect(onDeactivate).toHaveBeenCalledTimes(1)
    expect(host.panels.getPanel("tags" as PanelId)).toBeUndefined()
    expect(stopTask).toHaveBeenCalledTimes(1)

    // 3. Dispose
    await host.disposeModule("test.module")
    expect(onDispose).toHaveBeenCalledTimes(1)
    expect(host.getModuleDefinition("test.module")).toBeUndefined()
  })

  it("places crashing modules in quarantine after 3 failures", async () => {
    const host = new ModuleHost()

    const failingModule: ModuleDefinition = {
      manifest: {
        formatVersion: 1,
        id: "test.failing",
        name: "Failing Module",
        version: "1.0.0",
        publisher: "Test",
        kind: "official",
        minAppVersion: "0.1.5",
        permissions: [],
      },
      activate: () => {
        throw new Error("Crash on activate")
      },
    }

    host.registerModule(failingModule)

    // Attempt 1
    const res1 = await host.activateModule("test.failing", null)
    expect(res1).toBe(false)
    expect(host.quarantine.isQuarantined("test.failing")).toBe(false)

    // Attempt 2
    const res2 = await host.activateModule("test.failing", null)
    expect(res2).toBe(false)
    expect(host.quarantine.isQuarantined("test.failing")).toBe(false)

    // Attempt 3: threshold reached!
    const res3 = await host.activateModule("test.failing", null)
    expect(res3).toBe(false)
    expect(host.quarantine.isQuarantined("test.failing")).toBe(true)

    // Subsequent attempt is blocked by quarantine
    const res4 = await host.activateModule("test.failing", null)
    expect(res4).toBe(false)
  })

  it("syncs with workspace enabled modules", async () => {
    const host = new ModuleHost()

    const modA: ModuleDefinition = {
      manifest: {
        formatVersion: 1,
        id: "test.a",
        name: "Module A",
        version: "1.0.0",
        publisher: "Test",
        kind: "official",
        minAppVersion: "0.1.5",
        permissions: [],
      },
      activate: vi.fn(),
      deactivate: vi.fn(),
    }

    const modB: ModuleDefinition = {
      manifest: {
        formatVersion: 1,
        id: "test.b",
        name: "Module B",
        version: "1.0.0",
        publisher: "Test",
        kind: "official",
        minAppVersion: "0.1.5",
        permissions: [],
      },
      activate: vi.fn(),
      deactivate: vi.fn(),
    }

    host.registerModule(modA)
    host.registerModule(modB)

    // Enable A only
    await host.syncWithWorkspace(["test.a"], "/vault")
    expect(host.isModuleActive("test.a")).toBe(true)
    expect(host.isModuleActive("test.b")).toBe(false)
    expect(modA.activate).toHaveBeenCalledTimes(1)

    // Switch to B only
    await host.syncWithWorkspace(["test.b"], "/vault")
    expect(host.isModuleActive("test.a")).toBe(false)
    expect(host.isModuleActive("test.b")).toBe(true)
    expect(modA.deactivate).toHaveBeenCalledTimes(1)
    expect(modB.activate).toHaveBeenCalledTimes(1)
  })

  it("dynamically loads installed module or returns existing definition", async () => {
    const host = new ModuleHost()

    const mod: ModuleDefinition = {
      manifest: {
        formatVersion: 1,
        id: "test.dynamic",
        name: "Dynamic Module",
        version: "1.0.0",
        publisher: "Test",
        kind: "official",
        minAppVersion: "0.1.5",
        permissions: [],
      },
      activate: vi.fn(),
    }

    // 1. Existing registered module returns immediately
    host.registerModule(mod)
    const loaded = await host.loadInstalledModule("test.dynamic")
    expect(loaded).toBe(mod)

    // 2. Unregistered module returns null safely in non-Tauri / test env
    const unknown = await host.loadInstalledModule("non.existent")
    expect(unknown).toBeNull()
  })

  it("enforces declared dependencies on activation, deactivation and sync", async () => {
    const host = new ModuleHost()

    const activationOrder: string[] = []
    const deactivationOrder: string[] = []

    const baseModule: ModuleDefinition = {
      manifest: {
        formatVersion: 1,
        id: "amby.databases",
        name: "Databases Module",
        version: "1.0.0",
        publisher: "Amby",
        kind: "official",
        minAppVersion: "0.1.5",
        permissions: [],
      },
      activate: () => {
        activationOrder.push("amby.databases")
      },
      deactivate: () => {
        deactivationOrder.push("amby.databases")
      },
    }

    const dependentModule: ModuleDefinition = {
      manifest: {
        formatVersion: 1,
        id: "amby.creative",
        name: "Creative Module",
        version: "1.0.0",
        publisher: "Amby",
        kind: "official",
        minAppVersion: "0.1.5",
        permissions: [],
        dependencies: {
          "amby.databases": "^1.0.0",
        },
      },
      activate: () => {
        activationOrder.push("amby.creative")
      },
      deactivate: () => {
        deactivationOrder.push("amby.creative")
      },
    }

    host.registerModule(baseModule)
    host.registerModule(dependentModule)

    // 1. Dependent module cannot activate alone
    const actDepDirectly = await host.activateModule("amby.creative", "/vault")
    expect(actDepDirectly).toBe(false)
    expect(host.isModuleActive("amby.creative")).toBe(false)

    // 2. Base activates, then dependent can activate
    const actBase = await host.activateModule("amby.databases", "/vault")
    expect(actBase).toBe(true)
    const actDep = await host.activateModule("amby.creative", "/vault")
    expect(actDep).toBe(true)
    expect(activationOrder).toEqual(["amby.databases", "amby.creative"])

    // 3. Deactivating base cascades: dependent is deactivated first!
    await host.deactivateModule("amby.databases")
    expect(host.isModuleActive("amby.creative")).toBe(false)
    expect(host.isModuleActive("amby.databases")).toBe(false)
    expect(deactivationOrder).toEqual(["amby.creative", "amby.databases"])

    // 4. syncWithWorkspace activates in correct topological order
    activationOrder.length = 0
    deactivationOrder.length = 0
    await host.syncWithWorkspace(["amby.creative", "amby.databases"], "/vault")
    expect(host.isModuleActive("amby.databases")).toBe(true)
    expect(host.isModuleActive("amby.creative")).toBe(true)
    expect(activationOrder).toEqual(["amby.databases", "amby.creative"])

    // 5. syncWithWorkspace disabling base deactivates dependent first
    await host.syncWithWorkspace([], "/vault")
    expect(deactivationOrder).toEqual(["amby.creative", "amby.databases"])
  })
})
