import type { ActiveTabDragState, ActivePaneHoverTarget } from "../pane-dnd"
import type { ActivityButton, PanelId, Side, PanelRenderProps } from "../panel-registry"
import type { LayoutLeafItem, LayoutSplitDivider } from "../split-tree"
import type { ModuleContext } from "../modules"
import type { PanelScope } from "../app-config"
import type { RefreshSync } from "../sync/use-refresh-sync"
import { type SplitPaneOptions, useTabsStore } from "../use-tabs-store"
import type { SpotlightCreateAction } from "../sidebar-search"
import * as React from "react"
import { ActivityBar } from "../activity-bar"
import { PanelHost } from "../panel-host"
import { ResizeHandle } from "../resize-handle"
import type { HeaderTab } from "../header-tabs"
import { ConnectedHeaderTabs } from "./connected-tab-bars"
import type { HelpContext } from "../help-modal"
import type { SettingsNavigationTarget } from "../settings-navigation"
import { cn } from "@/lib/utils"
import { PaneDropOverlay, SplitResizeHandle } from "../pane-tab-bar"
import type { TreeItem } from "../sidebar-tree"
import { flushEditorSerializations } from "../tiptap/editor-serialization-lifecycle"
import { motionTransitions } from "@/lib/motion-config"
import { motion, useTransform } from "motion/react"
import { useOverlaysStore } from "../use-overlays-store"
import { WorkspaceOverlays } from "./workspace-overlays"
import { type PanelPresence, usePanelLength, usePanelPresence } from "./use-panel-presence"

interface WorkspaceNormalLayoutProps {
  headerTabs: HeaderTab[]
  handleTabChange: (key: string) => void
  handleTabClose: (key: string) => void
  toggleSidebar: (side: Side) => void
  isLeftSidebarVisible: boolean
  isRightSidebarVisible: boolean
  leftDockPinned: boolean
  rightDockPinned: boolean
  setDockPinned: (side: Side, pinned: boolean) => void
  loadVault: (path: string | null, activateBackend?: boolean) => Promise<void>
  handleOpenVault: () => Promise<void>
  handleCloseAllTabs: () => void
  isCompactLayout: boolean
  leftWidth: number
  rightPanelEnabled: boolean
  rightWidth: number
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
  resizingSide: Side | null
  setSidebarHover: (side: Side, hovering: boolean) => void
  panelRenderProps: PanelRenderProps
  startResize: (side: "left" | "right") => (e: React.MouseEvent) => void
  mainStageRef: React.RefObject<HTMLElement | null>
  splitLayout: { leaves: LayoutLeafItem[]; dividers: LayoutSplitDivider[] }
  renderPaneLeaf: (leafItem: LayoutLeafItem) => React.JSX.Element
  paneDnd: { tabDrag: ActiveTabDragState | null; hoverTarget: ActivePaneHoverTarget | null }
  rightButtons: ActivityButton[]
  displayTreeItems: TreeItem[]
  handleOpenInNewTab: (fileId: string) => Promise<void>
  handleSelect: (fileId: string, displayTitle?: string) => Promise<void>
  handleNewFileIn: (
    parentId: string | null,
    inNewTab?: boolean,
    initialContent?: string,
  ) => Promise<void>
  quickOpenCreateActions: SpotlightCreateAction[]
  handleRenameVault: (id: string, name: string) => void
  handleDeleteVault: (id: string) => Promise<void>
  handleMoveVault: (id: string) => Promise<void>
  activeModules: string[]
  setModuleEnabled: (id: string, enabled: boolean, ctx: ModuleContext) => Promise<boolean>
  adoptPreset: (id: string) => Promise<void>
  workspaceProfileDialog: React.JSX.Element
  savePresetAs: (label: string) => void
}

export function WorkspaceNormalLayout({
  headerTabs,
  handleTabChange,
  handleTabClose,
  toggleSidebar,
  isLeftSidebarVisible,
  isRightSidebarVisible,
  leftDockPinned,
  rightDockPinned,
  setDockPinned,
  loadVault,
  handleOpenVault,
  handleCloseAllTabs,
  isCompactLayout,
  leftWidth,
  rightPanelEnabled,
  rightWidth,
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
  resizingSide,
  setSidebarHover,
  panelRenderProps,
  startResize,
  mainStageRef,
  splitLayout,
  renderPaneLeaf,
  paneDnd,
  rightButtons,
  displayTreeItems,
  handleOpenInNewTab,
  handleSelect,
  handleNewFileIn,
  quickOpenCreateActions,
  handleRenameVault,
  handleDeleteVault,
  handleMoveVault,
  activeModules,
  setModuleEnabled,
  adoptPreset,
  workspaceProfileDialog,
  savePresetAs,
}: WorkspaceNormalLayoutProps) {
  // One progress per side, for the pinned panel, its overlay and the header alike.
  const leftPanel = usePanelPresence(
    isLeftSidebarVisible,
    !leftDockPinned ? motionTransitions.slow : undefined,
  )
  const rightPanel = usePanelPresence(
    rightPanelEnabled && isRightSidebarVisible,
    !rightDockPinned ? motionTransitions.slow : undefined,
  )
  const leftOverlayOpacity = useTransform(leftPanel.progress, [0, 0.12, 1], [0, 1, 1])
  const leftOverlayX = useTransform(leftPanel.progress, [0, 1], ["-100%", "0%"])
  const rightOverlayOpacity = useTransform(rightPanel.progress, [0, 0.12, 1], [0, 1, 1])
  const rightOverlayX = useTransform(rightPanel.progress, [0, 1], ["100%", "0%"])
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <ConnectedHeaderTabs
        tabs={headerTabs}
        onTabChange={handleTabChange}
        onTabClose={handleTabClose}
        onToggleLeftSidebar={() => toggleSidebar("left")}
        onToggleRightSidebar={() => toggleSidebar("right")}
        leftPanelProgress={leftPanel.progress}
        rightPanelProgress={rightPanel.progress}
        isLeftSidebarOpen={isLeftSidebarVisible}
        isRightSidebarOpen={isRightSidebarVisible}
        isLeftDockPinned={leftDockPinned}
        isRightDockPinned={rightDockPinned}
        onSetLeftDockPinned={(pinned) => setDockPinned("left", pinned)}
        onSetRightDockPinned={(pinned) => setDockPinned("right", pinned)}
        onOpenPlusModal={() => useOverlaysStore.getState().setQuickOpenMode("new")}
        onSwitchVault={loadVault}
        onAddVault={handleOpenVault}
        onManageVaults={() => useOverlaysStore.getState().setVaultManagerOpen(true)}
        onCloseAllTabs={handleCloseAllTabs}
        leftTreeWidth={isCompactLayout ? 0 : leftWidth}
        rightPanelWidth={isCompactLayout || !rightDockPinned || !rightPanelEnabled ? 0 : rightWidth}
        rightPanelEnabled={rightPanelEnabled}
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
          {leftDockPinned && leftPanel.mounted && (
            <>
              <PinnedSidePanel
                side="left"
                presence={leftPanel}
                compact={isCompactLayout}
                onHoverChange={(hover) => setSidebarHover("left", hover)}
              >
                <PanelHost side="left" activeId={activeBySide.left} props={panelRenderProps} />
                {!isCompactLayout && (
                  <ResizeHandle
                    side="right"
                    active={resizingSide === "left"}
                    onMouseDown={startResize("left")}
                  />
                )}
              </PinnedSidePanel>
            </>
          )}

          {!leftDockPinned && (
            <>
              {!leftPanel.mounted && (
                <div
                  className="fixed bottom-0 left-0 top-11 z-40 w-1"
                  onMouseEnter={() => setSidebarHover("left", true)}
                />
              )}
              {leftPanel.mounted && (
                <motion.div
                  className="amby-sidebar-overlay amby-sidebar-overlay--left fixed bottom-0 left-0 top-11 z-40 pb-2"
                  data-open={isLeftSidebarVisible ? "true" : "false"}
                  style={{
                    width: "calc(var(--amby-left-panel-width, 300px) + var(--amby-dock-width))",
                    opacity: leftOverlayOpacity,
                    x: leftOverlayX,
                  }}
                  onMouseEnter={() => setSidebarHover("left", true)}
                  onMouseLeave={() => setSidebarHover("left", false)}
                >
                  <div className="amby-sidebar-overlay-surface flex h-full w-full overflow-hidden">
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
                          rightPanelEnabled
                            ? (defId) => moveButtonToSide(defId, "right")
                            : undefined
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
                </motion.div>
              )}
            </>
          )}

          <main
            data-help-area="content"
            ref={mainStageRef}
            className={cn(
              "amby-workspace-stage relative z-10 flex flex-1 gap-0 overflow-hidden bg-background",
              !leftDockPinned && "pl-2",
              (!rightPanelEnabled || !rightDockPinned) && "pr-2",
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

          {rightPanelEnabled && rightDockPinned && rightPanel.mounted && (
            <>
              <PinnedSidePanel
                side="right"
                presence={rightPanel}
                compact={isCompactLayout}
                onHoverChange={(hover) => setSidebarHover("right", hover)}
              >
                {!isCompactLayout && (
                  <ResizeHandle
                    side="left"
                    active={resizingSide === "right"}
                    onMouseDown={startResize("right")}
                  />
                )}
                <PanelHost side="right" activeId={activeBySide.right} props={panelRenderProps} />
              </PinnedSidePanel>
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
          <>
            {!rightPanel.mounted && (
              <div
                className="fixed bottom-0 right-0 top-11 z-40 w-1"
                onMouseEnter={() => setSidebarHover("right", true)}
              />
            )}
            {rightPanel.mounted && (
              <motion.div
                className="amby-sidebar-overlay amby-sidebar-overlay--right fixed bottom-0 right-0 top-11 z-40 pb-2"
                data-open={isRightSidebarVisible ? "true" : "false"}
                style={{
                  width: "calc(var(--amby-right-panel-width, 300px) + var(--amby-dock-width))",
                  opacity: rightOverlayOpacity,
                  x: rightOverlayX,
                }}
                onMouseEnter={() => setSidebarHover("right", true)}
                onMouseLeave={() => setSidebarHover("right", false)}
              >
                <div className="amby-sidebar-overlay-surface flex h-full w-full justify-end overflow-hidden">
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
              </motion.div>
            )}
          </>
        )}
      </div>

      <WorkspaceOverlays
        displayTreeItems={displayTreeItems}
        quickOpenCreateActions={quickOpenCreateActions}
        handleSelect={handleSelect}
        handleOpenInNewTab={handleOpenInNewTab}
        handleNewFileIn={handleNewFileIn}
        loadVault={loadVault}
        handleOpenVault={handleOpenVault}
        handleRenameVault={handleRenameVault}
        handleDeleteVault={handleDeleteVault}
        handleMoveVault={handleMoveVault}
        activeModules={activeModules}
        setModuleEnabled={setModuleEnabled}
        adoptPreset={adoptPreset}
        currentHelpContext={currentHelpContext}
        savePresetAs={savePresetAs}
      />
      {workspaceProfileDialog}
    </div>
  )
}

/**
 * A pinned side panel. Its outer width follows `presence.progress` directly so the central
 * workspace stage and header columns shift smoothly in lockstep while the inner panel keeps
 * its full width without squishing.
 */
function PinnedSidePanel({
  side,
  presence,
  compact,
  onHoverChange,
  children,
}: {
  side: Side
  presence: PanelPresence
  compact: boolean
  onHoverChange: (hover: boolean) => void
  children: React.ReactNode
}) {
  const width = `var(--amby-${side}-panel-width, 300px)`
  const animatedWidth = usePanelLength(presence.progress, "0px", width)
  const panelOpacity = useTransform(presence.progress, [0, 0.15, 1], [0, 0.25, 1])
  const panelScale = useTransform(presence.progress, [0, 1], [0.985, 1])
  const compactOverlayOpacity = useTransform(presence.progress, [0, 0.2, 1], [0, 0.45, 1])
  const compactOverlayScale = useTransform(presence.progress, [0, 1], [1.03, 1])
  const hover = {
    onMouseEnter: () => onHoverChange(true),
    onMouseLeave: () => onHoverChange(false),
  }

  if (compact) {
    return (
      <motion.div
        data-help-area={`${side}-panel`}
        style={{
          width,
          opacity: compactOverlayOpacity,
          scale: compactOverlayScale,
          transformOrigin: "center center",
        }}
        {...hover}
        className={cn(
          "fixed bottom-0 top-11 z-40 max-w-[calc(100vw-2.5rem)]",
          side === "left"
            ? "amby-sidebar-overlay--compact-left left-[var(--amby-dock-width)]"
            : "amby-sidebar-overlay--compact-right right-[var(--amby-dock-width)]",
        )}
      >
        <div className="relative h-full w-full">{children}</div>
      </motion.div>
    )
  }

  return (
    <motion.div
      data-help-area={`${side}-panel`}
      className={cn(
        "relative z-0 flex shrink-0",
        side === "left" ? "justify-start" : "justify-end",
      )}
      style={{ width: animatedWidth }}
      {...hover}
    >
      <motion.div
        className="relative h-full shrink-0"
        style={{
          width,
          opacity: panelOpacity,
          scale: panelScale,
          transformOrigin: side === "left" ? "left center" : "right center",
        }}
      >
        {children}
      </motion.div>
    </motion.div>
  )
}
