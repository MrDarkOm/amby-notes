import type { SyncPort } from "@/lib/sync/sync-port"

export interface SyncVaultPanelProps {
  /** The port to use. */
  port: SyncPort
}

/**
 * Sync of the open vault (docs/sync-plan.md, stage Э4): switching it on, the status, the answers to
 * the stops of Р8, the list of conflicts and the list of files that are not synchronised.
 *
 * Interface of stage Э4 (tests first): the screen is written after its tests.
 */
export function SyncVaultPanel(props: SyncVaultPanelProps) {
  void props
  return <section data-testid="sync-vault" />
}
