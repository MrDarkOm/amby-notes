// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useDatabaseLayoutUpgrade } from "./use-database-layout-upgrade"
import { useVaultStore } from "../use-vault-store"
import { useAppNoticesStore } from "../notices/use-app-notices-store"
import { useNoticeToastStore } from "../notices/use-notice-toasts-store"

const port = vi.hoisted(() => ({ scan: vi.fn(), upgrade: vi.fn(), flush: vi.fn() }))
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  resolveDatabaseLayoutPort: () => port,
}))
vi.mock("../autosave/autosave-lifecycle", () => ({
  flushAutosaveGeneration: (...args: unknown[]) => port.flush(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
  port.scan.mockResolvedValue({ pendingDatabases: 2 })
  port.upgrade.mockResolvedValue({ pendingDatabases: 0 })
  port.flush.mockResolvedValue({ flushed: true })
  useVaultStore.setState({ vault: "/vault", generation: 8, backendGeneration: 3, switching: false })
  useAppNoticesStore.setState({ notices: [] })
  useNoticeToastStore.getState().clear()
})
afterEach(cleanup)

it("only scans on opening and upgrades after the explicit action, with one announcement", async () => {
  renderHook(useDatabaseLayoutUpgrade)
  await waitFor(() => expect(useAppNoticesStore.getState().notices).toHaveLength(1))
  expect(port.upgrade).not.toHaveBeenCalled()
  const notice = useAppNoticesStore.getState().notices[0]
  expect(notice.titleKey).toBe("databaseLayout.title")
  expect(useNoticeToastStore.getState().toasts).toHaveLength(1)
  await act(async () => notice.action!.run())
  expect(port.flush).toHaveBeenCalledWith(8)
  expect(port.upgrade).toHaveBeenCalledExactlyOnceWith(3)
  expect(useAppNoticesStore.getState().notices).toHaveLength(0)
})

it("keeps a failed upgrade and its retry in the same notice", async () => {
  port.upgrade.mockRejectedValueOnce(new Error("failed"))
  renderHook(useDatabaseLayoutUpgrade)
  await waitFor(() => expect(useAppNoticesStore.getState().notices).toHaveLength(1))
  await act(async () => useAppNoticesStore.getState().notices[0].action!.run())
  expect(useAppNoticesStore.getState().notices[0].lineKey).toBe("databaseLayout.failed")
  expect(useAppNoticesStore.getState().notices[0].action!.busy).toBe(false)
  expect(useNoticeToastStore.getState().toasts).toHaveLength(1)
  await act(async () => useAppNoticesStore.getState().notices[0].action!.run())
  expect(useAppNoticesStore.getState().notices).toHaveLength(0)
})

it("does not update another vault when a saved action is invoked after a switch", async () => {
  renderHook(useDatabaseLayoutUpgrade)
  await waitFor(() => expect(useAppNoticesStore.getState().notices).toHaveLength(1))
  const oldAction = useAppNoticesStore.getState().notices[0].action!
  act(() => useVaultStore.setState({ vault: "/other", generation: 9, backendGeneration: 4 }))
  await act(async () => oldAction.run())
  expect(port.upgrade).not.toHaveBeenCalled()
})

it("does not start conversion while an unsaved buffer cannot be flushed", async () => {
  port.flush.mockResolvedValue({ flushed: false })
  renderHook(useDatabaseLayoutUpgrade)
  await waitFor(() => expect(useAppNoticesStore.getState().notices).toHaveLength(1))
  await act(async () => useAppNoticesStore.getState().notices[0].action!.run())
  expect(port.upgrade).not.toHaveBeenCalled()
  expect(useAppNoticesStore.getState().notices[0].lineKey).toBe("databaseLayout.failed")
})

it("blocks an earlier action as soon as vault switching begins", async () => {
  renderHook(useDatabaseLayoutUpgrade)
  await waitFor(() => expect(useAppNoticesStore.getState().notices).toHaveLength(1))
  const action = useAppNoticesStore.getState().notices[0].action!
  act(() => useVaultStore.setState({ switching: true }))
  await act(async () => action.run())
  expect(port.upgrade).not.toHaveBeenCalled()
})
