import { describe, expect, it, vi, beforeEach } from "vitest"
import { ModuleHost, moduleHost } from "./module-host"
import { quarantineManager, safeModeState } from "./safe-mode"
import type { ModuleDefinition } from "./sdk"
import type { PanelId } from "@/components/workspace/panel-registry"
import { findPanelDef, findButtonDef } from "@/components/workspace/panel-definitions"
import { TAGS_MODULE_DEFINITION } from "@/components/workspace/tags/tags-module"
import { GRAPH_MODULE_DEFINITION } from "@/components/workspace/graph/graph-module"
import { transitionModuleLifecycle } from "@/components/workspace/module-lifecycle"
import * as modules from "@/components/workspace/modules"

describe("Workspace Module Lifecycle Integration", () => {
  beforeEach(async () => {
    await moduleHost.disposeAll()
    quarantineManager.clear()
    safeModeState.setEnabled(false)
  })

  it("switches vault context when enabled modules remain the same", async () => {
    const host = new ModuleHost()

    const vaultSnapshots: (string | null)[] = []
    const deactivations: string[] = []

    const vaultAwareModule: ModuleDefinition = {
      manifest: {
        formatVersion: 1,
        id: "test.vault.aware",
        name: "Vault Aware Module",
        version: "1.0.0",
        publisher: "Test",
        kind: "official",
        minAppVersion: "0.1.5",
        permissions: ["vault.read"],
      },
      activate: (api) => {
        vaultSnapshots.push(api.context.vault)
      },
      deactivate: () => {
        deactivations.push("deactivated")
      },
    }

    host.registerModule(vaultAwareModule)

    // 1. Initial sync with Vault A
    await host.syncWithWorkspace(["test.vault.aware"], "/path/to/vault-a")
    expect(host.isModuleActive("test.vault.aware")).toBe(true)
    expect(host.getCurrentVault()).toBe("/path/to/vault-a")
    expect(host.getModuleContext("test.vault.aware")?.vault).toBe("/path/to/vault-a")
    expect(vaultSnapshots).toEqual(["/path/to/vault-a"])
    expect(deactivations).toEqual([])

    // 2. Switch workspace to Vault B with the EXACT SAME enabled modules
    await host.syncWithWorkspace(["test.vault.aware"], "/path/to/vault-b")
    expect(host.isModuleActive("test.vault.aware")).toBe(true)
    expect(host.getCurrentVault()).toBe("/path/to/vault-b")
    expect(host.getModuleContext("test.vault.aware")?.vault).toBe("/path/to/vault-b")
    // It must have deactivated for Vault A and reactivated for Vault B!
    expect(deactivations).toHaveLength(1)
    expect(vaultSnapshots).toEqual(["/path/to/vault-a", "/path/to/vault-b"])
  })

  it("serializes concurrent syncWithWorkspace requests", async () => {
    const host = new ModuleHost()
    const log: string[] = []

    const createModule = (id: string): ModuleDefinition => ({
      manifest: {
        formatVersion: 1,
        id,
        name: id,
        version: "1.0.0",
        publisher: "Test",
        kind: "official",
        minAppVersion: "0.1.5",
        permissions: [],
      },
      activate: async () => {
        log.push(`activate:${id}:start`)
        await new Promise((r) => setTimeout(r, 10))
        log.push(`activate:${id}:end`)
      },
      deactivate: async () => {
        log.push(`deactivate:${id}:start`)
        await new Promise((r) => setTimeout(r, 5))
        log.push(`deactivate:${id}:end`)
      },
    })

    host.registerModule(createModule("test.m1"))
    host.registerModule(createModule("test.m2"))

    // Fire two syncWithWorkspace calls concurrently without awaiting the first
    const p1 = host.syncWithWorkspace(["test.m1"], "/vault-1")
    const p2 = host.syncWithWorkspace(["test.m2"], "/vault-2")

    await Promise.all([p1, p2])

    // Must have executed sequentially: p1 finishes before p2 starts
    expect(log).toEqual([
      "activate:test.m1:start",
      "activate:test.m1:end",
      "deactivate:test.m1:start",
      "deactivate:test.m1:end",
      "activate:test.m2:start",
      "activate:test.m2:end",
    ])
    expect(host.isModuleActive("test.m1")).toBe(false)
    expect(host.isModuleActive("test.m2")).toBe(true)
    expect(host.getCurrentVault()).toBe("/vault-2")
  })

  it("makes ModuleHost the sole source of modular panels and commands", async () => {
    // Core panels are always present in findPanelDef
    expect(findPanelDef("files")).toBeDefined()
    expect(findPanelDef("archive")).toBeDefined()
    expect(findPanelDef("info")).toBeDefined()
    expect(findPanelDef("attachments")).toBeDefined()

    // Core actions are always present in findButtonDef
    expect(findButtonDef("search")).toBeDefined()
    expect(findButtonDef("refresh")).toBeDefined()
    expect(findButtonDef("settings")).toBeDefined()

    // Modular panel "tags" is NOT available when moduleHost does not have it active
    expect(moduleHost.isModuleActive("amby.tags")).toBe(false)
    expect(findPanelDef("tags")).toBeUndefined()

    // Modular command "network" is NOT available when moduleHost does not have it active
    expect(moduleHost.isModuleActive("amby.graph")).toBe(false)
    expect(findButtonDef("network")).toBeUndefined()

    // Now activate amby.tags and amby.graph
    moduleHost.registerModule(TAGS_MODULE_DEFINITION)
    moduleHost.registerModule(GRAPH_MODULE_DEFINITION)

    await moduleHost.syncWithWorkspace(["amby.tags", "amby.graph"], "/test-vault")

    // Now they MUST be accessible via findPanelDef and findButtonDef
    expect(findPanelDef("tags")).toBeDefined()
    expect(findButtonDef("network")).toBeDefined()

    // Now deactivate them
    await moduleHost.syncWithWorkspace([], "/test-vault")

    // They must disappear immediately!
    expect(findPanelDef("tags")).toBeUndefined()
    expect(findButtonDef("network")).toBeUndefined()
  })

  it("unregisters all contributions and cleans up tasks on deactivation", async () => {
    const host = new ModuleHost()
    const taskStopFn = vi.fn()

    const fullModule: ModuleDefinition = {
      manifest: {
        formatVersion: 1,
        id: "test.full",
        name: "Full Module",
        version: "1.0.0",
        publisher: "Test",
        kind: "official",
        minAppVersion: "0.1.5",
        permissions: ["ui-panel", "vault.read"],
      },
      activate: (api) => {
        api.panels.register({
          id: "custom-panel" as unknown as PanelId,
          labelKey: "custom",
          icon: () => null,
          kind: "view",
          render: () => null,
        })
        api.commands.register({
          id: "custom-cmd",
          labelKey: "custom",
          icon: () => null,
          kind: "action",
          invoke: () => {},
        })
        api.files.register({
          extension: ".custom",
          moduleId: "test.full",
          viewKind: "custom-view",
        })
        api.tasks.register({
          id: "bg-task",
          moduleId: "test.full",
          stop: taskStopFn,
        })
      },
    }

    host.registerModule(fullModule)
    await host.syncWithWorkspace(["test.full"], "/vault")

    expect(host.panels.getPanel("custom-panel")).toBeDefined()
    expect(host.commands.getCommand("custom-cmd")).toBeDefined()
    expect(host.files.getHandler(".custom")).toBeDefined()
    expect(host.tasks.getActiveTasks()).toHaveLength(1)

    // Deactivate
    await host.syncWithWorkspace([], "/vault")

    expect(host.panels.getPanel("custom-panel")).toBeUndefined()
    expect(host.commands.getCommand("custom-cmd")).toBeUndefined()
    expect(host.files.getHandler(".custom")).toBeUndefined()
    expect(host.tasks.getActiveTasks()).toHaveLength(0)
    expect(taskStopFn).toHaveBeenCalledTimes(1)
  })

  it("shares unified quarantine and safeMode state", async () => {
    const host = new ModuleHost()
    expect(host.quarantine).toBe(quarantineManager)
    expect(host.safeMode).toBe(safeModeState)

    // Test safe mode propagation
    safeModeState.setEnabled(true)
    let contextSeenSafeMode: boolean | undefined

    const testModule: ModuleDefinition = {
      manifest: {
        formatVersion: 1,
        id: "test.safemode",
        name: "Safe Mode Test",
        version: "1.0.0",
        publisher: "Test",
        kind: "official",
        minAppVersion: "0.1.5",
        permissions: [],
      },
      activate: (api) => {
        contextSeenSafeMode = api.context.isSafeMode
      },
    }

    host.registerModule(testModule)
    await host.activateModule("test.safemode", "/vault")
    expect(contextSeenSafeMode).toBe(true)

    // Test quarantine shared instance
    quarantineManager.recordFailure("test.failing.singleton", new Error("1"))
    quarantineManager.recordFailure("test.failing.singleton", new Error("2"))
    quarantineManager.recordFailure("test.failing.singleton", new Error("3"))

    expect(host.quarantine.isQuarantined("test.failing.singleton")).toBe(true)
  })

  it("aborts module deactivation when prepareDeactivate rejects (dirty state preserved)", async () => {
    const prepareDeactivateMock = vi
      .fn()
      .mockRejectedValue(new Error("Unsaved changes in document!"))
    const onDeactivateMock = vi.fn()

    const spy = vi.spyOn(modules, "findModule").mockImplementation((id: string) => {
      if (id === "test-dirty-mod") {
        return {
          id: "test-dirty-mod",
          labelKey: "test",
          descriptionKey: "test",
          status: "ready",
          manifest: { permissions: [] },
          prepareDeactivate: prepareDeactivateMock,
          onDeactivate: onDeactivateMock,
        }
      }
      return undefined
    })

    const transition = await transitionModuleLifecycle(["test-dirty-mod"], [], { vault: "/vault" })

    expect(transition.ok).toBe(false)
    if (!transition.ok) {
      expect((transition.error as Error).message).toBe("Unsaved changes in document!")
    }
    // onDeactivate must NOT have been called!
    expect(onDeactivateMock).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
