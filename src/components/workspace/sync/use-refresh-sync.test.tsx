// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SyncPortError } from "@/lib/sync/sync-port"
import { useVaultStore } from "../use-vault-store"
import {
  CONNECTED,
  DISCONNECTED,
  createFakePort,
  emitVaultStatus,
  VAULT_OFF,
  vaultStatus,
} from "./fake-sync-port"
import { refreshSyncState, useRefreshSync } from "./use-refresh-sync"

afterEach(cleanup)
beforeEach(() => useVaultStore.setState({ vault: "/test", generation: 1, switching: false }))

describe("refresh and sync", () => {
  it("reloads local files before requesting sync and coalesces repeated clicks", async () => {
    const port = createFakePort({ vaultStatus: async () => vaultStatus() })
    let finish!: () => void
    const reload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const { result } = renderHook(() => useRefreshSync(reload, port))
    await waitFor(() => expect(result.current.state).toBe("synced"))
    let pending!: Promise<void>
    act(() => {
      pending = result.current.refresh()
      void result.current.refresh()
    })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(port.runNow).not.toHaveBeenCalled()
    await act(async () => {
      finish()
      await pending
    })
    expect(port.runNow).toHaveBeenCalledTimes(1)
    act(() => emitVaultStatus(vaultStatus({ phase: "running" })))
    expect(result.current.state).toBe("running")
    act(() => emitVaultStatus(vaultStatus()))
    expect(result.current.state).toBe("synced")
  })

  it("refreshes local-only vaults without enabling sync", async () => {
    const port = createFakePort({ vaultStatus: async () => VAULT_OFF })
    const reload = vi.fn(async () => {})
    const { result } = renderHook(() => useRefreshSync(reload, port))
    await waitFor(() => expect(result.current.state).toBe("local"))
    await act(() => result.current.refresh())
    expect(reload).toHaveBeenCalledTimes(1)
    expect(port.runNow).not.toHaveBeenCalled()
    expect(port.enableVault).not.toHaveBeenCalled()
  })

  it("shows command failures until a new status arrives", async () => {
    const port = createFakePort({
      vaultStatus: async () => vaultStatus(),
      runNow: async () => {
        throw new SyncPortError("ipc_failed")
      },
    })
    const { result } = renderHook(() => useRefreshSync(async () => {}, port))
    await waitFor(() => expect(result.current.state).toBe("synced"))
    await act(() => result.current.refresh())
    expect(result.current.state).toBe("problem")
    act(() => emitVaultStatus(vaultStatus()))
    expect(result.current.state).toBe("synced")
  })

  it("does not start sync after a failed local refresh", async () => {
    const port = createFakePort({ vaultStatus: async () => vaultStatus() })
    const { result } = renderHook(() =>
      useRefreshSync(async () => {
        throw new Error("reload")
      }, port),
    )
    await act(() => result.current.refresh())
    expect(result.current.state).toBe("problem")
    expect(port.runNow).not.toHaveBeenCalled()
  })

  it("does not request a pass for another vault after switching during refresh", async () => {
    const port = createFakePort({ vaultStatus: async () => vaultStatus() })
    let finish!: () => void
    const { result } = renderHook(() =>
      useRefreshSync(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
        port,
      ),
    )
    let pending!: Promise<void>
    act(() => {
      pending = result.current.refresh()
    })
    act(() => useVaultStore.getState().setVault("/other"))
    await act(async () => {
      finish()
      await pending
    })
    expect(port.runNow).not.toHaveBeenCalled()
  })

  it("does not let an old initial read overwrite an event", async () => {
    let finish!: (status: ReturnType<typeof vaultStatus>) => void
    const port = createFakePort({
      vaultStatus: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    const { result } = renderHook(() => useRefreshSync(async () => {}, port))
    await act(async () => {
      emitVaultStatus(vaultStatus({ phase: "waiting" }))
      finish(VAULT_OFF)
    })
    expect(result.current.state).toBe("problem")
  })
})

it("never reports incomplete or blocked sync as synced", () => {
  expect(refreshSyncState(vaultStatus({ lastSyncMs: null }))).toBe("pending")
  for (const status of [
    vaultStatus({ phase: "waiting" }),
    vaultStatus({ phase: "stopped" }),
    vaultStatus({ itemErrors: 1 }),
    vaultStatus({ outgoingPaused: true }),
    vaultStatus({ needsUpdate: true }),
    vaultStatus({ unsynced: [{ path: "note.md", reason: "size_limit", detail: null }] }),
  ])
    expect(refreshSyncState(status)).toBe("problem")
})

// Stage Э4, the interface: a click on an inactive sync button names the reason and fixes it in place.
describe("the reason and the action of an inactive sync button", () => {
  const resting = (errorCode: string | null) =>
    vaultStatus({ enabled: false, linked: true, resumable: true, phase: "off", errorCode })

  it("asks the account without a dialog of the key store and names a vault that is not signed in", async () => {
    const port = createFakePort({ vaultStatus: async () => VAULT_OFF })
    const { result } = renderHook(() => useRefreshSync(async () => {}, port))
    await waitFor(() => expect(result.current.inactive?.id).toBe("signedOut"))
    expect(port.status).toHaveBeenCalled()
    expect(port.status).not.toHaveBeenCalledWith(true)
  })

  it("reads the account again when the status of the vault changes (signing in elsewhere)", async () => {
    let account = DISCONNECTED
    const port = createFakePort({ vaultStatus: async () => VAULT_OFF, status: async () => account })
    const { result } = renderHook(() => useRefreshSync(async () => {}, port))
    await waitFor(() => expect(result.current.inactive?.id).toBe("signedOut"))
    account = CONNECTED
    act(() => emitVaultStatus(VAULT_OFF))
    await waitFor(() => expect(result.current.inactive?.id).toBe("vaultNotSetUp"))
  })

  it("is null while sync works", async () => {
    const port = createFakePort({
      vaultStatus: async () => vaultStatus(),
      status: async () => CONNECTED,
    })
    const { result } = renderHook(() => useRefreshSync(async () => {}, port))
    await waitFor(() => expect(result.current.state).toBe("synced"))
    expect(result.current.inactive).toBeNull()
  })

  it("resume switches sync on again for this vault, without reloading the files", async () => {
    const reload = vi.fn(async () => {})
    const port = createFakePort({
      vaultStatus: async () => resting(null),
      status: async () => CONNECTED,
      enableVault: async () => vaultStatus(),
    })
    const { result } = renderHook(() => useRefreshSync(reload, port))
    await waitFor(() => expect(result.current.inactive?.action).toBe("resume"))
    await act(() => result.current.fix("resume"))
    expect(port.enableVault).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
    expect(result.current.inactive).toBeNull()
    expect(result.current.state).toBe("synced")
  })

  it("reconnect asks the key store with a dialog allowed and reads the account again", async () => {
    const port = createFakePort({
      vaultStatus: async () => resting("keychain_unavailable"),
      status: async (interactive) => {
        if (interactive) return CONNECTED
        throw new SyncPortError("keychain_unavailable")
      },
    })
    const { result } = renderHook(() => useRefreshSync(async () => {}, port))
    await waitFor(() => expect(result.current.inactive?.id).toBe("keychainLocked"))
    await act(() => result.current.fix("reconnect"))
    expect(port.status).toHaveBeenCalledWith(true)
    // The application restarts the sync of the vault and announces the new status.
    act(() => emitVaultStatus(vaultStatus()))
    expect(result.current.inactive).toBeNull()
  })

  it("runNow asks for a pass now", async () => {
    const port = createFakePort({
      vaultStatus: async () =>
        vaultStatus({ phase: "waiting", errorCode: "network", nextTrySecs: 9 }),
      status: async () => CONNECTED,
    })
    const { result } = renderHook(() => useRefreshSync(async () => {}, port))
    await waitFor(() => expect(result.current.inactive?.id).toBe("waiting"))
    await act(() => result.current.fix("runNow"))
    expect(port.runNow).toHaveBeenCalledTimes(1)
  })

  it("keeps the failure of an action beside the reason, and forgets it with a new status", async () => {
    const port = createFakePort({
      vaultStatus: async () => resting(null),
      status: async () => CONNECTED,
      enableVault: async () => {
        throw new SyncPortError("network")
      },
    })
    const { result } = renderHook(() => useRefreshSync(async () => {}, port))
    await waitFor(() => expect(result.current.inactive?.id).toBe("vaultOff"))
    await act(() => result.current.fix("resume"))
    expect(result.current.fixError).toBeInstanceOf(SyncPortError)
    expect(result.current.inactive?.id).toBe("vaultOff")
    expect(result.current.fixBusy).toBe(false)
    act(() => emitVaultStatus(resting(null)))
    expect(result.current.fixError).toBeNull()
  })

  it("names a failed refresh and repeats it", async () => {
    const reload = vi.fn(async () => {
      throw new SyncPortError("storage_error")
    })
    const port = createFakePort({
      vaultStatus: async () => vaultStatus(),
      status: async () => CONNECTED,
    })
    const { result } = renderHook(() => useRefreshSync(reload, port))
    await waitFor(() => expect(result.current.state).toBe("synced"))
    await act(() => result.current.refresh())
    expect(result.current.inactive).toMatchObject({ id: "failed", code: "storage_error" })
    await act(() => result.current.fix("refresh"))
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
