import type { ActiveTabDragState, ActivePaneHoverTarget } from "../pane-dnd"
import type { ActivityButton, PanelId, Side, PanelRenderProps } from "../panel-registry"
import type { LayoutLeafItem, LayoutSplitDivider } from "../split-tree"
import type { ModuleContext } from "../modules"
import type { PanelScope } from "../app-config"
import type { RefreshSyncState } from "../sync/use-refresh-sync"
import { type SplitPaneOptions, type Tab, useTabsStore } from "../use-tabs-store"
import type { SpotlightCreateAction } from "../sidebar-search"
import type { VaultRecord } from "../workspace-picker"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { ActivityBar } from "../activity-bar"
import { PanelHost } from "../panel-host"
import { ResizeHandle } from "../resize-handle"
import { HeaderTabs, type HeaderTab } from "../header-tabs"
import { QuickOpenModal } from "../quick-open-modal"
import { SearchModal } from "../search-modal"
import { SPOTLIGHT_ORIGIN } from "../spotlight-motion"
import { SettingsDialog } from "../settings-dialog"
import { HelpModal, type HelpContext } from "../help-modal"
import type { SettingsNavigationTarget } from "../settings-navigation"
import { cn } from "@/lib/utils"
import { PaneDropOverlay, SplitResizeHandle } from "../pane-tab-bar"
import type { TreeItem } from "../sidebar-tree"
import { searchNotes, openInExplorer } from "@/lib/storage"
import { PresetNameDialog } from "../preset-name-dialog"
import { VaultManagerDialog } from "../vault/vault-manager"
import { flushEditorSerializations } from "../tiptap/editor-serialization-lifecycle"

interface WorkspaceNormalLayoutProps {
  headerTabs: HeaderTab[]
  activeTabKey: string
  unsavedFileIds: Set<string>
  handleTabChange: (key: string) => void
  handleTabClose: (key: string) => void
  toggleSidebar: (side: Side) => void
  isLeftSidebarVisible: boolean
  isRightSidebarVisible: boolean
  leftDockPinned: boolean
  rightDockPinned: boolean
  setDockPinned: (side: Side, pinned: boolean) => void
  setQuickOpenMode: React.Dispatch<React.SetStateAction<"current" | "new" | null>>
  vaultName: string | undefined
  vaults: VaultRecord[]
  vault: string
  loadVault: (path: string | null, activateBackend?: boolean) => Promise<void>
  handleOpenVault: () => Promise<void>
  setVaultManagerOpen: React.Dispatch<React.SetStateAction<boolean>>
  handleCloseAllTabs: () => void
  isCompactLayout: boolean
  leftWidth: number
  rightPanelEnabled: boolean
  rightWidth: number
  activeTab: Tab | null
  favorites: Set<string>
  handleToggleFavorite: (id: string) => void
  singlePaneId: string
  isMultiPane: boolean
  handleSplitRight: (options?: SplitPaneOptions) => string | null
  handleSplitDown: (options?: SplitPaneOptions) => string | null
  handleTabUsageChanged: () => void
  deleteConfirmationDialog: React.ReactNode
  propertyMigrationDialog: React.JSX.Element
  leftButtons: ActivityButton[]
  activeBySide: Record<Side, PanelId | null>
  handleActivate: (defId: string) => void
  moveButtonToSide: (defId: string, targetSide: Side) => void
  dnd: {
    draggingId: string | null
    onPointerDown: (defId: string) => (e: React.PointerEvent<HTMLElement>) => void
  }
  activityBarPresetProps: {
    refreshSync: {
      refresh: () => Promise<void>
      state: RefreshSyncState
      busy: boolean
      error: unknown
    }
    presets: { id: string; label: string; hint: string }[]
    activePresetId: string
    onSwitchPreset: (id: string) => Promise<boolean>
    onImportPreset: () => Promise<void>
    onExportPreset: () => Promise<void>
    presetModified: boolean
    canSaveActivePreset: boolean
    onSaveActivePreset: () => void
    onSavePresetAs: () => void
    onResetActivePreset: () => undefined
    panelScope: PanelScope
    onSetPanelScope: (scope: PanelScope) => void
    onOpenSettings: (target?: SettingsNavigationTarget | null) => void
  }
  activityDockProps: (side: "left" | "right") => {
    pinned: boolean
    onPinnedChange: (pinned: boolean) => void
    onSetButtonHidden: (defId: string, hidden: boolean) => void
  }
  currentHelpContext: HelpContext
  isLeftSidebarOpen: boolean
  resizingSide: Side | null
  setSidebarHover: (side: Side, hovering: boolean) => void
  panelRenderProps: PanelRenderProps
  startResize: (side: "left" | "right") => (e: React.MouseEvent) => void
  mainStageRef: React.RefObject<HTMLElement | null>
  splitLayout: { leaves: LayoutLeafItem[]; dividers: LayoutSplitDivider[] }
  renderPaneLeaf: (leafItem: LayoutLeafItem) => React.JSX.Element
  paneDnd: { tabDrag: ActiveTabDragState | null; hoverTarget: ActivePaneHoverTarget | null }
  isRightSidebarOpen: boolean
  rightButtons: ActivityButton[]
  quickOpenMode: "current" | "new" | null
  displayTreeItems: TreeItem[]
  handleOpenInNewTab: (fileId: string) => Promise<void>
  handleSelect: (fileId: string, displayTitle?: string) => Promise<void>
  handleNewFileIn: (
    parentId: string | null,
    inNewTab?: boolean,
    initialContent?: string,
  ) => Promise<void>
  activeFileId: string | null
  quickOpenCreateActions: SpotlightCreateAction[]
  searchOpen: boolean
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>
  vaultManagerOpen: boolean
  handleRenameVault: (id: string, name: string) => void
  handleDeleteVault: (id: string) => Promise<void>
  handleMoveVault: (id: string) => Promise<void>
  settingsOpen: boolean
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setSettingsTarget: React.Dispatch<React.SetStateAction<SettingsNavigationTarget | null>>
  settingsTarget: SettingsNavigationTarget | null
  activeModules: string[]
  setModuleEnabled: (id: string, enabled: boolean, ctx: ModuleContext) => Promise<boolean>
  adoptPreset: (id: string) => Promise<void>
  isHelpOpen: boolean
  setIsHelpOpen: React.Dispatch<React.SetStateAction<boolean>>
  workspaceProfileDialog: React.JSX.Element
  presetNameOpen: boolean
  setPresetNameOpen: React.Dispatch<React.SetStateAction<boolean>>
  savePresetAs: (label: string) => void
}

export function WorkspaceNormalLayout({
  headerTabs,
  activeTabKey,
  unsavedFileIds,
  handleTabChange,
  handleTabClose,
  toggleSidebar,
  isLeftSidebarVisible,
  isRightSidebarVisible,
  leftDockPinned,
  rightDockPinned,
  setDockPinned,
  setQuickOpenMode,
  vaultName,
  vaults,
  vault,
  loadVault,
  handleOpenVault,
  setVaultManagerOpen,
  handleCloseAllTabs,
  isCompactLayout,
  leftWidth,
  rightPanelEnabled,
  rightWidth,
  activeTab,
  favorites,
  handleToggleFavorite,
  singlePaneId,
  isMultiPane,
  handleSplitRight,
  handleSplitDown,
  handleTabUsageChanged,
  deleteConfirmationDialog,
  propertyMigrationDialog,
  leftButtons,
  activeBySide,
  handleActivate,
  moveButtonToSide,
  dnd,
  activityBarPresetProps,
  activityDockProps,
  currentHelpContext,
  isLeftSidebarOpen,
  resizingSide,
  setSidebarHover,
  panelRenderProps,
  startResize,
  mainStageRef,
  splitLayout,
  renderPaneLeaf,
  paneDnd,
  isRightSidebarOpen,
  rightButtons,
  quickOpenMode,
  displayTreeItems,
  handleOpenInNewTab,
  handleSelect,
  handleNewFileIn,
  activeFileId,
  quickOpenCreateActions,
  searchOpen,
  setSearchOpen,
  vaultManagerOpen,
  handleRenameVault,
  handleDeleteVault,
  handleMoveVault,
  settingsOpen,
  setSettingsOpen,
  setSettingsTarget,
  settingsTarget,
  activeModules,
  setModuleEnabled,
  adoptPreset,
  isHelpOpen,
  setIsHelpOpen,
  workspaceProfileDialog,
  presetNameOpen,
  setPresetNameOpen,
  savePresetAs,
}: WorkspaceNormalLayoutProps) {
  const { t } = useTranslation()
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <HeaderTabs
        tabs={headerTabs}
        activeTabKey={activeTabKey}
        unsavedFileIds={unsavedFileIds}
        onTabChange={handleTabChange}
        onTabClose={handleTabClose}
        onToggleLeftSidebar={() => toggleSidebar("left")}
        onToggleRightSidebar={() => toggleSidebar("right")}
        isLeftSidebarOpen={isLeftSidebarVisible}
        isRightSidebarOpen={isRightSidebarVisible}
        isLeftDockPinned={leftDockPinned}
        isRightDockPinned={rightDockPinned}
        onSetLeftDockPinned={(pinned) => setDockPinned("left", pinned)}
        onSetRightDockPinned={(pinned) => setDockPinned("right", pinned)}
        onOpenPlusModal={() => setQuickOpenMode("new")}
        vaultName={vaultName}
        vaults={vaults}
        currentVaultPath={vault}
        onSwitchVault={loadVault}
        onAddVault={handleOpenVault}
        onManageVaults={() => setVaultManagerOpen(true)}
        onCloseAllTabs={handleCloseAllTabs}
        leftTreeWidth={isCompactLayout ? 0 : leftWidth}
        rightPanelWidth={isCompactLayout || !rightDockPinned || !rightPanelEnabled ? 0 : rightWidth}
        rightPanelEnabled={rightPanelEnabled}
        activeFileId={activeTab?.fileId}
        favorites={favorites}
        onToggleFavorite={handleToggleFavorite}
        showWorkspacePicker={false}
        paneId={singlePaneId}
        isSplit={isMultiPane}
        hideCenterTabsWhenSplit
        onSplitRight={(tabKey) => handleSplitRight({ tabKey, paneId: singlePaneId })}
        onSplitDown={(tabKey) => handleSplitDown({ tabKey, paneId: singlePaneId })}
        onCloseOtherTabs={(tabKey) => {
          flushEditorSerializations()
          useTabsStore.getState().closeOtherTabsInPane(singlePaneId, tabKey)
          handleTabUsageChanged()
        }}
        onUnsplitAll={() => {
          flushEditorSerializations()
          useTabsStore.getState().unsplitAll()
          handleTabUsageChanged()
        }}
      />
      {deleteConfirmationDialog}
      {propertyMigrationDialog}

      <div className="flex min-h-0 flex-1">
        {leftDockPinned && (
          <ActivityBar
            side="left"
            buttons={leftButtons}
            activeView={activeBySide.left}
            isPanelOpen={isLeftSidebarVisible}
            onActivate={handleActivate}
            onMoveToOtherSide={
              rightPanelEnabled ? (defId) => moveButtonToSide(defId, "right") : undefined
            }
            onPointerDownButton={dnd.onPointerDown}
            draggingId={dnd.draggingId}
            {...activityBarPresetProps}
            {...activityDockProps("left")}
            helpContext={currentHelpContext}
          />
        )}

        <div
          className="amby-workspace-frame flex min-h-0 min-w-0 flex-1"
          data-split={isMultiPane || undefined}
        >
          {leftDockPinned && isLeftSidebarOpen && (
            <>
              <div
                data-help-area="left-panel"
                style={{
                  width: isLeftSidebarVisible ? "var(--amby-left-panel-width, 300px)" : 0,
                  transition:
                    resizingSide === "left" ? "none" : "width 320ms cubic-bezier(0.16, 1, 0.3, 1)",
                }}
                onMouseEnter={() => setSidebarHover("left", true)}
                onMouseLeave={() => setSidebarHover("left", false)}
                className={
                  isCompactLayout
                    ? "fixed bottom-0 left-[var(--amby-dock-width)] top-11 z-40 max-w-[calc(100vw-2.5rem)] overflow-hidden shadow-2xl"
                    : "relative shrink-0 overflow-hidden"
                }
              >
                <div
                  className="relative h-full shrink-0"
                  style={{ width: "var(--amby-left-panel-width, 300px)" }}
                >
                  <PanelHost side="left" activeId={activeBySide.left} props={panelRenderProps} />
                  {!isCompactLayout && (
                    <ResizeHandle
                      side="right"
                      active={resizingSide === "left"}
                      onMouseDown={startResize("left")}
                    />
                  )}
                </div>
              </div>
            </>
          )}

          {!leftDockPinned && (
            <div
              className="amby-sidebar-overlay--left fixed bottom-0 left-0 top-11 z-40 rounded-r-2xl"
              style={{
                width: isLeftSidebarVisible
                  ? "calc(var(--amby-left-panel-width, 300px) + var(--amby-dock-width))"
                  : 4,
                transition:
                  resizingSide === "left" ? "none" : "width 320ms cubic-bezier(0.16, 1, 0.3, 1)",
              }}
              onMouseEnter={() => setSidebarHover("left", true)}
              onMouseLeave={() => setSidebarHover("left", false)}
            >
              <div className="flex h-full w-full overflow-hidden rounded-r-2xl bg-background">
                <div
                  className="flex h-full shrink-0"
                  style={{
                    width: "calc(var(--amby-left-panel-width, 300px) + var(--amby-dock-width))",
                  }}
                >
                  <ActivityBar
                    side="left"
                    buttons={leftButtons}
                    activeView={activeBySide.left}
                    isPanelOpen={isLeftSidebarVisible}
                    onActivate={handleActivate}
                    onMoveToOtherSide={
                      rightPanelEnabled ? (defId) => moveButtonToSide(defId, "right") : undefined
                    }
                    onPointerDownButton={dnd.onPointerDown}
                    draggingId={dnd.draggingId}
                    {...activityBarPresetProps}
                    {...activityDockProps("left")}
                    helpContext={currentHelpContext}
                    autoHideReveal
                  />
                  <div
                    className="relative h-full shrink-0"
                    style={{ width: "var(--amby-left-panel-width, 300px)" }}
                  >
                    <PanelHost
                      side="left"
                      activeId={activeBySide.left}
                      props={panelRenderProps}
                      flush
                    />
                    {!isCompactLayout && (
                      <ResizeHandle
                        side="right"
                        active={resizingSide === "left"}
                        onMouseDown={startResize("left")}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          <main
            data-help-area="content"
            ref={mainStageRef}
            className={cn(
              "amby-workspace-stage relative flex flex-1 gap-0 overflow-hidden",
              !rightPanelEnabled && "pr-2",
              isMultiPane && "-mt-11",
            )}
          >
            {splitLayout.leaves.map((leaf) => renderPaneLeaf(leaf))}
            {isMultiPane &&
              splitLayout.dividers.map((divider) => (
                <SplitResizeHandle
                  key={divider.splitId}
                  divider={divider}
                  containerRef={mainStageRef}
                  onResize={(splitId, ratio) =>
                    useTabsStore.getState().setSplitRatio(splitId, ratio)
                  }
                />
              ))}
            <PaneDropOverlay
              hoverTarget={paneDnd.hoverTarget}
              leaves={splitLayout.leaves}
              tabDrag={paneDnd.tabDrag}
            />
          </main>

          {rightPanelEnabled && rightDockPinned && isRightSidebarOpen && (
            <>
              <div
                data-help-area="right-panel"
                style={{
                  width: isRightSidebarVisible ? "var(--amby-right-panel-width, 300px)" : 0,
                  transition:
                    resizingSide === "right" ? "none" : "width 320ms cubic-bezier(0.16, 1, 0.3, 1)",
                }}
                onMouseEnter={() => setSidebarHover("right", true)}
                onMouseLeave={() => setSidebarHover("right", false)}
                className={
                  isCompactLayout
                    ? "fixed bottom-0 right-[var(--amby-dock-width)] top-11 z-40 max-w-[calc(100vw-2.5rem)] overflow-hidden shadow-2xl"
                    : "relative shrink-0 overflow-hidden"
                }
              >
                <div
                  className="relative h-full shrink-0"
                  style={{ width: "var(--amby-right-panel-width, 300px)" }}
                >
                  {!isCompactLayout && (
                    <ResizeHandle
                      side="left"
                      active={resizingSide === "right"}
                      onMouseDown={startResize("right")}
                    />
                  )}
                  <PanelHost side="right" activeId={activeBySide.right} props={panelRenderProps} />
                </div>
              </div>
            </>
          )}
        </div>

        {rightPanelEnabled && rightDockPinned && (
          <ActivityBar
            side="right"
            buttons={rightButtons}
            activeView={activeBySide.right}
            isPanelOpen={isRightSidebarVisible}
            onActivate={handleActivate}
            onMoveToOtherSide={(defId) => moveButtonToSide(defId, "left")}
            onPointerDownButton={dnd.onPointerDown}
            draggingId={dnd.draggingId}
            {...activityBarPresetProps}
            {...activityDockProps("right")}
            helpContext={currentHelpContext}
          />
        )}

        {rightPanelEnabled && !rightDockPinned && (
          <div
            className="amby-sidebar-overlay--right fixed bottom-0 right-0 top-11 z-40 rounded-l-2xl"
            style={{
              width: isRightSidebarVisible
                ? "calc(var(--amby-right-panel-width, 300px) + var(--amby-dock-width))"
                : 4,
              transition:
                resizingSide === "right" ? "none" : "width 320ms cubic-bezier(0.16, 1, 0.3, 1)",
            }}
            onMouseEnter={() => setSidebarHover("right", true)}
            onMouseLeave={() => setSidebarHover("right", false)}
          >
            <div className="flex h-full w-full justify-end overflow-hidden rounded-l-2xl bg-background">
              <div
                className="flex h-full shrink-0"
                style={{
                  width: "calc(var(--amby-right-panel-width, 300px) + var(--amby-dock-width))",
                }}
              >
                <div
                  className="relative h-full shrink-0"
                  style={{ width: "var(--amby-right-panel-width, 300px)" }}
                >
                  {!isCompactLayout && (
                    <ResizeHandle
                      side="left"
                      active={resizingSide === "right"}
                      onMouseDown={startResize("right")}
                    />
                  )}
                  <PanelHost
                    side="right"
                    activeId={activeBySide.right}
                    props={panelRenderProps}
                    flush
                  />
                </div>
                <ActivityBar
                  side="right"
                  buttons={rightButtons}
                  activeView={activeBySide.right}
                  isPanelOpen={isRightSidebarVisible}
                  onActivate={handleActivate}
                  onMoveToOtherSide={(defId) => moveButtonToSide(defId, "left")}
                  onPointerDownButton={dnd.onPointerDown}
                  draggingId={dnd.draggingId}
                  {...activityBarPresetProps}
                  {...activityDockProps("right")}
                  autoHideReveal
                  helpContext={currentHelpContext}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <QuickOpenModal
        open={quickOpenMode !== null}
        onClose={() => setQuickOpenMode(null)}
        treeItems={displayTreeItems}
        vault={vault}
        onSelectFile={quickOpenMode === "new" ? handleOpenInNewTab : handleSelect}
        onNewNote={() => handleNewFileIn(null, quickOpenMode === "new")}
        searchNotes={searchNotes}
        contextItemId={activeFileId}
        createActions={quickOpenCreateActions}
        originSelector={quickOpenMode === "new" ? SPOTLIGHT_ORIGIN.newTab : undefined}
      />

      <SearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        items={displayTreeItems}
        onSelect={handleSelect}
        searchNotes={searchNotes}
        vault={vault}
        contextItemId={activeFileId}
        originSelector={SPOTLIGHT_ORIGIN.dockSearch}
      />

      <VaultManagerDialog
        open={vaultManagerOpen}
        onOpenChange={setVaultManagerOpen}
        vaults={vaults}
        currentPath={vault}
        onSelect={loadVault}
        onOpenVault={handleOpenVault}
        onRename={handleRenameVault}
        onDelete={handleDeleteVault}
        onMove={handleMoveVault}
        onOpenInExplorer={openInExplorer}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open)
          if (!open) setSettingsTarget(null)
        }}
        vault={vault}
        navigationTarget={settingsTarget}
        activeModules={activeModules}
        onModuleEnabledChange={(id, enabled) => setModuleEnabled(id, enabled, { vault })}
        onPresetChange={(id) => void adoptPreset(id)}
      />
      <HelpModal
        open={isHelpOpen}
        onOpenChange={setIsHelpOpen}
        initialContext={currentHelpContext}
      />
      {workspaceProfileDialog}
      <PresetNameDialog
        open={presetNameOpen}
        initialName={t("settings.modules.newPresetDefaultName")}
        onClose={() => setPresetNameOpen(false)}
        onConfirm={savePresetAs}
      />
    </div>
  )
}
