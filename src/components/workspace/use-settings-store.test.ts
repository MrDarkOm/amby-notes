import { beforeEach, describe, expect, it, vi } from "vitest"

const loadSettings = vi.fn()
const saveSettingsPatch = vi.fn()

vi.mock("./app-config", async (importOriginal) => {
  const original = await importOriginal<typeof import("./app-config")>()
  return {
    ...original,
    loadSettings: (...args: unknown[]) => loadSettings(...args),
    saveSettingsPatch: (...args: unknown[]) => saveSettingsPatch(...args),
  }
})

import { DEFAULT_EXPERIMENTAL, DEFAULT_PREFS } from "./app-config"
import { useSettingsStore } from "./use-settings-store"

const saved = {
  prefs: { ...DEFAULT_PREFS, theme: "light", rainbowTree: true },
  experimental: DEFAULT_EXPERIMENTAL,
  themes: [],
}

describe("settings store writes", () => {
  beforeEach(() => {
    loadSettings.mockReset().mockResolvedValue(saved)
    saveSettingsPatch.mockReset().mockResolvedValue(undefined)
    useSettingsStore.setState({
      prefs: DEFAULT_PREFS,
      experimental: DEFAULT_EXPERIMENTAL,
      themes: [],
      hydrated: false,
    })
  })

  it("reads the file before a change, so defaults are never written over the author's settings", async () => {
    // A panel drag lands before (or without) the store having read the file.
    await useSettingsStore
      .getState()
      .setPrefs({ window: { ...DEFAULT_PREFS.window, leftPanelWidth: 333 } })

    expect(loadSettings).toHaveBeenCalledTimes(1)
    const written = saveSettingsPatch.mock.calls[0][0].prefs
    expect(written.theme).toBe("light")
    expect(written.rainbowTree).toBe(true)
    expect(written.window.leftPanelWidth).toBe(333)
  })

  it("does not read the file again once the store holds it", async () => {
    await useSettingsStore.getState().hydrate()
    await useSettingsStore.getState().setPrefs({ accent: "teal" })
    expect(loadSettings).toHaveBeenCalledTimes(1)
    expect(saveSettingsPatch.mock.calls[0][0].prefs).toMatchObject({
      theme: "light",
      accent: "teal",
    })
  })

  it("writes nothing when the file cannot be read", async () => {
    loadSettings.mockRejectedValue(new Error("unreadable"))
    await expect(useSettingsStore.getState().setPrefs({ accent: "teal" })).rejects.toThrow()
    expect(saveSettingsPatch).not.toHaveBeenCalled()
  })
})
