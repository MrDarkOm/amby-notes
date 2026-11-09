// @vitest-environment happy-dom
// Putting a version back is not asked about (docs/notices.md, section 9): the text it replaces becomes a
// version first, so nothing is lost, and the notice says where the previous state is. Before it the
// unsaved text is written to the file, and if that cannot be done nothing is restored.
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { confirm } from "@/lib/confirm"
import { useVaultStore } from "../use-vault-store"
import { useHistory } from "./use-history"

const storage = vi.hoisted(() => ({
  cleanupHistory: vi.fn(),
  deleteSnapshot: vi.fn(),
  getHistoryStats: vi.fn(),
  listSnapshots: vi.fn(),
  previewHistoryCleanup: vi.fn(),
  readFile: vi.fn(),
  readSnapshotText: vi.fn(),
  restoreSnapshot: vi.fn(),
  isTauri: vi.fn(() => false),
}))
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  ...storage,
}))
const events = vi.hoisted(() => new Map<string, () => void>())
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    events.set(name, handler)
    return () => {
      events.delete(name)
    }
  }),
}))
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn() }))
const flush = vi.hoisted(() => vi.fn())
vi.mock("../autosave/autosave-lifecycle", () => ({ flushAutosaveGeneration: flush }))

const ENTRY = { id: "s1", createdAtMs: 1, reason: "note-save", sizeBytes: 3 }

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  vi.clearAllMocks()
  events.clear()
  storage.isTauri.mockReturnValue(false)
  storage.listSnapshots.mockResolvedValue([ENTRY])
  storage.getHistoryStats.mockResolvedValue({ snapshotCount: 1, noteCount: 1, sizeBytes: 3 })
  storage.restoreSnapshot.mockResolvedValue("/v/Note.md")
  flush.mockResolvedValue({ flushed: true })
  useVaultStore.setState({ generation: 1 })
})

describe("restoring a version", () => {
  it("asks nothing, restores, and says the previous state is in the history", async () => {
    const { result } = renderHook(() => useHistory("/v/Note.md"))
    await waitFor(() => expect(result.current.snapshots).toHaveLength(1))
    await act(async () => {
      await result.current.restore(ENTRY)
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(storage.restoreSnapshot).toHaveBeenCalledWith("s1")
    expect(result.current.notice).toContain("сохранено в истории")
  })

  it("restores nothing when the open text could not be written first", async () => {
    flush.mockResolvedValue({ flushed: false })
    const { result } = renderHook(() => useHistory("/v/Note.md"))
    await waitFor(() => expect(result.current.snapshots).toHaveLength(1))
    await act(async () => {
      await result.current.restore(ENTRY)
    })
    expect(storage.restoreSnapshot).not.toHaveBeenCalled()
    expect(result.current.error).not.toBe("")
  })
})

describe("history updates", () => {
  it("rereads the list when another operation creates a version", async () => {
    storage.isTauri.mockReturnValue(true)
    const { result } = renderHook(() => useHistory("/v/Note.md"))
    await waitFor(() => expect(result.current.snapshots).toHaveLength(1))
    await waitFor(() => expect(events.has("amby:note-written")).toBe(true))
    storage.listSnapshots.mockResolvedValue([ENTRY, { ...ENTRY, id: "s2", createdAtMs: 2 }])
    act(() => events.get("amby:note-written")!())
    await waitFor(() => expect(result.current.snapshots).toHaveLength(2))
    expect(result.current.snapshots[0].id).toBe("s2")
  })
})
