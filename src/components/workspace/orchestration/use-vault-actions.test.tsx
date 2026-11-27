// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
const native = vi.hoisted(() => ({
  listener: null as null | ((event: { payload: { path: string } }) => void),
  stop: vi.fn(),
  label: "main",
}))
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event, listener) => {
    native.listener = listener
    return native.stop
  }),
}))
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: native.label,
    show: vi.fn(async () => {}),
    setFocus: vi.fn(async () => {}),
  }),
}))
vi.mock("@/lib/storage", () => ({ isTauri: () => true, openVault: vi.fn() }))
import { useVaultActions } from "./use-vault-actions"
import { useVaultStore } from "../use-vault-store"
beforeEach(() => {
  vi.clearAllMocks()
  native.listener = null
  native.label = "main"
  useVaultStore.setState({ vaults: [] })
})
afterEach(cleanup)
it("asks for a profile before opening an unknown restored vault", async () => {
  const loadVault = vi.fn(async () => {})
  const select = vi.fn()
  renderHook(() =>
    useVaultActions({
      loadVault,
      setVaults: vi.fn(),
      vault: "/old",
      vaults: [],
      onRequestProfileSelection: select,
    }),
  )
  await waitFor(() => expect(native.listener).not.toBeNull())
  act(() => native.listener!({ payload: { path: "/verified-restored/vault" } }))
  expect(select).toHaveBeenCalledWith("/verified-restored/vault")
  expect(loadVault).not.toHaveBeenCalled()
})
it("uses the normal save-aware loader for a known restored vault and disposes its listener", async () => {
  const loadVault = vi.fn(async () => {})
  useVaultStore.setState({
    vaults: [{ id: "restored", name: "Restored", path: "/verified-restored/vault" }],
  })
  const view = renderHook(() =>
    useVaultActions({
      loadVault,
      setVaults: vi.fn(),
      vault: "/old",
      vaults: useVaultStore.getState().vaults,
    }),
  )
  await waitFor(() => expect(native.listener).not.toBeNull())
  act(() => native.listener!({ payload: { path: "/verified-restored/vault" } }))
  await waitFor(() => expect(loadVault).toHaveBeenCalledWith("/verified-restored/vault"))
  view.unmount()
  expect(native.stop).toHaveBeenCalledTimes(1)
})
