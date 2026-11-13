import type { ActivityButton, PanelId, Side, ActionContext } from "../panel-registry"
import type { AppPreferences, DockPreferences, PanelScope, WindowPreferences } from "../app-config"
import type { ModuleContext } from "../modules"
import type { RefreshSync } from "../sync/use-refresh-sync"
import { collapseButtonsToLeft } from "../activity-buttons"
import { useSidebarLayout } from "../use-sidebar-layout"
import * as React from "react"
import type { SettingsNavigationTarget } from "../settings-navigation"

interface UseWorkspaceDockParams {
  refreshSync: RefreshSync
  presetOptions: { id: string; label: string; hint: string }[]
  activePresetId: string
  switchPreset: (id: string, ctx: ModuleContext) => Promise<boolean>
  vault: string | null
  handleImportPreset: () => Promise<void>
  handleExportPreset: () => Promise<void>
  presetModified: boolean
  canSaveActivePreset: boolean
  saveActivePreset: () => void
  setPresetNameOpen: React.Dispatch<React.SetStateAction<boolean>>
  resetActivePreset: (ctx: ModuleContext) => Promise<boolean>
  panelScope: PanelScope
  setPanelScope: (scope: PanelScope) => void
  openSettings: (target?: SettingsNavigationTarget | null) => void
  dockPrefs: DockPreferences
  activityButtons: ActivityButton[]
  setActivityButtons: React.Dispatch<React.SetStateAction<ActivityButton[]>>
  activeBySide: Record<Side, PanelId | null>
  setActiveBySide: React.Dispatch<React.SetStateAction<Record<Side, PanelId | null>>>
  actionContext: ActionContext
  updateDockPrefs: (patch: Partial<DockPreferences>) => Promise<void>
  windowPrefs: WindowPreferences
  updateWindowPrefs: (patch: Partial<WindowPreferences>) => void
  favoritesPanelPref: boolean
  setPrefs: (patch: Partial<AppPreferences>) => Promise<void>
}

export function useWorkspaceDock({
  refreshSync,
  presetOptions,
  activePresetId,
  switchPreset,
  vault,
  handleImportPreset,
  handleExportPreset,
  presetModified,
  canSaveActivePreset,
  saveActivePreset,
  setPresetNameOpen,
  resetActivePreset,
  panelScope,
  setPanelScope,
  openSettings,
  dockPrefs,
  activityButtons,
  setActivityButtons,
  activeBySide,
  setActiveBySide,
  actionContext,
  updateDockPrefs,
  windowPrefs,
  updateWindowPrefs,
  favoritesPanelPref,
  setPrefs,
}: UseWorkspaceDockParams) {
  const activityBarPresetProps = {
    refreshSync,
    presets: presetOptions,
    activePresetId,
    onSwitchPreset: (id: string) => switchPreset(id, { vault }),
    onImportPreset: handleImportPreset,
    onExportPreset: handleExportPreset,
    presetModified,
    canSaveActivePreset,
    onSaveActivePreset: saveActivePreset,
    onSavePresetAs: () => setPresetNameOpen(true),
    onResetActivePreset: () => void resetActivePreset({ vault }),
    panelScope,
    onSetPanelScope: setPanelScope,
    onOpenSettings: openSettings,
  }

  // With the right panel switched off its buttons join the left dock. That is a view of the
  // stored buttons, so switching the panel back on returns each one to its own side.
  const rightPanelEnabled = dockPrefs.rightEnabled
  const shownButtons = React.useMemo(
    () => (rightPanelEnabled ? activityButtons : collapseButtonsToLeft(activityButtons)),
    [activityButtons, rightPanelEnabled],
  )
  const setShownButtons = React.useCallback<
    React.Dispatch<React.SetStateAction<typeof activityButtons>>
  >(
    (update) => {
      setActivityButtons((stored) => {
        const current = rightPanelEnabled ? stored : collapseButtonsToLeft(stored)
        return typeof update === "function" ? update(current) : update
      })
    },
    [rightPanelEnabled, setActivityButtons],
  )

  const {
    isLeftSidebarOpen,
    isRightSidebarOpen,
    isLeftSidebarVisible,
    isRightSidebarVisible,
    setSidebarHover,
    toggleSidebar,
    leftWidth,
    rightWidth,
    resizingSide,
    startResize,
    isFocusMode,
    isCompactLayout,
    focusShowLeft,
    setFocusShowLeft,
    focusShowRight,
    setFocusShowRight,
    handleEnterFocusMode,
    handleExitFocusMode,
    moveButtonToSide,
    setDockButtonHidden,
    dnd,
    handleActivate,
    activatePanelAnywhere,
    isDockPinned,
    setDockPinned,
  } = useSidebarLayout({
    activityButtons: shownButtons,
    setActivityButtons: setShownButtons,
    rightPanelEnabled,
    activeBySide,
    setActiveBySide,
    actionContext,
    dockPrefs,
    onDockPrefsChange: updateDockPrefs,
    windowPrefs,
    onWindowPrefsChange: updateWindowPrefs,
  })

  // The Favorites tab is one choice with two places to make it: the module's setting and the
  // dock's own menu. At start the setting decides; afterwards whichever changed last wins and
  // the other follows. A person who hid the button by hand while the setting is on keeps it hidden.
  const favoritesButton = activityButtons.find((button) => button.defId === "favorites")
  const favoritesShown = favoritesButton ? !favoritesButton.hidden : null
  const favoritesSynced = React.useRef<{ pref: boolean; shown: boolean } | null>(null)
  React.useEffect(() => {
    if (favoritesShown === null) return
    const synced = favoritesSynced.current
    if (!synced) {
      favoritesSynced.current = { pref: favoritesPanelPref, shown: favoritesPanelPref }
      if (favoritesShown !== favoritesPanelPref) {
        setDockButtonHidden("favorites", !favoritesPanelPref)
      }
      return
    }
    if (favoritesPanelPref !== synced.pref) {
      synced.pref = favoritesPanelPref
      synced.shown = favoritesPanelPref
      if (favoritesShown !== favoritesPanelPref) {
        setDockButtonHidden("favorites", !favoritesPanelPref)
      }
    } else if (favoritesShown !== synced.shown) {
      synced.shown = favoritesShown
      if (favoritesPanelPref !== favoritesShown) {
        synced.pref = favoritesShown
        void setPrefs({ favoritesPanel: favoritesShown })
      }
    }
  }, [favoritesPanelPref, favoritesShown, setDockButtonHidden, setPrefs])

  const activityDockProps = (side: "left" | "right") => ({
    pinned: isDockPinned(side),
    onPinnedChange: (pinned: boolean) => setDockPinned(side, pinned),
    onSetButtonHidden: setDockButtonHidden,
  })
  return {
    activatePanelAnywhere,
    toggleSidebar,
    shownButtons,
    isDockPinned,
    handleExitFocusMode,
    handleEnterFocusMode,
    isFocusMode,
    isLeftSidebarVisible,
    isRightSidebarVisible,
    rightPanelEnabled,
    setFocusShowLeft,
    setFocusShowRight,
    focusShowLeft,
    handleActivate,
    moveButtonToSide,
    dnd,
    activityBarPresetProps,
    activityDockProps,
    focusShowRight,
    setDockPinned,
    isCompactLayout,
    leftWidth,
    rightWidth,
    isLeftSidebarOpen,
    resizingSide,
    setSidebarHover,
    startResize,
    isRightSidebarOpen,
  }
}
