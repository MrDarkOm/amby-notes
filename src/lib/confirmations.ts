import i18n from "@/lib/i18n"
import type { ConfirmOptions } from "@/lib/confirm"

// The questions the application asks before an action that is hard to undo (docs/notices.md, sections 9 and 10).
// Each is made here, in one place: a title that is a question with the name of the object, one line about what
// happens to the data, a verb for the button. The words are in `confirmations.*` of the locale. A question
// is `destructive` when the action cannot be undone or may lose something; then the button is drawn as dangerous
// and the focus starts on "Cancel".

type Words = Record<string, unknown>

function ask(name: string, params: Words = {}, destructive = false): ConfirmOptions {
  const t = (part: string) => i18n.t(`confirmations.${name}.${part}`, params) as string
  return {
    title: t("title"),
    description: t("description"),
    confirmLabel: t("confirm"),
    ...(destructive ? { destructive: true } : {}),
  }
}

export const confirmations = {
  // History (putting a version back is not asked about: the replaced text becomes a version first)
  deleteVersion: () => ask("deleteVersion", {}, true),
  cleanHistory: (params: { count: number; size: string }) => ask("cleanHistory", params, true),
  clearHistory: (params: { count: number; size: string }) => ask("clearHistory", params, true),
  // Archive, themes, settings, debugging
  deleteArchived: (params: { name: string }) => ask("deleteArchived", params, true),
  resetSettings: () => ask("resetSettings", {}, true),
  deleteDebugHistory: () => ask("deleteDebugHistory", {}, true),
  // The copy of the vault that is kept before sync
  deleteBackup: (params: { date: string }) => ask("deleteBackup", params, true),
  // The amby command in the terminal (Settings → General): names exactly what changes on the computer
  addCliToPath: (params: { change: string }) => ask("addCliToPath", params),
  connectMcpClient: (params: { client: string; vault: string; access: string; how: string }) =>
    ask("connectMcpClient", params),
  deleteOldBackup: (params: { date: string }) => ask("deleteOldBackup", params, true),
  // Layers, connections
  deleteLayer: (params: { layer: string; title: string }) => ask("deleteLayer", params, true),
  // A page of a note: "Delete all" drops its text, "Move" keeps the text on the neighbouring page. Asked by
  // the owner's decision (2026-11-24) although Undo brings the page back: deleting a page is easy to misclick.
  deleteNotePage: (params: { name: string }): ConfirmOptions => ({
    ...ask("deleteNotePage", params, true),
    alternativeLabel: i18n.t("confirmations.deleteNotePage.alternative") as string,
  }),
  // The AI panel's mode that applies every change at once
  aiTurbo: () => ask("aiTurbo", {}, true),
  removeAiConnection: (params: { name: string }) => ask("removeAiConnection", params, true),
  // Notes: a deletion. A rename or a move that rewrites links, and a merge, are not asked about: they
  // can be undone exactly from the line under the tree and the journal (docs/notices.md, section 9).
  deletePermanent: (params: { count: number; name: string }) =>
    ask(params.count > 1 ? "deletePermanentMany" : "deletePermanent", params, true),
  // The vault: a switch after a failed save, the migration of ids
  switchAfterSaveFailure: () => ask("switchAfterSaveFailure", {}, true),
  // Leaving when a note is neither saved nor in a recovery draft (a full disk): its text would be lost
  closeWithUnsavedText: () => ask("closeWithUnsavedText", {}, true),
  switchWithUnsavedText: () => ask("switchWithUnsavedText", {}, true),
  resumeMigration: (params: { files: number }) => ask("resumeMigration", params),
  rollbackMigration: () => ask("rollbackMigration", {}, true),
  // Recovery and conflicts
  /** "Cancel" here drops the draft, so it is worded as "Do not restore". */
  restoreDraft: (): ConfirmOptions => ({
    ...ask("restoreDraft"),
    cancelLabel: i18n.t("confirmations.restoreDraft.cancel") as string,
  }),
  overwriteExternal: () => ask("overwriteExternal", {}, true),
  // Databases
  deleteDatabaseView: (params: { name: string }) => ask("deleteDatabaseView", params, true),
}
