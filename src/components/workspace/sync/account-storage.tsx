import type { SyncPort } from "@/lib/sync/sync-port"

export interface AccountStorageProps {
  /** The port to use; the application's own by default. */
  port?: SyncPort
}

/**
 * The section "Хранилища аккаунта" of the synchronisation settings (docs/sync-plan.md, appendix
 * Е, У1, У2, У4): the plan and its limits, the gauge of the used place, and one row per storage.
 *
 * STUB of the red-tests step: renders nothing. The contract the tests fix is in
 * `account-storage.test.tsx`.
 */
export function AccountStorage({ port }: AccountStorageProps) {
  void port
  return null
}
