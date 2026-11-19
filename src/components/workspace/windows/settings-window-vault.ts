import * as React from "react"
import { listen } from "@tauri-apps/api/event"
import { adoptAsyncDisposer } from "@/lib/async-disposable"
import { errorType, logger } from "@/lib/logger"
import { useVaultStore } from "../use-vault-store"
import type { VaultActivatedPayload } from "./vault-window-lifecycle"

/** Sent by the main window to every window once a vault is activated in the backend. */
export const VAULT_ACTIVATED_EVENT = "amby:vault-activated"

/**
 * The settings window is its own webview with its own store. Its vault-file writes are bound to
 * the backend generation (IPC-11) the same way the main window's are, so it has to know the
 * generation of the vault it shows: it is passed in the address when the window opens, in every
 * context update from the main window, and in every vault activation.
 */
export function readInitialSettingsGeneration(search: string): number | null {
  const raw = new URLSearchParams(search).get("generation")
  if (raw === null || !/^\d+$/.test(raw)) return null
  return Number(raw)
}

/** Generations only grow: a late message about an older vault cannot bring that vault back. */
export function acceptSettingsGeneration(generation: number | null | undefined): void {
  if (typeof generation !== "number") return
  const current = useVaultStore.getState().backendGeneration
  if (current === null || generation > current) {
    useVaultStore.getState().setBackendGeneration(generation)
  }
}

/** Follows the vault the main window switches to, so the window never writes to the old one. */
export function useSettingsVaultActivation(
  onVault: (path: string) => void,
  enabled: boolean,
): void {
  const onVaultRef = React.useRef(onVault)
  onVaultRef.current = onVault
  React.useEffect(() => {
    if (!enabled) return
    return adoptAsyncDisposer(
      listen<VaultActivatedPayload>(VAULT_ACTIVATED_EVENT, (event) => {
        acceptSettingsGeneration(event.payload.generation)
        onVaultRef.current(event.payload.path)
      }),
      (error) =>
        logger.warn("settings_window.vault_listen_failed", { errorType: errorType(error) }),
    )
  }, [enabled])
}
