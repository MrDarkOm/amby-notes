import { beforeEach, describe, expect, it } from "vitest"
import { useOverlaysStore } from "./use-overlays-store"

const closed = {
  quickOpenMode: null,
  searchOpen: false,
  helpOpen: false,
  settingsOpen: false,
  settingsTarget: null,
  vaultManagerOpen: false,
  presetNameOpen: false,
}

describe("useOverlaysStore", () => {
  beforeEach(() => useOverlaysStore.setState(closed))

  it("opens and closes each overlay on its own", () => {
    const s = useOverlaysStore.getState()
    s.setQuickOpenMode("new")
    s.setSearchOpen(true)
    s.setHelpOpen(true)
    s.setVaultManagerOpen(true)
    s.setPresetNameOpen(true)
    expect(useOverlaysStore.getState()).toMatchObject({
      quickOpenMode: "new",
      searchOpen: true,
      helpOpen: true,
      vaultManagerOpen: true,
      presetNameOpen: true,
      settingsOpen: false,
    })
    s.setQuickOpenMode(null)
    s.setSearchOpen(false)
    s.setHelpOpen(false)
    s.setVaultManagerOpen(false)
    s.setPresetNameOpen(false)
    expect(useOverlaysStore.getState()).toMatchObject(closed)
  })

  it("opens settings at a section and forgets the section when it closes", () => {
    useOverlaysStore.getState().openSettings({ section: "sync" })
    expect(useOverlaysStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsTarget: { section: "sync" },
    })
    useOverlaysStore.getState().openSettings()
    expect(useOverlaysStore.getState().settingsTarget).toBeNull()
    useOverlaysStore.getState().openSettings({ section: "sync" })
    useOverlaysStore.getState().setSettingsOpen(false)
    expect(useOverlaysStore.getState()).toMatchObject({ settingsOpen: false, settingsTarget: null })
  })
})
