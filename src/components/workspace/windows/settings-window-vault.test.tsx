// @vitest-environment happy-dom
// IPC-11 tail: the settings window is its own webview, so it has to learn the vault generation
// itself and follow the vault the main window switches to. Written before the code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { commands } from "@/lib/bindings"
import { useVaultStore } from "../use-vault-store"
import { saveWorkspaceConfigPatch } from "../app-config"
import {
  VAULT_ACTIVATED_EVENT,
  acceptSettingsGeneration,
  readInitialSettingsGeneration,
  useSettingsVaultActivation,
} from "./settings-window-vault"

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>())
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler)
    return () => listeners.delete(name)
  }),
  emit: vi.fn(),
  emitTo: vi.fn(),
}))

beforeEach(() => {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  listeners.clear()
  useVaultStore.setState({ backendGeneration: null })
})
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  cleanup()
  vi.restoreAllMocks()
})

describe("the generation the settings window knows", () => {
  it("is read from the window address when the window is opened", () => {
    expect(readInitialSettingsGeneration("?ambyView=settings&generation=7")).toBe(7)
    expect(readInitialSettingsGeneration("?ambyView=settings")).toBeNull()
    expect(readInitialSettingsGeneration("?generation=abc")).toBeNull()
  })

  it("only moves forward, so a late message cannot bring an old vault back", () => {
    acceptSettingsGeneration(5)
    acceptSettingsGeneration(4)
    expect(useVaultStore.getState().backendGeneration).toBe(5)
    acceptSettingsGeneration(6)
    acceptSettingsGeneration(null)
    expect(useVaultStore.getState().backendGeneration).toBe(6)
  })

  it("follows the vault activated by the main window and reports its path", async () => {
    acceptSettingsGeneration(3)
    const onVault = vi.fn()
    renderHook(() => useSettingsVaultActivation(onVault, true))
    await vi.waitFor(() => expect(listeners.has(VAULT_ACTIVATED_EVENT)).toBe(true))
    act(() => listeners.get(VAULT_ACTIVATED_EVENT)?.({ payload: { path: "/b", generation: 4 } }))
    expect(useVaultStore.getState().backendGeneration).toBe(4)
    expect(onVault).toHaveBeenCalledWith("/b")
  })
})

describe("a settings-window write is bound to the generation it loaded with", () => {
  it("is refused by the backend after the vault was switched, and carries the new one after the switch", async () => {
    const write = vi
      .spyOn(commands, "writeVaultMeta")
      .mockResolvedValueOnce({ status: "error", error: "vaultGenerationConflict" })
      .mockResolvedValue({ status: "ok", data: null })
    vi.spyOn(commands, "readVaultMeta").mockResolvedValue({ status: "ok", data: null })
    acceptSettingsGeneration(3)
    await expect(
      saveWorkspaceConfigPatch({ confirmations: { confirmFileDelete: false } }),
    ).rejects.toBeDefined()
    expect(write.mock.calls[0][2]).toBe(3)

    acceptSettingsGeneration(4)
    await saveWorkspaceConfigPatch({ confirmations: { confirmFileDelete: false } })
    expect(write.mock.calls[write.mock.calls.length - 1][2]).toBe(4)
  })
})
