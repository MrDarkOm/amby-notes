// @vitest-environment happy-dom
// The questions of the vault switch and of the migration of ids (docs/notices.md, sections 3, 9 and 10), asked
// in the application before any vault is open. "Cancel" changes nothing; "yes" does what it always did. The
// messages of a failed opening and of the recovery data go to the notification centre without the raw error.
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { confirm } from "@/lib/confirm"
import * as storage from "@/lib/storage"
import { flushAutosaveGeneration } from "./autosave/autosave-lifecycle"
import { useVaultData } from "./use-vault-data"
import { useVaultStore } from "./use-vault-store"
import { useAppNoticesStore } from "./notices/use-app-notices-store"
import { useNoticeToastStore } from "./notices/use-notice-toasts-store"

vi.mock("@/lib/confirm", () => ({ confirm: vi.fn() }))
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}))
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    onCloseRequested: async () => () => {},
    onFocusChanged: async () => () => {},
  }),
}))
vi.mock("./autosave/autosave-lifecycle", async (original) => ({
  ...(await original<typeof import("./autosave/autosave-lifecycle")>()),
  flushAutosaveGeneration: vi.fn(),
}))
vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  isTauri: () => true,
  preflightVault: vi.fn(),
  applyIdMigration: vi.fn(),
  recoverIdMigration: vi.fn(),
  loadVaultData: vi.fn(),
  loadActiveVaultData: vi.fn(),
  startVaultWatcher: vi.fn(async () => {}),
  stopVaultWatcher: vi.fn(async () => {}),
}))

const loaded = (warnings: string[] = []) =>
  ({
    vaultPath: "/new",
    tree: [],
    generation: 2,
    sync: { pathToId: {}, warnings },
  }) as never
const clean = { unfinishedMigrations: [], plannedIdWrites: [] } as never
const unfinished = {
  unfinishedMigrations: [{ files: ["a", "b", "c"], journalPath: "journal.json" }],
  plannedIdWrites: [],
} as never

async function load(path: string | null = "/new") {
  const hook = renderHook(() => useVaultData())
  await act(async () => {
    await hook.result.current.loadVault(path)
  })
  // Whatever the mount started on its own has finished too.
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))
  return hook
}

beforeEach(async () => {
  // A vault opened by an earlier test is remembered as the last one and would be reopened on mount.
  window.localStorage.clear()
  await i18n.changeLanguage("ru")
  vi.mocked(confirm).mockReset()
  vi.mocked(storage.preflightVault).mockReset().mockResolvedValue(clean)
  vi.mocked(storage.applyIdMigration).mockReset()
  vi.mocked(storage.recoverIdMigration)
    .mockReset()
    .mockResolvedValue(undefined as never)
  vi.mocked(storage.loadVaultData).mockReset().mockResolvedValue(loaded())
  vi.mocked(flushAutosaveGeneration)
    .mockReset()
    .mockResolvedValue({ flushed: true, participants: 1 })
  useVaultStore.setState({ ...useVaultStore.getInitialState(), vault: null })
  useAppNoticesStore.setState(useAppNoticesStore.getInitialState())
  useNoticeToastStore.setState(useNoticeToastStore.getInitialState())
})
afterEach(cleanup)

describe("switching a vault after a failed save", () => {
  beforeEach(() => {
    useVaultStore.setState({ vault: "/old", generation: 1 })
    vi.mocked(flushAutosaveGeneration).mockResolvedValue({ flushed: false, participants: 1 })
  })

  it("asks in the application and says that the drafts are kept; the button is a verb", async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    await load()
    expect(confirm).toHaveBeenCalledTimes(1)
    const question = vi.mocked(confirm).mock.calls[0][0]
    expect(question.destructive).toBe(true)
    expect(question.description).toMatch(/черновик/iu)
  })

  it("stays in the old vault on Cancel: nothing is opened", async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    await load()
    expect(storage.loadVaultData).not.toHaveBeenCalled()
    expect(useVaultStore.getState().vault).toBe("/old")
  })

  it("opens the other vault after yes", async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    await load()
    expect(storage.loadVaultData).toHaveBeenCalledWith("/new")
  })

  it("does not ask when everything was saved", async () => {
    vi.mocked(flushAutosaveGeneration).mockResolvedValue({ flushed: true, participants: 1 })
    await load()
    expect(confirm).not.toHaveBeenCalled()
    expect(storage.loadVaultData).toHaveBeenCalledWith("/new")
  })
})

describe("an unfinished migration of ids", () => {
  it("asks to resume with the number of files, then opens the vault once it is finished", async () => {
    vi.mocked(storage.preflightVault).mockResolvedValueOnce(unfinished).mockResolvedValue(clean)
    vi.mocked(confirm).mockResolvedValue(true)
    await load()
    const question = vi.mocked(confirm).mock.calls[0][0]
    expect(question.title + (question.description ?? "")).toContain("3")
    expect(storage.recoverIdMigration).toHaveBeenCalledWith("/new", "journal.json", "resume")
    expect(storage.loadVaultData).toHaveBeenCalledWith("/new")
  })

  it("rolls back when resuming is declined and the rollback is accepted, and still does not open the vault", async () => {
    vi.mocked(storage.preflightVault).mockResolvedValue(unfinished)
    vi.mocked(confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await load()
    expect(confirm).toHaveBeenCalledTimes(2)
    // The second question restores notes from backups: it is dangerous.
    expect(vi.mocked(confirm).mock.calls[1][0].destructive).toBe(true)
    expect(storage.recoverIdMigration).toHaveBeenCalledWith("/new", "journal.json", "rollback")
    expect(storage.loadVaultData).not.toHaveBeenCalled()
  })

  it("is inspect-only when both questions are declined: nothing is changed, the vault is not loaded", async () => {
    vi.mocked(storage.preflightVault).mockResolvedValue(unfinished)
    vi.mocked(confirm).mockResolvedValue(false)
    await load()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(storage.recoverIdMigration).not.toHaveBeenCalled()
    expect(storage.applyIdMigration).not.toHaveBeenCalled()
    expect(storage.loadVaultData).not.toHaveBeenCalled()
  })
})

describe("what is said in the centre", () => {
  it("a vault that did not open is a decision with a toast, and the error stays out of the words", async () => {
    vi.mocked(storage.loadVaultData).mockRejectedValue(new Error("ENOENT /Users/me/Секрет"))
    await load()
    const [notice] = useAppNoticesStore.getState().notices
    expect(notice.level).toBe("decision")
    expect(notice.id).toContain("vault")
    expect(JSON.stringify(notice)).not.toContain("ENOENT")
    expect(JSON.stringify(notice)).not.toContain("Секрет")
    expect(useNoticeToastStore.getState().toasts).toHaveLength(1)
  })

  it("recovery data that was kept and not applied is a warning with the number, and no toast", async () => {
    vi.mocked(storage.loadVaultData).mockResolvedValue(
      loaded(["recovery:batch:/Users/me/x", "recovery:trash:1:Missing", "other"]),
    )
    await load()
    const [notice] = useAppNoticesStore.getState().notices
    expect(notice.level).toBe("warning")
    expect(notice.params).toMatchObject({ count: 2 })
    expect(JSON.stringify(notice)).not.toContain("/Users/me")
    expect(useNoticeToastStore.getState().toasts).toEqual([])
  })

  it("says nothing when there is no recovery data", async () => {
    await load()
    expect(useAppNoticesStore.getState().notices).toEqual([])
  })
})
