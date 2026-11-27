import { isTauri } from "@/lib/storage"
export const OPEN_RESTORED_VAULT_EVENT = "amby:open-restored-vault"
export async function requestOpenRestoredVault(path: string): Promise<void> {
  if (isTauri()) {
    const { emitTo } = await import("@tauri-apps/api/event")
    await emitTo("main", OPEN_RESTORED_VAULT_EVENT, { path })
  } else {
    window.dispatchEvent(new CustomEvent(OPEN_RESTORED_VAULT_EVENT, { detail: { path } }))
  }
}
