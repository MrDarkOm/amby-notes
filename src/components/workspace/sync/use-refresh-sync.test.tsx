// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SyncPortError } from "@/lib/sync/sync-port"
import { useVaultStore } from "../use-vault-store"
import { createFakePort, emitVaultStatus, VAULT_OFF, vaultStatus } from "./fake-sync-port"
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
