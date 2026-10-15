import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const loadWorkspaceConfig = vi.fn()
const saveWorkspaceConfigPatch = vi.fn()
const emit = vi.fn()
let tauri = false

vi.mock("@tauri-apps/api/event", () => ({ emit: (...args: unknown[]) => emit(...args) }))
vi.mock("@/lib/storage", () => ({ isTauri: () => tauri }))

vi.mock("../app-config", () => ({
  loadWorkspaceConfig: (...args: unknown[]) => loadWorkspaceConfig(...args),
  saveWorkspaceConfigPatch: (...args: unknown[]) => saveWorkspaceConfigPatch(...args),
}))

import {
  CREATIVE_SETTINGS_CHANGED_EVENT,
  useCreativeSettingsStore,
} from "./creative-settings-store"

describe("creative settings store", () => {
  beforeEach(() => {
    loadWorkspaceConfig.mockReset()
    saveWorkspaceConfigPatch.mockReset().mockResolvedValue(undefined)
    emit.mockReset().mockResolvedValue(undefined)
    tauri = false
    useCreativeSettingsStore.setState({ showInTree: true, workshopPath: null })
  })
  afterEach(() => vi.restoreAllMocks())

  it("shows the creative folders unless the vault says otherwise", async () => {
    loadWorkspaceConfig.mockResolvedValue({ moduleSettings: {} })
    await useCreativeSettingsStore.getState().load()
    expect(useCreativeSettingsStore.getState().showInTree).toBe(true)

    loadWorkspaceConfig.mockResolvedValue({ moduleSettings: { creative: { showInTree: false } } })
    await useCreativeSettingsStore.getState().load()
    expect(useCreativeSettingsStore.getState().showInTree).toBe(false)
  })

  it("falls back to showing them when the file cannot be read", async () => {
    useCreativeSettingsStore.setState({ showInTree: false })
    loadWorkspaceConfig.mockRejectedValue(new Error("no vault"))
    await useCreativeSettingsStore.getState().load()
    expect(useCreativeSettingsStore.getState().showInTree).toBe(true)
  })

  it("saves the choice beside the other modules' settings without touching them", async () => {
    loadWorkspaceConfig.mockResolvedValue({
      moduleSettings: { history: { enabled: true }, creative: { other: 1 } },
    })
    await useCreativeSettingsStore.getState().setShowInTree(false)
    expect(useCreativeSettingsStore.getState().showInTree).toBe(false)
    expect(saveWorkspaceConfigPatch).toHaveBeenCalledWith({
      moduleSettings: { history: { enabled: true }, creative: { other: 1, showInTree: false } },
    })
  })

  it("tells the other windows once the choice is saved", async () => {
    tauri = true
    loadWorkspaceConfig.mockResolvedValue({ moduleSettings: {} })
    await useCreativeSettingsStore.getState().setShowInTree(false)
    expect(emit).toHaveBeenCalledWith(CREATIVE_SETTINGS_CHANGED_EVENT, { showInTree: false })
    expect(saveWorkspaceConfigPatch.mock.invocationCallOrder[0]).toBeLessThan(
      emit.mock.invocationCallOrder[0],
    )
  })

  it("does not announce a choice that could not be saved", async () => {
    tauri = true
    vi.spyOn(console, "error").mockImplementation(() => {})
    loadWorkspaceConfig.mockResolvedValue({ moduleSettings: {} })
    saveWorkspaceConfigPatch.mockRejectedValue(new Error("disk"))
    await useCreativeSettingsStore.getState().setShowInTree(false)
    expect(emit).not.toHaveBeenCalled()
  })

  describe("the workshop folder", () => {
    it("is not set until the vault says so, and a bad value reads as not set", async () => {
      loadWorkspaceConfig.mockResolvedValue({ moduleSettings: {} })
      await useCreativeSettingsStore.getState().load()
      expect(useCreativeSettingsStore.getState().workshopPath).toBeNull()

      loadWorkspaceConfig.mockResolvedValue({
        moduleSettings: { creative: { workshopPath: "Книги//Серия" } },
      })
      await useCreativeSettingsStore.getState().load()
      expect(useCreativeSettingsStore.getState().workshopPath).toBe("Книги/Серия")

      loadWorkspaceConfig.mockResolvedValue({
        moduleSettings: { creative: { workshopPath: "../Чужая" } },
      })
      await useCreativeSettingsStore.getState().load()
      expect(useCreativeSettingsStore.getState().workshopPath).toBeNull()
    })

    it("saves the folder beside the other settings and announces it", async () => {
      tauri = true
      loadWorkspaceConfig.mockResolvedValue({
        moduleSettings: { history: { enabled: true }, creative: { showInTree: false } },
      })
      await useCreativeSettingsStore.getState().setWorkshopPath("Книги/Моя")
      expect(saveWorkspaceConfigPatch).toHaveBeenCalledWith({
        moduleSettings: {
          history: { enabled: true },
          creative: { showInTree: false, workshopPath: "Книги/Моя" },
        },
      })
      expect(useCreativeSettingsStore.getState().workshopPath).toBe("Книги/Моя")
      expect(emit).toHaveBeenCalledWith(CREATIVE_SETTINGS_CHANGED_EVENT, {
        workshopPath: "Книги/Моя",
      })
    })

    it("returns to the default by removing the key", async () => {
      loadWorkspaceConfig.mockResolvedValue({
        moduleSettings: { creative: { showInTree: true, workshopPath: "Книги" } },
      })
      useCreativeSettingsStore.setState({ workshopPath: "Книги" })
      await useCreativeSettingsStore.getState().setWorkshopPath(null)
      expect(saveWorkspaceConfigPatch).toHaveBeenCalledWith({
        moduleSettings: { creative: { showInTree: true } },
      })
      expect(useCreativeSettingsStore.getState().workshopPath).toBeNull()
    })

    it("refuses a path that cannot be a folder of the vault before writing anything", async () => {
      loadWorkspaceConfig.mockResolvedValue({ moduleSettings: {} })
      await expect(
        useCreativeSettingsStore.getState().setWorkshopPath("../Чужая"),
      ).rejects.toThrow()
      expect(saveWorkspaceConfigPatch).not.toHaveBeenCalled()
      expect(useCreativeSettingsStore.getState().workshopPath).toBeNull()
    })

    it("keeps the old value when the file cannot be saved", async () => {
      loadWorkspaceConfig.mockResolvedValue({ moduleSettings: {} })
      saveWorkspaceConfigPatch.mockRejectedValue(new Error("disk"))
      await expect(useCreativeSettingsStore.getState().setWorkshopPath("Книги")).rejects.toThrow(
        "disk",
      )
      expect(useCreativeSettingsStore.getState().workshopPath).toBeNull()
      expect(emit).not.toHaveBeenCalled()
    })
  })
})
