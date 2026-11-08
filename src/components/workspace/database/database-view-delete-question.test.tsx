// @vitest-environment happy-dom
// Deleting a view of a database used the window of the browser (docs/notices.md, section 9). Now the application
// asks; "Cancel" leaves the view and does not even mark the screen busy; "yes" deletes it as before.
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { confirm } from "@/lib/confirm"
import * as storage from "@/lib/storage"
import { useDatabaseViewActions } from "./use-database-view-actions"

vi.mock("@/lib/confirm", () => ({ confirm: vi.fn() }))
vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  deleteDatabaseView: vi.fn(),
}))

const database = {
  databaseId: "db1",
  manifestRevision: "m1",
  views: [
    { viewId: "v1", name: "Таблица", revision: "r1" },
    { viewId: "v2", name: "Доска", revision: "r2" },
  ],
} as never

function setup() {
  const setMutationBusy = vi.fn()
  const retry = vi.fn().mockResolvedValue(undefined)
  const hook = renderHook(() =>
    useDatabaseViewActions({
      setMutationError: vi.fn(),
      setMutationBusy,
      mutationBusy: false,
      onCatalogChanged: undefined,
      retry,
      setSelectedViewId: vi.fn(),
      database,
      vaultGeneration: 1,
      databaseId: "db1",
      isDatabaseLocked: false,
      activeView: undefined,
      initialPresentation: undefined,
    }),
  )
  return { hook, setMutationBusy }
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  vi.mocked(confirm).mockReset()
  vi.mocked(storage.deleteDatabaseView)
    .mockReset()
    .mockResolvedValue(undefined as never)
})
afterEach(cleanup)

describe("deleting a view", () => {
  it("asks in the application, names the view, and Cancel deletes nothing", async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const { hook, setMutationBusy } = setup()
    await act(() => hook.result.current.mutateView("delete", "v1"))
    expect(confirm).toHaveBeenCalledTimes(1)
    const question = vi.mocked(confirm).mock.calls[0][0]
    expect(question.destructive).toBe(true)
    expect(question.title).toContain("Таблица")
    expect(storage.deleteDatabaseView).not.toHaveBeenCalled()
    expect(setMutationBusy).not.toHaveBeenCalled()
  })

  it("deletes the view after yes", async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    const { hook } = setup()
    await act(() => hook.result.current.mutateView("delete", "v1"))
    expect(storage.deleteDatabaseView).toHaveBeenCalledWith(
      expect.objectContaining({ databaseId: "db1", viewId: "v1" }),
    )
  })

  it("does not ask about a duplicate", async () => {
    const { hook } = setup()
    await act(() => hook.result.current.mutateView("default", "v1")).catch(() => {})
    expect(confirm).not.toHaveBeenCalled()
  })
})
