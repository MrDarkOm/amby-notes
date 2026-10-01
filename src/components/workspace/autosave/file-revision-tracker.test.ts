import { beforeEach, describe, expect, it, vi } from "vitest"

const storage = vi.hoisted(() => {
  class FileRevisionConflictError extends Error {
    constructor(public readonly actualRevision: string) {
      super("conflict")
    }
  }
  return {
    FileRevisionConflictError,
    getFileRevision: vi.fn(),
    writeFile: vi.fn(),
    showErrorMessage: vi.fn(async () => undefined),
  }
})
vi.mock("@/lib/storage", () => storage)
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }))
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }))

import { FileConflictPausedError, FileRevisionTracker } from "./file-revision-tracker"

describe("FileRevisionTracker", () => {
  beforeEach(() => {
    storage.getFileRevision.mockReset()
    storage.writeFile.mockReset()
    storage.showErrorMessage.mockClear()
  })

  it("saves against the baseline and advances it with each write", async () => {
    storage.getFileRevision.mockResolvedValue("rev-1")
    storage.writeFile.mockResolvedValueOnce("rev-2").mockResolvedValueOnce("rev-3")
    const tracker = new FileRevisionTracker()
    await tracker.baseline("a.canvas")
    await tracker.save("a.canvas", "one", "op1", vi.fn())
    await tracker.save("a.canvas", "two", "op2", vi.fn())
    expect(storage.writeFile).toHaveBeenNthCalledWith(1, "a.canvas", "one", "op1", "rev-1")
    expect(storage.writeFile).toHaveBeenNthCalledWith(2, "a.canvas", "two", "op2", "rev-2")
  })

  it("pauses, warns and keeps the baseline on an external edit", async () => {
    storage.getFileRevision.mockResolvedValue("rev-1")
    storage.writeFile.mockRejectedValue(new storage.FileRevisionConflictError("rev-x"))
    const tracker = new FileRevisionTracker()
    await tracker.baseline("a.canvas")
    const onConflict = vi.fn()
    await expect(tracker.save("a.canvas", "mine", undefined, onConflict)).rejects.toBeInstanceOf(
      FileConflictPausedError,
    )
    expect(onConflict).toHaveBeenCalledOnce()
    expect(storage.showErrorMessage).toHaveBeenCalledWith("errors.fileChangedExternally")
    // A later attempt still uses the stale baseline, so it conflicts again.
    await expect(tracker.save("a.canvas", "mine", undefined, vi.fn())).rejects.toBeInstanceOf(
      FileConflictPausedError,
    )
    expect(storage.writeFile).toHaveBeenLastCalledWith("a.canvas", "mine", undefined, "rev-1")
  })

  it("rethrows other failures without pausing", async () => {
    storage.getFileRevision.mockResolvedValue("rev-1")
    storage.writeFile.mockRejectedValue(new Error("disk full"))
    const tracker = new FileRevisionTracker()
    await tracker.baseline("a.canvas")
    const onConflict = vi.fn()
    await expect(tracker.save("a.canvas", "x", undefined, onConflict)).rejects.toThrow("disk full")
    expect(onConflict).not.toHaveBeenCalled()
  })

  it("falls back to the current revision for a path without a baseline", async () => {
    storage.getFileRevision.mockResolvedValue("rev-now")
    storage.writeFile.mockResolvedValue("rev-next")
    await new FileRevisionTracker().save("renamed.canvas", "x", undefined, vi.fn())
    expect(storage.writeFile).toHaveBeenCalledWith("renamed.canvas", "x", undefined, "rev-now")
  })
})
