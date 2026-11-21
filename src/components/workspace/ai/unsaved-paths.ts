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

/** Is `path` one of the `affected` items or inside one of them (a folder covers what is in it)? */
export function isAffected(path: string, affected: readonly string[]): boolean {
  return affected.some((item) => path === item || path.startsWith(`${item}/`))
}
