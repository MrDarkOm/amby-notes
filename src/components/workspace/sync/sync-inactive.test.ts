// Why sync does not work, as the sync button of the dock names it (docs/sync-plan.md, stage Э4,
// the interface). Every state the status of a vault can really have is listed with the reason and
// the action the menu offers. Data safety: an answer that changes or deletes files (a mass change,
// an empty folder, a new reconciliation) is never given from the menu, only after the list in the
// settings (Р8).
import { describe, expect, it } from "vitest"
import type { SyncStatus, VaultSyncStatus } from "@/lib/sync/sync-port"
import { CONNECTED, DISCONNECTED, VAULT_OFF, vaultStatus } from "./fake-sync-port"
import { syncInactiveReason, type SyncAccountProbe, type SyncInactiveInput } from "./sync-inactive"

const connected: SyncAccountProbe = { status: CONNECTED, errorCode: null }
const signedOut: SyncAccountProbe = { status: DISCONNECTED, errorCode: null }

function reason(
  status: VaultSyncStatus | null,
  account: SyncAccountProbe = connected,
  more: Partial<SyncInactiveInput> = {},
) {
  return syncInactiveReason({ status, account, failureCode: null, available: true, ...more })
}

/** A vault that is linked but rests: the application could not start it (runtime.rs `resting_status`). */
const resting = (errorCode: string | null, resumable = true): VaultSyncStatus =>
  vaultStatus({
    enabled: false,
    linked: true,
    resumable,
    phase: "off",
    lastSyncMs: null,
    errorCode,
  })

describe("the sync button names nothing while sync works", () => {
  it("is quiet for idle, a pass, the first pass, conflicts and files that stay behind", () => {
    expect(reason(null)).toBeNull()
    expect(reason(vaultStatus())).toBeNull()
    expect(reason(vaultStatus({ phase: "running" }))).toBeNull()
    expect(reason(vaultStatus({ lastSyncMs: null }))).toBeNull()
    expect(
      reason(
        vaultStatus({
          conflicts: [
            { id: "c1", kind: "bothEdited", originalPath: "a.md", copyPath: "b.md", createdMs: 1 },
          ],
          unsynced: [{ path: "x", reason: "symlink", detail: null }],
          itemErrors: 2,
          needsUpdate: true,
          outgoingPaused: true,
        }),
      ),
    ).toBeNull()
  })
})

describe("the sync button explains a vault that is not synchronised", () => {
  it("the browser build: sync needs the desktop application, nothing to do here", () => {
    expect(reason(VAULT_OFF, signedOut, { available: false })).toMatchObject({
      id: "unavailable",
      action: null,
    })
  })

  it("not signed in: the settings, where the sign-in is", () => {
    expect(reason(VAULT_OFF, signedOut)).toMatchObject({ id: "signedOut", action: "settings" })
  })

  it("the keys of this computer are gone from the key store: sign in again in the settings", () => {
    const keysMissing: SyncStatus = { ...CONNECTED, connected: false, keysMissing: true }
    expect(reason(VAULT_OFF, { status: keysMissing, errorCode: null })).toMatchObject({
      id: "keysMissing",
      action: "settings",
    })
  })

  it("an account that was prepared but not finished: the settings", () => {
    const pending: SyncStatus = { ...DISCONNECTED, pending: true }
    expect(reason(VAULT_OFF, { status: pending, errorCode: null })).toMatchObject({
      id: "pendingAccount",
      action: "settings",
    })
  })

  it("the key store refused to be read: ask it again in place", () => {
    expect(reason(VAULT_OFF, { status: null, errorCode: "keychain_unavailable" })).toMatchObject({
      id: "keychainLocked",
      action: "reconnect",
    })
  })

  it("switched off for this vault and resumable: switch it on again in place", () => {
    expect(reason(resting(null, true))).toMatchObject({ id: "vaultOff", action: "resume" })
  })

  it("signed in but never set up here (or a link of another account): the settings, a space is chosen there", () => {
    expect(reason(VAULT_OFF)).toMatchObject({ id: "vaultNotSetUp", action: "settings" })
    expect(reason(resting(null, false))).toMatchObject({ id: "vaultNotSetUp", action: "settings" })
  })

  it("while the account is still read, a vault that is not linked points to the settings", () => {
    expect(reason(VAULT_OFF, { status: null, errorCode: null })).toMatchObject({
      action: "settings",
    })
  })
})

describe("the sync button explains a vault that could not start", () => {
  it("signed out since: sign in, or sign in again when the keys are missing", () => {
    expect(reason(resting("not_connected", false), signedOut)).toMatchObject({
      id: "signedOut",
      action: "settings",
    })
    const keysMissing: SyncStatus = { ...CONNECTED, connected: false, keysMissing: true }
    expect(
      reason(resting("not_connected", false), { status: keysMissing, errorCode: null }),
    ).toMatchObject({ id: "keysMissing", action: "settings" })
  })

  it("the key store refused at start: ask it again in place", () => {
    expect(reason(resting("keychain_unavailable", false))).toMatchObject({
      id: "keychainLocked",
      action: "reconnect",
    })
  })

  it("the server could not be reached at start: the code in words and a retry in place", () => {
    for (const code of ["network", "timeout", "server_unavailable", "backup_failed"]) {
      expect(reason(resting(code))).toEqual({
        id: "cannotStart",
        action: "reconnect",
        code,
        waitSecs: null,
        count: null,
      })
    }
  })
})

describe("the sync button explains a pass that failed or stopped", () => {
  it("waiting after a failure (Д19): the code, the pause and a pass now", () => {
    expect(
      reason(vaultStatus({ phase: "waiting", errorCode: "network", nextTrySecs: 30 })),
    ).toEqual({ id: "waiting", action: "runNow", code: "network", waitSecs: 30, count: null })
  })

  it("a mass change (Р8) is answered only after the list in the settings", () => {
    const files = [{ path: "a.md", action: "trash" }]
    expect(
      reason(
        vaultStatus({
          phase: "stopped",
          stop: { kind: "massChange", direction: "incoming", total: 42, files },
        }),
      ),
    ).toMatchObject({ id: "stopMassIncoming", action: "settings", count: 42 })
    expect(
      reason(
        vaultStatus({
          phase: "stopped",
          stop: { kind: "massChange", direction: "outgoing", total: 7, files },
        }),
      ),
    ).toMatchObject({ id: "stopMassOutgoing", action: "settings", count: 7 })
  })

  it("the folder is gone: look again in place; it is empty: the settings", () => {
    expect(reason(vaultStatus({ phase: "stopped", stop: { kind: "vaultMissing" } }))).toMatchObject(
      { id: "stopVaultMissing", action: "runNow" },
    )
    expect(reason(vaultStatus({ phase: "stopped", stop: { kind: "vaultEmpty" } }))).toMatchObject({
      id: "stopVaultEmpty",
      action: "settings",
    })
  })

  it("a server that was reset, is behind or rolled back: the settings (a new reconciliation needs a confirmation)", () => {
    for (const [kind, id] of [
      ["serverReset", "stopServerReset"],
      ["serverBehind", "stopServerBehind"],
      ["rollback", "stopRollback"],
    ] as const) {
      expect(reason(vaultStatus({ phase: "stopped", stop: { kind } }))).toMatchObject({
        id,
        action: "settings",
      })
    }
  })

  it("the server no longer accepts this computer, or speaks another protocol: the settings", () => {
    expect(
      reason(
        vaultStatus({
          phase: "stopped",
          stop: { kind: "authRequired" },
          errorCode: "token_revoked",
        }),
      ),
    ).toMatchObject({ id: "stopAuthRequired", action: "settings" })
    expect(
      reason(vaultStatus({ phase: "stopped", stop: { kind: "incompatibleServer" } })),
    ).toMatchObject({ id: "stopIncompatible", action: "settings" })
  })

  it("stopped by a failure without a stop (a newer state, a broken key): the code and the settings", () => {
    expect(reason(vaultStatus({ phase: "stopped", errorCode: "state_newer" }))).toEqual({
      id: "stopped",
      action: "settings",
      code: "state_newer",
      waitSecs: null,
      count: null,
    })
  })

  it("a failed command of the button itself: the code and a retry", () => {
    expect(reason(vaultStatus(), connected, { failureCode: "ipc_failed" })).toEqual({
      id: "failed",
      action: "refresh",
      code: "ipc_failed",
      waitSecs: null,
      count: null,
    })
  })
})

describe("a server copy deleted on purpose is a calm state, not a failure (appendix Л)", () => {
  it("names the deletion and sends the person to choose a space, with no retry", () => {
    // Running session: the pass found its space gone (session.rs `space_deleted`).
    const running = vaultStatus({ enabled: false, phase: "off", errorCode: "space_deleted" })
    expect(reason(running)).toMatchObject({ id: "spaceDeleted", action: "settings" })
    // After a restart the link rests with the switch off; the deletion is still the reason.
    expect(reason(resting("space_deleted"))).toMatchObject({
      id: "spaceDeleted",
      action: "settings",
    })
  })
})
