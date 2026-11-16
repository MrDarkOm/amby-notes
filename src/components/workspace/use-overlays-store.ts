import { create } from "zustand"
import type { SettingsNavigationTarget } from "./settings-navigation"

export type QuickOpenMode = "current" | "new"

interface OverlaysState {
  /** Quick open is shown when set; `new` opens the chosen file in a new tab. */
  quickOpenMode: QuickOpenMode | null
  searchOpen: boolean
  helpOpen: boolean
  settingsOpen: boolean
  /** The section the settings dialog jumps to when it opens. */
  settingsTarget: SettingsNavigationTarget | null
  vaultManagerOpen: boolean
  presetNameOpen: boolean
  setQuickOpenMode: (mode: QuickOpenMode | null) => void
  setSearchOpen: (open: boolean) => void
  setHelpOpen: (open: boolean) => void
  /** Opens settings at a section; closing it forgets the section. */
  openSettings: (target?: SettingsNavigationTarget | null) => void
  setSettingsOpen: (open: boolean) => void
  setVaultManagerOpen: (open: boolean) => void
  setPresetNameOpen: (open: boolean) => void
  /** Closes everything; the workspace root calls it when it goes away, as its own state would. */
  reset: () => void
}

const CLOSED = {
  quickOpenMode: null,
  searchOpen: false,
  helpOpen: false,
  settingsOpen: false,
  settingsTarget: null,
  vaultManagerOpen: false,
  presetNameOpen: false,
}

/**
 * Which dialogs of the workspace are open. They live apart from the workspace root: the root and
 * the things that open a dialog call the actions (they never subscribe), and each dialog reads
 * its own flag, so opening one renders that dialog and nothing above it (SHELL-04).
 */
export const useOverlaysStore = create<OverlaysState>((set) => ({
  ...CLOSED,
  setQuickOpenMode: (quickOpenMode) => set({ quickOpenMode }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  openSettings: (target = null) => set({ settingsTarget: target, settingsOpen: true }),
  setSettingsOpen: (settingsOpen) =>
    set(settingsOpen ? { settingsOpen } : { settingsOpen, settingsTarget: null }),
  setVaultManagerOpen: (vaultManagerOpen) => set({ vaultManagerOpen }),
  setPresetNameOpen: (presetNameOpen) => set({ presetNameOpen }),
  reset: () => set(CLOSED),
}))
