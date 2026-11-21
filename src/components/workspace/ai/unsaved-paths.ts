import { useDocStore } from "../use-doc-store"
import { toRelativeVaultPath } from "../workspace-tree-utils"

/** Vault-relative paths of the open notes that have unsaved edits. */
export function unsavedVaultPaths(vault: string | null): string[] {
  const { openDocs, unsavedFileIds } = useDocStore.getState()
  return [...unsavedFileIds].flatMap((id) => {
    const path = openDocs[id]?.path
    return path ? [toRelativeVaultPath(path, vault)] : []
  })
}
