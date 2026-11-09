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
  // Layers, connections
  deleteLayer: (params: { layer: string; title: string }) => ask("deleteLayer", params, true),
  removeAiConnection: (params: { name: string }) => ask("removeAiConnection", params, true),
  // Notes: links that change, a merge, a deletion
  renameRefactor: (params: { replacements: number; notes: number }) =>
    ask("renameRefactor", params),
  moveRefactor: (params: { replacements: number; notes: number }) => ask("moveRefactor", params),
  mergeNotes: (params: { source: string; target: string }) => ask("mergeNotes", params),
  deletePermanent: (params: { count: number; name: string }) =>
    ask(params.count > 1 ? "deletePermanentMany" : "deletePermanent", params, true),
  // The vault: a switch after a failed save, the migration of ids
  switchAfterSaveFailure: () => ask("switchAfterSaveFailure", {}, true),
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
