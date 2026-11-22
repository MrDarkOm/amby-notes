import { beforeEach, describe, expect, it, vi } from "vitest"
import * as storage from "@/lib/storage"
import { findSyncSnapshot } from "@/lib/notices/sync-snapshot"
import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import * as autosave from "../autosave/autosave-lifecycle"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { canRestore, restoreFromJournal } from "./restore-from-journal"

vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  listSnapshots: vi.fn(),
  restoreSnapshot: vi.fn(),
}))
vi.mock("../autosave/autosave-lifecycle", () => ({
  flushAutosaveGeneration: vi.fn(async () => ({ flushed: true })),
}))

const now = 1_800_000_000_000

beforeEach(() => {
  vi.clearAllMocks()
  useVaultStore.setState({ ...useVaultStore.getInitialState(), vault: "/v", generation: 1 })
  useDocStore.getState().clearDocs()
  useNoticeJournalStore.setState({ vault: null, entries: [] })
})

const merged = (params: Record<string, string>) => {
  useNoticeJournalStore
    .getState()
    .record(
      { kind: "merged", level: "info", subject: "Notes/A.md", params, target: "Notes/A.md" },
      now,
    )
  return useNoticeJournalStore.getState().entries[0]
}

describe("giving back what sync replaced", () => {
  it("finds the snapshot sync took just before, and no other", async () => {
    vi.mocked(storage.listSnapshots).mockResolvedValue([
      { id: "edit", createdAtMs: now - 1000, reason: "edit", sizeBytes: 1 },
      { id: "old", createdAtMs: now - 60 * 60 * 1000, reason: "sync-overwrite", sizeBytes: 1 },
      { id: "sync", createdAtMs: now - 2000, reason: "sync-overwrite", sizeBytes: 1 },
    ])
    expect(await findSyncSnapshot("/v", "Notes/A.md", now)).toBe("sync")
    expect(storage.listSnapshots).toHaveBeenCalledWith("/v/Notes/A.md")
    vi.mocked(storage.listSnapshots).mockResolvedValue([
      { id: "old", createdAtMs: now - 60 * 60 * 1000, reason: "sync-overwrite", sizeBytes: 1 },
    ])
    expect(await findSyncSnapshot("/v", "Notes/A.md", now)).toBeUndefined()
  })

  it("offers Restore only with a snapshot, restores it once and says so", async () => {
    expect(canRestore(merged({ name: "A" }))).toBe(false)
    const entry = merged({ name: "A", snapshotId: "sync" })
    expect(canRestore(entry)).toBe(true)
    expect(await restoreFromJournal(entry)).toBe("restored")
    expect(storage.restoreSnapshot).toHaveBeenCalledWith("sync")
    const after = useNoticeJournalStore.getState().entries[0]
    expect(after.params.restored).toBe("1")
    expect(canRestore(after)).toBe(false)
  })

  it("does not touch a note with unsaved edits", async () => {
    const entry = merged({ name: "A", snapshotId: "sync" })
    vi.mocked(autosave.flushAutosaveGeneration).mockResolvedValueOnce({ flushed: false } as never)
    expect(await restoreFromJournal(entry)).toBe("saveFirst")
    expect(storage.restoreSnapshot).not.toHaveBeenCalled()
  })

  it("keeps the entry and says it failed when the history refuses", async () => {
    const entry = merged({ name: "A", snapshotId: "sync" })
    vi.mocked(storage.restoreSnapshot).mockRejectedValueOnce(new Error("gone"))
    expect(await restoreFromJournal(entry)).toBe("failed")
    expect(canRestore(useNoticeJournalStore.getState().entries[0])).toBe(true)
  })
})
