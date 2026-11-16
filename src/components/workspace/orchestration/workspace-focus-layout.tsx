import type { ActivityButton, PanelId, Side, PanelRenderProps } from "../panel-registry"
import type { LayoutLeafItem } from "../split-tree"
import type { ModuleContext } from "../modules"
import type { PanelScope } from "../app-config"
import type { RefreshSync } from "../sync/use-refresh-sync"
import type { SpotlightCreateAction } from "../sidebar-search"
import type { Tab } from "../use-tabs-store"
import type { VaultRecord } from "../workspace-picker"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import { ActivityBar } from "../activity-bar"
import { PanelHost } from "../panel-host"
import { GraphTabView, SurfaceSuspense } from "./lazy-surfaces"
import type { HelpContext } from "../help-modal"
import type { SettingsNavigationTarget } from "../settings-navigation"
import { FolderView } from "../folder-view"
import type { TreeItem } from "../sidebar-tree"
import { ModuleRequiredFallback } from "../editor/module-required-fallback"
import { motionTransitions } from "@/lib/motion-config"
import { WorkspaceOverlays } from "./workspace-overlays"

interface WorkspaceFocusLayoutProps {
  setFocusShowLeft: React.Dispatch<React.SetStateAction<boolean>>
  setFocusShowRight: React.Dispatch<React.SetStateAction<boolean>>
  activeTab: Tab | null
  graphEnabled: boolean
  handleSelect: (fileId: string, displayTitle?: string) => Promise<void>
  vault: string
  treeItems: TreeItem[]
  handleBack: (key?: unknown) => Promise<void> | undefined
  handleOpenInNewTab: (fileId: string) => Promise<void>
  showTagInPanel: (tag: string) => void
  refreshLinkGraph: () => void
  isFocusMode: true
  handleExitFocusMode: () => Promise<void>
  handleEnterFocusMode: () => Promise<void>
  handleForward: (key?: unknown) => Promise<void> | undefined
  canGoBack: boolean
  canGoForward: boolean
  setModuleEnabled: (id: string, enabled: boolean, ctx: ModuleContext) => Promise<boolean>
  creativeEnabled: boolean
  renderCreativeProject: (targetTab?: Tab | null, paneId?: string) => React.JSX.Element | null
  activeFolder: TreeItem | null
  handleNewFileIn: (
    parentId: string | null,
    inNewTab?: boolean,
    initialContent?: string,
  ) => Promise<void>
  handleNewFolderIn: (parentId: string | null, requestedName?: string) => Promise<void>
  handleSetIcon: (id: string, icon: string) => void
  renderCachedTabSurfaces: (
    isFocusMode: boolean,
    leafItem?: LayoutLeafItem | null,
  ) => React.JSX.Element
  focusShowLeft: boolean
  leftButtons: ActivityButton[]
  activeBySide: Record<Side, PanelId | null>
  handleActivate: (defId: string) => void
  rightPanelEnabled: boolean
  moveButtonToSide: (defId: string, targetSide: Side) => void
  dnd: {
    draggingId: string | null
    onPointerDown: (defId: string) => (e: React.PointerEvent<HTMLElement>) => void
  }
  activityBarPresetProps: {
    refreshSync: RefreshSync
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
  panelRenderProps: PanelRenderProps
  focusShowRight: boolean
  rightButtons: ActivityButton[]
  displayTreeItems: TreeItem[]
  activeFileId: string | null
  quickOpenCreateActions: SpotlightCreateAction[]
  vaults: VaultRecord[]
  loadVault: (path: string | null, activateBackend?: boolean) => Promise<void>
  handleOpenVault: () => Promise<void>
  handleRenameVault: (id: string, name: string) => void
  handleDeleteVault: (id: string) => Promise<void>
  handleMoveVault: (id: string) => Promise<void>
  activeModules: string[]
  adoptPreset: (id: string) => Promise<void>
  workspaceProfileDialog: React.JSX.Element
  deleteConfirmationDialog: React.ReactNode
  propertyMigrationDialog: React.JSX.Element
}

export function WorkspaceFocusLayout({
  setFocusShowLeft,
  setFocusShowRight,
  activeTab,
  graphEnabled,
  handleSelect,
  vault,
  treeItems,
  handleBack,
  handleOpenInNewTab,
  showTagInPanel,
  refreshLinkGraph,
  isFocusMode,
  handleExitFocusMode,
  handleEnterFocusMode,
  handleForward,
  canGoBack,
  canGoForward,
  setModuleEnabled,
  creativeEnabled,
  renderCreativeProject,
  activeFolder,
  handleNewFileIn,
  handleNewFolderIn,
  handleSetIcon,
  renderCachedTabSurfaces,
  focusShowLeft,
  leftButtons,
  activeBySide,
  handleActivate,
  rightPanelEnabled,
  moveButtonToSide,
  dnd,
  activityBarPresetProps,
  activityDockProps,
  currentHelpContext,
  panelRenderProps,
  focusShowRight,
  rightButtons,
  displayTreeItems,
  activeFileId,
  quickOpenCreateActions,
  vaults,
  loadVault,
  handleOpenVault,
  handleRenameVault,
  handleDeleteVault,
  handleMoveVault,
  activeModules,
  adoptPreset,
  workspaceProfileDialog,
  deleteConfirmationDialog,
  propertyMigrationDialog,
}: WorkspaceFocusLayoutProps) {
  const { t } = useTranslation()
  return (
    <div
      data-help-area="content"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background"
      onMouseMove={(e) => {
        const w = window.innerWidth
        if (e.clientX < 20) setFocusShowLeft(true)
        if (e.clientX > w - 20) setFocusShowRight(true)
      }}
    >
      {activeTab?.kind === "graph" ? (
        graphEnabled ? (
          <SurfaceSuspense scope="graph">
            <div
              className="amby-workspace-surface relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/80 bg-[var(--note-surface)]"
              style={{ boxShadow: "var(--note-surface-shadow)" }}
            >
              <GraphTabView
                selectedId={null}
                onSelect={handleSelect}
                vault={vault}
                treeItems={treeItems}
                onBack={handleBack}
                onOpenInNewTab={handleOpenInNewTab}
                onTagClick={showTagInPanel}
                onRefresh={refreshLinkGraph}
                isFocusMode={isFocusMode}
                onToggleFocusMode={isFocusMode ? handleExitFocusMode : handleEnterFocusMode}
                onForward={handleForward}
                canGoBack={canGoBack}
                canGoForward={canGoForward}
              />
            </div>
          </SurfaceSuspense>
        ) : (
          <ModuleRequiredFallback
            moduleId="amby.graph"
            moduleName={t("settings.modules.graph")}
            onEnableModule={() => {
              void setModuleEnabled("graph", true, { vault })
            }}
          />
        )
      ) : activeTab?.kind === "creative" ? (
        creativeEnabled ? (
          <SurfaceSuspense scope="creative" resetKey={activeTab?.fileId}>
            <div
              className="amby-workspace-surface relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/80 bg-[var(--note-surface)]"
              style={{ boxShadow: "var(--note-surface-shadow)" }}
            >
              {renderCreativeProject()}
            </div>
          </SurfaceSuspense>
        ) : (
          <ModuleRequiredFallback
            moduleId="amby.creative"
            moduleName={t("creative.welcome.title", "Творческая мастерская")}
            onEnableModule={() => {
              void setModuleEnabled("creative", true, { vault })
            }}
          />
        )
      ) : activeFolder?.type === "folder" ? (
        <FolderView
          folder={activeFolder}
          onOpenItem={handleSelect}
          onNewNote={handleNewFileIn}
          onNewFolder={handleNewFolderIn}
          onIconChange={(icon) => handleSetIcon(activeFolder.id, icon)}
        />
      ) : (
        renderCachedTabSurfaces(true)
      )}

      {/* Left sidebar overlay. */}
      <motion.div
        className="fixed inset-y-0 left-0 z-40 flex flex-col shadow-2xl"
        initial={false}
        animate={{ x: focusShowLeft ? 0 : "-100%" }}
        transition={motionTransitions.panel}
        onMouseLeave={() => setFocusShowLeft(false)}
      >
        <div className="flex min-h-0 flex-1">
          <ActivityBar
            side="left"
            buttons={leftButtons}
            activeView={activeBySide.left}
            isPanelOpen={focusShowLeft}
            onActivate={handleActivate}
            onMoveToOtherSide={
              rightPanelEnabled ? (defId) => moveButtonToSide(defId, "right") : undefined
            }
            onPointerDownButton={dnd.onPointerDown}
            draggingId={dnd.draggingId}
            {...activityBarPresetProps}
            {...activityDockProps("left")}
            autoHideReveal={focusShowLeft}
            helpContext={currentHelpContext}
          />
          <div
            data-help-area="left-panel"
            style={{ width: "var(--amby-left-panel-width, 300px)" }}
            className="min-h-0 shrink-0"
          >
            <PanelHost side="left" activeId={activeBySide.left} props={panelRenderProps} flush />
          </div>
        </div>
      </motion.div>

      {/* Right sidebar overlay */}
      {rightPanelEnabled && (
        <motion.div
          className="fixed inset-y-0 right-0 z-40 flex shadow-2xl"
          initial={false}
          animate={{ x: focusShowRight ? 0 : "100%" }}
          transition={motionTransitions.panel}
          onMouseLeave={() => setFocusShowRight(false)}
        >
          <div
            data-help-area="right-panel"
            style={{ width: "var(--amby-right-panel-width, 300px)" }}
            className="shrink-0"
          >
            <PanelHost side="right" activeId={activeBySide.right} props={panelRenderProps} flush />
          </div>
          <ActivityBar
            side="right"
            buttons={rightButtons}
            activeView={activeBySide.right}
            isPanelOpen={focusShowRight}
            onActivate={handleActivate}
            onMoveToOtherSide={(defId) => moveButtonToSide(defId, "left")}
            onPointerDownButton={dnd.onPointerDown}
            draggingId={dnd.draggingId}
            {...activityBarPresetProps}
            {...activityDockProps("right")}
            autoHideReveal={focusShowRight}
            helpContext={currentHelpContext}
          />
        </motion.div>
      )}

      <WorkspaceOverlays
        vault={vault}
        displayTreeItems={displayTreeItems}
        activeFileId={activeFileId}
        quickOpenCreateActions={quickOpenCreateActions}
        handleSelect={handleSelect}
        handleOpenInNewTab={handleOpenInNewTab}
        handleNewFileIn={handleNewFileIn}
        vaults={vaults}
        loadVault={loadVault}
        handleOpenVault={handleOpenVault}
        handleRenameVault={handleRenameVault}
        handleDeleteVault={handleDeleteVault}
        handleMoveVault={handleMoveVault}
        activeModules={activeModules}
        setModuleEnabled={setModuleEnabled}
        adoptPreset={adoptPreset}
        currentHelpContext={currentHelpContext}
      />
      {workspaceProfileDialog}
      {deleteConfirmationDialog}
      {propertyMigrationDialog}
    </div>
  )
}
