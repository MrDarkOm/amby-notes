import type { CentreStop } from "./centre-entries"

const STOP_TITLES: Record<string, string> = {
  vaultMissing: "sync.vault.stop.missingTitle",
  vaultEmpty: "sync.vault.stop.emptyTitle",
  serverReset: "sync.vault.stop.serverResetTitle",
  serverBehind: "sync.vault.stop.serverBehindTitle",
  rollback: "sync.vault.stop.rollbackTitle",
  authRequired: "sync.vault.stop.authTitle",
  incompatibleServer: "sync.vault.stop.incompatibleTitle",
}

/**
 * The title of a stop of the sync (docs/notices.md, section 10): the locale key and its words. The texts
 * are the ones the settings of the sync already use; the centre adds one short line of its own.
 */
export function stopTitle(stop: CentreStop): { key: string; params: { count: number } } {
  if (stop.kind === "massChange") {
    return {
      key:
        stop.direction === "incoming"
          ? "sync.vault.stop.massIncomingTitle"
          : "sync.vault.stop.massOutgoingTitle",
      params: { count: stop.total },
    }
  }
  return { key: STOP_TITLES[stop.kind] ?? "notices.centre.stopUnknown", params: { count: 0 } }
}
