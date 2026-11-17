import * as React from "react"
import { useTranslation } from "react-i18next"
import type { ModuleContext } from "../modules"
import { QuickOpenModal } from "../quick-open-modal"
import { SearchModal } from "../search-modal"
import { SPOTLIGHT_ORIGIN } from "../spotlight-motion"
import { SettingsDialog } from "../settings-dialog"
import { HelpModal, type HelpContext } from "../help-modal"
import type { SpotlightCreateAction } from "../sidebar-search"
import type { TreeItem } from "../sidebar-tree"
import { PresetNameDialog } from "../preset-name-dialog"
import { VaultManagerDialog } from "../vault/vault-manager"
import { useOverlaysStore } from "../use-overlays-store"
import { useTabsStore } from "../use-tabs-store"
import { useVaultStore } from "../use-vault-store"
import { searchNotes, revealVaultFolder } from "@/lib/storage"

export interface WorkspaceOverlaysProps {
  displayTreeItems: TreeItem[]
  quickOpenCreateActions: SpotlightCreateAction[]
  handleSelect: (fileId: string, displayTitle?: string) => Promise<void>
  handleOpenInNewTab: (fileId: string) => Promise<void>
  handleNewFileIn: (
    parentId: string | null,
    inNewTab?: boolean,
    initialContent?: string,
  ) => Promise<void>
  loadVault: (path: string | null, activateBackend?: boolean) => Promise<void>
  handleOpenVault: () => Promise<void>
  handleRenameVault: (id: string, name: string) => void
  handleDeleteVault: (id: string) => Promise<void>
  handleMoveVault: (id: string) => Promise<void>
  activeModules: string[]
  setModuleEnabled: (id: string, enabled: boolean, ctx: ModuleContext) => Promise<boolean>
  adoptPreset: (id: string) => Promise<void>
  currentHelpContext: HelpContext
  /** Only the normal layout can save a preset; the focus layout has no such dialog. */
  savePresetAs?: (label: string) => void
}

/**
 * The dialogs the workspace opens over its content. Each reads its own open flag from
 * {@link useOverlaysStore}, so opening one renders that dialog and not the workspace root.
 */
export function WorkspaceOverlays({
  savePresetAs,
  ...props
}: WorkspaceOverlaysProps): React.JSX.Element {
  return (
    <>
      <QuickOpenOverlay {...props} />
      <SearchOverlay {...props} />
      <VaultManagerOverlay {...props} />
      <SettingsOverlay {...props} />
      <HelpOverlay {...props} />
      {savePresetAs && <PresetNameOverlay savePresetAs={savePresetAs} />}
    </>
  )
}

/** The open vault: the overlays exist only while one is open, so it is never null here. */
function useOpenVault(): string {
  return useVaultStore((s) => s.vault) ?? ""
}

function useActiveFileId(): string | null {
  return useTabsStore((s) => s.tabs.find((tab) => tab.key === s.activeTabKey)?.fileId ?? null)
}

function QuickOpenOverlay({
  displayTreeItems,
  quickOpenCreateActions,
  handleSelect,
  handleOpenInNewTab,
  handleNewFileIn,
}: WorkspaceOverlaysProps) {
  const vault = useOpenVault()
  const activeFileId = useActiveFileId()
  const mode = useOverlaysStore((s) => s.quickOpenMode)
  const setMode = useOverlaysStore((s) => s.setQuickOpenMode)
  return (
    <QuickOpenModal
      open={mode !== null}
      onClose={() => setMode(null)}
      treeItems={displayTreeItems}
      vault={vault}
      onSelectFile={mode === "new" ? handleOpenInNewTab : handleSelect}
      onNewNote={() => handleNewFileIn(null, mode === "new")}
      searchNotes={searchNotes}
      contextItemId={activeFileId}
      createActions={quickOpenCreateActions}
      originSelector={mode === "new" ? SPOTLIGHT_ORIGIN.newTab : undefined}
    />
  )
}

function SearchOverlay({ displayTreeItems, handleSelect }: WorkspaceOverlaysProps) {
  const vault = useOpenVault()
  const activeFileId = useActiveFileId()
  const open = useOverlaysStore((s) => s.searchOpen)
  const setOpen = useOverlaysStore((s) => s.setSearchOpen)
  return (
    <SearchModal
      open={open}
      onClose={() => setOpen(false)}
      items={displayTreeItems}
      onSelect={handleSelect}
      searchNotes={searchNotes}
      vault={vault}
      contextItemId={activeFileId}
      originSelector={SPOTLIGHT_ORIGIN.dockSearch}
    />
  )
}

function VaultManagerOverlay({
  loadVault,
  handleOpenVault,
  handleRenameVault,
  handleDeleteVault,
  handleMoveVault,
}: WorkspaceOverlaysProps) {
  const vault = useOpenVault()
  const vaults = useVaultStore((s) => s.vaults)
  const open = useOverlaysStore((s) => s.vaultManagerOpen)
  const setOpen = useOverlaysStore((s) => s.setVaultManagerOpen)
  return (
    <VaultManagerDialog
      open={open}
      onOpenChange={setOpen}
      vaults={vaults}
      currentPath={vault}
      onSelect={loadVault}
      onOpenVault={handleOpenVault}
      onRename={handleRenameVault}
      onDelete={handleDeleteVault}
      onMove={handleMoveVault}
      onRevealVault={revealVaultFolder}
    />
  )
}

function SettingsOverlay({ activeModules, setModuleEnabled, adoptPreset }: WorkspaceOverlaysProps) {
  const vault = useOpenVault()
  const open = useOverlaysStore((s) => s.settingsOpen)
  const target = useOverlaysStore((s) => s.settingsTarget)
  const setOpen = useOverlaysStore((s) => s.setSettingsOpen)
  return (
    <SettingsDialog
      open={open}
      onOpenChange={setOpen}
      vault={vault}
      navigationTarget={target}
      activeModules={activeModules}
      onModuleEnabledChange={(id, enabled) => setModuleEnabled(id, enabled, { vault })}
      onPresetChange={(id) => void adoptPreset(id)}
    />
  )
}

function HelpOverlay({ currentHelpContext }: WorkspaceOverlaysProps) {
  const open = useOverlaysStore((s) => s.helpOpen)
  const setOpen = useOverlaysStore((s) => s.setHelpOpen)
  return <HelpModal open={open} onOpenChange={setOpen} initialContext={currentHelpContext} />
}

function PresetNameOverlay({ savePresetAs }: { savePresetAs: (label: string) => void }) {
  const { t } = useTranslation()
  const open = useOverlaysStore((s) => s.presetNameOpen)
  const setOpen = useOverlaysStore((s) => s.setPresetNameOpen)
  return (
    <PresetNameDialog
      open={open}
      initialName={t("settings.modules.newPresetDefaultName")}
      onClose={() => setOpen(false)}
      onConfirm={savePresetAs}
    />
  )
}
