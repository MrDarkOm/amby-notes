// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

const take = vi.hoisted(() => vi.fn())
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }))
vi.mock("@/lib/storage", () => ({ isTauri: () => true, takeCliOpen: take }))

import { useCliOpenRequests } from "./use-cli-open-requests"
import { useVaultStore } from "../use-vault-store"

afterEach(() => {
  cleanup()
  take.mockReset()
  useVaultStore.setState({ vault: null, switching: false })
})

it("waits for startup and opens queued notes after the normal vault load", async () => {
  take
    .mockResolvedValueOnce({ vault: "/first", path: "one.md" })
    .mockResolvedValueOnce({ vault: "/second", path: "two.md" })
    .mockResolvedValue(null)
  const openPath = vi.fn()
  const loadVault = vi.fn(async (vault: string) => {
    useVaultStore.setState({ switching: true })
    await Promise.resolve()
    useVaultStore.setState({ switching: false, vault })
  })
  const view = renderHook(({ ready }) => useCliOpenRequests("main", ready, loadVault, openPath), {
    initialProps: { ready: false },
  })
  expect(take).not.toHaveBeenCalled()
  view.rerender({ ready: true })
  await waitFor(() => {
    expect(openPath.mock.calls).toEqual([["one.md"], ["two.md"]])
  })
  expect(loadVault.mock.calls).toEqual([["/first"], ["/second"]])
})

it("skips a note when the vault switch is canceled and checks the next request", async () => {
  take
    .mockResolvedValueOnce({ vault: "/canceled", path: "one.md" })
    .mockResolvedValueOnce({ vault: "/current", path: "two.md" })
    .mockResolvedValue(null)
  useVaultStore.setState({ vault: "/current" })
  const openPath = vi.fn()
  const loadVault = vi.fn(async () => {})
  renderHook(() => useCliOpenRequests("main", true, loadVault, openPath))
  await waitFor(() => expect(openPath.mock.calls).toEqual([["two.md"]]))
})
