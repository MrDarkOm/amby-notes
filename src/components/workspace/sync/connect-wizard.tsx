import type { SyncPort, SyncStatus } from "@/lib/sync/sync-port"

export interface ConnectWizardProps {
  port: SyncPort
  /** Called once the device is connected. */
  onConnected: (status: SyncStatus) => void
  /** Values to start with (a record whose keys were lost keeps the server and the name). */
  initial?: { url?: string; allowHttp?: boolean; username?: string }
  /** The name offered for this device. */
  defaultDeviceName?: string
}

/** The connect wizard: address → create an account / sign in / recover → password → code. */
export function ConnectWizard(props: ConnectWizardProps) {
  void props
  return null
}
