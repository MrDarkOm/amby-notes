import { describe, expect, it, vi } from "vitest"

const storage = vi.hoisted(() => ({
  FileRevisionConflictError: class extends Error {},
  getFileRevision: vi.fn(),
  writeFile: vi.fn(async () => "new-revision"),
}))
vi.mock("@/lib/storage", () => storage)
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn() }))
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }))
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }))

import { AutosaveCoordinator, type AutosaveKey } from "./autosave-coordinator"
import { FileRevisionTracker } from "./file-revision-tracker"
import { remapLayerAutosave } from "./remap-layer-autosave"

describe("remapLayerAutosave", () => {
  it("retries the remapped draft at the new path after an older in-flight save fails", async () => {
    let rejectOld!: (error: Error) => void
    const oldSave = new Promise<string>((_resolve, reject) => {
      rejectOld = reject
    })
    storage.writeFile.mockReset()
    storage.writeFile.mockReturnValueOnce(oldSave).mockResolvedValueOnce("new-revision")
    const from: AutosaveKey = { generation: 1, kind: "canvas", documentId: "/vault/old" }
    const to: AutosaveKey = { ...from, documentId: "/vault/new" }
    const revisions = new FileRevisionTracker()
    revisions.commit(from.documentId, "original-revision")
    const queue = new AutosaveCoordinator({
      delayMs: 10_000,
      save: ({ value }: { value: { path: string; json: string } }) =>
        revisions.save(value.path, value.json, undefined, vi.fn()),
    })
    queue.enqueueImmediate(from, { path: from.documentId, json: "draft" })
    await vi.waitFor(() => expect(storage.writeFile).toHaveBeenCalledOnce())
    remapLayerAutosave(queue, revisions, from, to)
    rejectOld(new Error("old path no longer exists"))
    await vi.waitFor(() => expect(storage.writeFile).toHaveBeenCalledTimes(2))
    await queue.flush(to)
    expect(storage.writeFile).toHaveBeenLastCalledWith(
      to.documentId,
      "draft",
      undefined,
      "original-revision",
    )
    expect(queue.inspect(to)?.dirty).toBe(false)
  })

  for (const kind of ["canvas", "sketch"] as const) {
    it(`saves a pending ${kind} at the new path against its original revision`, async () => {
      storage.writeFile.mockReset()
      storage.writeFile.mockResolvedValue("new-revision")
      storage.getFileRevision.mockClear()
      const from: AutosaveKey = { generation: 1, kind, documentId: "/vault/old" }
      const to: AutosaveKey = { ...from, documentId: "/vault/new" }
      const revisions = new FileRevisionTracker()
      revisions.commit(from.documentId, "original-revision")
      const queue = new AutosaveCoordinator({
        delayMs: 10_000,
        save: ({ value }: { value: { path: string; json: string } }) =>
          revisions.save(value.path, value.json, undefined, vi.fn()),
      })
      queue.schedule(from, { path: from.documentId, json: "draft" })
      remapLayerAutosave(queue, revisions, from, to)
      await queue.flush(to)
      expect(storage.writeFile).toHaveBeenCalledExactlyOnceWith(
        to.documentId,
        "draft",
        undefined,
        "original-revision",
      )
      expect(storage.getFileRevision).not.toHaveBeenCalled()
      expect(queue.inspect(to)?.dirty).toBe(false)
    })
  }
})
