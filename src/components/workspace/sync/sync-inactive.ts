// Why the sync of the open vault does not work, and what fixes it from the sync button of the dock
// (docs/sync-plan.md, stage Э4, the interface). The button opens a small menu with one line of the
// reason and one action instead of a refresh that would do nothing for sync.

import type { TFunction } from "i18next"
import { formatWait, syncCodeMessage } from "@/lib/sync/sync-errors"
import type { SyncStatus, VaultSyncStatus } from "@/lib/sync/sync-port"

/**
 * What the action of the menu does:
 * - `resume` switches sync on again for this vault (the link belongs to this connection);
 * - `reconnect` asks the application to read the key store again (a dialog of the system is
 *   allowed) and to start the sync of the open vault once more;
 * - `runNow` asks for a pass now;
 * - `refresh` repeats the refresh of the button (local files, then a pass);
 * - `settings` opens the sync section of the settings, where the person answers what needs more
 *   than one click (signing in, choosing a space, a list of files to look at).
 */
export type SyncFixAction = "resume" | "reconnect" | "runNow" | "refresh" | "settings"

/** Every reason the menu can name; the text is `sync.inactive.reason.<id>`. */
export type SyncInactiveReasonId =
  | "unavailable"
  | "signedOut"
  | "keysMissing"
  | "pendingAccount"
  | "keychainLocked"
  | "vaultOff"
  | "vaultNotSetUp"
  | "spaceDeleted"
  | "cannotStart"
  | "waiting"
  | "stopMassIncoming"
  | "stopMassOutgoing"
  | "stopVaultMissing"
  | "stopVaultEmpty"
  | "stopServerReset"
  | "stopServerBehind"
  | "stopRollback"
  | "stopAuthRequired"
  | "stopIncompatible"
  | "stopped"
  | "failed"

export interface SyncInactiveReason {
  id: SyncInactiveReasonId
  /** The action of the menu; `null` when there is nothing to do here (the browser build). */
  action: SyncFixAction | null
  /** The machine code behind the reason, shown in words (`cannotStart`, `waiting`, `stopped`, `failed`). */
  code: string | null
  /** Seconds until the next try (`waiting`). */
  waitSecs: number | null
  /** How many files a mass change touches. */
  count: number | null
}

/** The state of the account as the button knows it: the status, or the code of a failed read. */
export interface SyncAccountProbe {
  status: SyncStatus | null
  errorCode: string | null
}

export interface SyncInactiveInput {
  /** The sync status of the open vault; `null` while it is read. */
  status: VaultSyncStatus | null
  account: SyncAccountProbe
  /** The machine code of a failed command of the button itself (a read or a refresh). */
  failureCode: string | null
  /** `false` in the browser build: sync needs the desktop application. */
  available: boolean
}

/**
 * The reason sync does not work, or `null` when it works (idle, a pass, the first pass waiting) or
 * the state is not known yet. Conflicts and files that stay behind are not "inactive": sync runs.
 */
export function syncInactiveReason(input: SyncInactiveInput): SyncInactiveReason | null {
  const { status, account, failureCode, available } = input
  const make = (
    id: SyncInactiveReasonId,
    action: SyncFixAction | null,
    more: Partial<Pick<SyncInactiveReason, "code" | "waitSecs" | "count">> = {},
  ): SyncInactiveReason => ({ id, action, code: null, waitSecs: null, count: null, ...more })

  if (!available) return make("unavailable", null)
  if (failureCode) return make("failed", "refresh", { code: failureCode })
  if (!status) return null

  // A stop of Р8 waits for an answer. Answers that change or delete files are given in the
  // settings, after the list of files and the explanation (data safety).
  if (status.stop) {
    switch (status.stop.kind) {
      case "massChange":
        return make(
          status.stop.direction === "incoming" ? "stopMassIncoming" : "stopMassOutgoing",
          "settings",
          { count: status.stop.total },
        )
      case "vaultMissing":
        return make("stopVaultMissing", "runNow")
      case "vaultEmpty":
        return make("stopVaultEmpty", "settings")
      case "serverReset":
        return make("stopServerReset", "settings")
      case "serverBehind":
        return make("stopServerBehind", "settings")
      case "rollback":
        return make("stopRollback", "settings")
      case "authRequired":
        return make("stopAuthRequired", "settings")
      case "incompatibleServer":
        return make("stopIncompatible", "settings")
    }
  }
  if (status.phase === "stopped") return make("stopped", "settings", { code: status.errorCode })
  if (status.phase === "waiting")
    return make("waiting", "runNow", { code: status.errorCode, waitSecs: status.nextTrySecs })
  if (status.enabled) return null

  // Not running. The account decides whether the device can sync at all.
  const signIn = (): SyncInactiveReason | null => {
    if (account.errorCode === "keychain_unavailable") return make("keychainLocked", "reconnect")
    const known = account.status
    if (!known || known.connected) return null
    if (known.keysMissing) return make("keysMissing", "settings")
    if (known.pending) return make("pendingAccount", "settings")
    return make("signedOut", "settings")
  }
  // A vault that is switched on rests with the code of what kept it from starting
  // (runtime.rs `resting_status`).
  if (status.errorCode === "not_connected") return signIn() ?? make("signedOut", "settings")
  if (status.errorCode === "keychain_unavailable") return make("keychainLocked", "reconnect")
  // The server copy was deleted on purpose (appendix Л): a calm state; switching sync on again is
  // a choice of a space in the settings, never a retry of the old one.
  if (status.errorCode === "space_deleted") return make("spaceDeleted", "settings")
  if (status.errorCode) return make("cannotStart", "reconnect", { code: status.errorCode })
  // `resumable` means the link fits the credentials of this device: it is signed in.
  if (status.linked && status.resumable) return make("vaultOff", "resume")
  return signIn() ?? make("vaultNotSetUp", "settings")
}

/** The one line of the reason in words, also the tooltip of the button. */
export function syncInactiveText(reason: SyncInactiveReason, t: TFunction): string {
  return t(`sync.inactive.reason.${reason.id}`, {
    reason: syncCodeMessage(reason.code ?? "unknown", t),
    wait: formatWait(reason.waitSecs ?? 1, t),
    count: reason.count ?? 0,
  })
}
