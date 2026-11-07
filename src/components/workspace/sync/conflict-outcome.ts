import { relativeToVault } from "../editor/document-breadcrumbs-utils"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import {
  useSyncNoticesStore,
  type OutcomeChoice,
  type SyncConflict,
} from "./use-sync-notices-store"

/** The name of a file as the person knows it: no folders, no extension (docs/notices.md, section 10). */
export function conflictName(path: string): string {
  const file = path.replace(/\\/gu, "/").split("/").pop() ?? path
  // Same rule as the engine's `<ext>`: one to eight letters or digits after the last dot that is not the first.
  return file.replace(/(?<=.)\.[A-Za-z0-9]{1,8}$/u, "")
}

/**
 * Says what was done after a choice in the comparison: a card in the note when it is open, a line in the
 * list of conflicts when it is not (the list is opened again if the person came from it). Nothing is said
 * for a failed choice: the caller records an outcome only after the port has answered.
 */
export function recordConflictOutcome(conflict: SyncConflict, choice: OutcomeChoice): void {
  const vault = useVaultStore.getState().vault
  const path = conflict.originalPath.normalize("NFC")
  const open =
    vault !== null &&
    Object.values(useDocStore.getState().openDocs).some(
      (doc) => relativeToVault(doc.path, vault).normalize("NFC") === path,
    )
  useSyncNoticesStore.getState().addOutcome({
    conflictId: conflict.id,
    path,
    name: conflictName(conflict.originalPath),
    choice,
    where: open ? "card" : "list",
  })
}
