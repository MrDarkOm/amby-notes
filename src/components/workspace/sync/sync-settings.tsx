import type { SyncPort } from "@/lib/sync/sync-port"

export interface SyncSettingsProps {
  /** The port to use; the application's own by default. */
  port?: SyncPort
}

/** The "Synchronization" section of the settings (docs/sync-plan.md, Р12). */
export function SyncSettings(props: SyncSettingsProps) {
  void props
  return null
}
