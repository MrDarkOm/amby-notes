import { describe, expect, it, vi } from "vitest"
import { determineMigratedModuleConfig } from "./module-migration"
import {
  applyProfileToWorkspace,
  disableModuleInWorkspace,
  enableModuleInWorkspace,
  isModuleEnabledInWorkspace,
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

describe("Module Migration", () => {
  it("migrates legacy simple preset to minimal profile", () => {
    const legacy = {
      layout: {
        activePresetId: "simple",
        activeModules: null,
      },
    }

    const { config, needsMigration } = determineMigratedModuleConfig(legacy)
    expect(needsMigration).toBe(true)
    expect(config.profile.id).toBe("minimal")
    expect(config.enabledModules).toEqual([])
  })

  it("migrates legacy custom activeModules correctly", () => {
    const legacy = {
      layout: {
        activePresetId: "standard",
        activeModules: ["tags", "favorites"],
      },
    }

    const { config, needsMigration } = determineMigratedModuleConfig(legacy)
    expect(needsMigration).toBe(true)
    expect(config.profile.id).toBe("custom")
    expect(config.enabledModules).toEqual(["amby.tags", "amby.favorites"])
  })

  it("is idempotent when configuration is already migrated", () => {
    const alreadyMigrated = {
      profile: {
        id: "standard",
        catalogRevision: "2026-09-20",
      },
      enabledModules: ["amby.tags", "amby.favorites"],
      moduleSettings: {},
    }

    const { config, needsMigration } = determineMigratedModuleConfig(alreadyMigrated)
    expect(needsMigration).toBe(false)
    expect(config.profile.id).toBe("standard")
    expect(config.enabledModules).toEqual(["amby.tags", "amby.favorites"])
  })

  it("aborts migration if pre-migration backup fails", async () => {
    const { migrateWorkspaceModules, getMigrationJournal } = await import("./module-migration")
    const storage = await import("@/lib/storage")

    const legacy = {
      layout: {
        activePresetId: "simple",
      },
    }

    const vaultStorage: Record<string, unknown> = {}
    const saveSpy = vi
      .spyOn(storage, "saveVaultJSON")
      .mockImplementation(async (path: string, data: unknown) => {
        if (path.startsWith("backups/")) {
          throw new Error("Disk full: cannot write backup")
        }
        vaultStorage[path] = data
      })
    const loadSpy = vi
      .spyOn(storage, "loadVaultJSON")
      .mockImplementation(async <T>(path: string, fallback: T): Promise<T> => {
        return (vaultStorage[path] as T) ?? fallback
      })

    await expect(migrateWorkspaceModules(legacy)).rejects.toThrow(
      "Migration aborted: Pre-migration backup failed: Disk full: cannot write backup",
    )

    const journal = await getMigrationJournal()
    const lastEntry = journal[journal.length - 1]
    expect(lastEntry?.status).toBe("failed")
    expect(lastEntry?.error).toContain("Disk full")

    saveSpy.mockRestore()
    loadSpy.mockRestore()
  })

  it("records success in journal and performs rollback correctly", async () => {
    const { migrateWorkspaceModules, rollbackWorkspaceModulesMigration, getMigrationJournal } =
      await import("./module-migration")
    const storage = await import("@/lib/storage")

    const vaultStorage: Record<string, unknown> = {}
    const saveSpy = vi
      .spyOn(storage, "saveVaultJSON")
      .mockImplementation(async (path: string, data: unknown) => {
        vaultStorage[path] = data
      })
    const loadSpy = vi
      .spyOn(storage, "loadVaultJSON")
      .mockImplementation(async <T>(path: string, fallback: T): Promise<T> => {
        return (vaultStorage[path] as T) ?? fallback
      })

    const legacy = {
      layout: {
        activePresetId: "standard",
        activeModules: ["tags"],
      },
    }

    // 1. Migrate
    const res = await migrateWorkspaceModules(legacy)
    expect(res.migrated).toBe(true)
    expect(res.backupPath).toBeDefined()

    let journal = await getMigrationJournal()
    let lastEntry = journal[journal.length - 1]
    expect(lastEntry?.status).toBe("success")
    expect(lastEntry?.backupPath).toBe(res.backupPath)

    // 2. Rollback
    const rollbackRes = await rollbackWorkspaceModulesMigration(res.backupPath!)
    expect(rollbackRes.ok).toBe(true)
    expect(vaultStorage["workspace.json"]).toEqual(legacy)

    journal = await getMigrationJournal()
    lastEntry = journal[journal.length - 1]
    expect(lastEntry?.status).toBe("rolled_back")

    saveSpy.mockRestore()
    loadSpy.mockRestore()
  })
})
