import * as React from "react"
import { HeaderTabs } from "../header-tabs"
import { PaneTabBar } from "../pane-tab-bar"
import { useDocStore } from "../use-doc-store"
import { useTabsStore } from "../use-tabs-store"
import { useVaultStore } from "../use-vault-store"
import { useViewStateStore } from "../use-view-state-store"

/**
 * The tab strips read the state that changes while a person writes (the unsaved mark, the active
 * tab) from its stores themselves, so a change of it renders the strip and not the workspace
 * root with the layout around it (SHELL-04).
 */
type HeaderTabsProps = React.ComponentProps<typeof HeaderTabs>

export type ConnectedHeaderTabsProps = Omit<
  HeaderTabsProps,
  | "unsavedFileIds"
  | "activeTabKey"
  | "activeFileId"
  | "favorites"
  | "vaults"
  | "currentVaultPath"
  | "vaultName"
>

export function ConnectedHeaderTabs(props: ConnectedHeaderTabsProps) {
  const unsavedFileIds = useDocStore((s) => s.unsavedFileIds)
  const activeTabKey = useTabsStore((s) => s.activeTabKey)
  const activeFileId = useTabsStore((s) => s.tabs.find((tab) => tab.key === s.activeTabKey)?.fileId)
  const favorites = useViewStateStore((s) => s.favorites)
  const vaults = useVaultStore((s) => s.vaults)
  const vault = useVaultStore((s) => s.vault)
  const vaultName = vault?.replace(/\\/g, "/").split("/").pop() ?? undefined
  return (
    <HeaderTabs
      {...props}
      unsavedFileIds={unsavedFileIds}
      activeTabKey={activeTabKey}
      activeFileId={activeFileId}
      favorites={favorites}
      vaults={vaults}
      currentVaultPath={vault}
      vaultName={vaultName}
    />
  )
}

export function ConnectedPaneTabBar(
  props: Omit<React.ComponentProps<typeof PaneTabBar>, "unsavedFileIds">,
) {
  const unsavedFileIds = useDocStore((s) => s.unsavedFileIds)
  return <PaneTabBar {...props} unsavedFileIds={unsavedFileIds} />
}
