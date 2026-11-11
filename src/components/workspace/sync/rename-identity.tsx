import type { SyncPort } from "@/lib/sync/sync-port"
export type RenameIdentityFormProps = { port: SyncPort; onClose: (changed: boolean) => void } & (
  { mode: "account"; username: string } | { mode: "device"; deviceId: string; name: string }
)
/** Inline identity editor; implementation follows its behavioral tests. */
export function RenameIdentityForm(_props: RenameIdentityFormProps) {
  return null
}
