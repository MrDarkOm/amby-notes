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
    confirmAction: vi.fn(async () => false),
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
    storage.confirmAction.mockReset()
    storage.confirmAction.mockResolvedValue(false)
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

  it("pauses and keeps the baseline when the user keeps the external version", async () => {
    storage.getFileRevision.mockResolvedValue("rev-1")
    storage.writeFile.mockRejectedValue(new storage.FileRevisionConflictError("rev-x"))
    const tracker = new FileRevisionTracker()
    await tracker.baseline("a.canvas")
    const onConflict = vi.fn()
    await expect(tracker.save("a.canvas", "mine", undefined, onConflict)).rejects.toBeInstanceOf(
      FileConflictPausedError,
    )
    expect(onConflict).toHaveBeenCalledOnce()
    expect(storage.confirmAction).toHaveBeenCalledWith("errors.fileChangedExternally")
    // A later attempt still uses the stale baseline, so it conflicts again.
    await expect(tracker.save("a.canvas", "mine", undefined, vi.fn())).rejects.toBeInstanceOf(
      FileConflictPausedError,
    )
    expect(storage.writeFile).toHaveBeenLastCalledWith("a.canvas", "mine", undefined, "rev-1")
  })

  it("overwrites on confirmation using the current disk revision", async () => {
    storage.getFileRevision.mockResolvedValueOnce("rev-1").mockResolvedValueOnce("rev-ext")
    storage.writeFile
      .mockRejectedValueOnce(new storage.FileRevisionConflictError("rev-ext"))
      .mockResolvedValueOnce("rev-mine")
    storage.confirmAction.mockResolvedValue(true)
    const tracker = new FileRevisionTracker()
    await tracker.baseline("a.canvas")
    const onConflict = vi.fn()
    await tracker.save("a.canvas", "mine", "op", onConflict)
    expect(onConflict).not.toHaveBeenCalled()
    expect(storage.writeFile).toHaveBeenNthCalledWith(1, "a.canvas", "mine", "op", "rev-1")
    expect(storage.writeFile).toHaveBeenNthCalledWith(2, "a.canvas", "mine", "op", "rev-ext")
    // The next save continues from the revision just written.
    storage.writeFile.mockResolvedValueOnce("rev-next")
    await tracker.save("a.canvas", "again", undefined, vi.fn())
    expect(storage.writeFile).toHaveBeenLastCalledWith("a.canvas", "again", undefined, "rev-mine")
  })

  it("pauses when the file changes again while the user is deciding", async () => {
    storage.getFileRevision.mockResolvedValue("rev-1")
    storage.writeFile.mockRejectedValue(new storage.FileRevisionConflictError("rev-x"))
    storage.confirmAction.mockResolvedValue(true)
    const tracker = new FileRevisionTracker()
    await tracker.baseline("a.canvas")
    const onConflict = vi.fn()
    await expect(tracker.save("a.canvas", "mine", undefined, onConflict)).rejects.toBeInstanceOf(
      FileConflictPausedError,
    )
    expect(onConflict).toHaveBeenCalledOnce()
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

  it("carries the baseline over a rename so the compare stays meaningful", async () => {
    storage.getFileRevision.mockResolvedValue("rev-1")
    storage.writeFile.mockResolvedValue("rev-2")
    const tracker = new FileRevisionTracker()
    await tracker.baseline("old.canvas")
    tracker.rename("old.canvas", "new.canvas")
    await tracker.save("new.canvas", "x", undefined, vi.fn())
    expect(storage.writeFile).toHaveBeenCalledWith("new.canvas", "x", undefined, "rev-1")
    expect(storage.getFileRevision).toHaveBeenCalledTimes(1)
  })

  it("falls back to the current revision for a path without a baseline", async () => {
    storage.getFileRevision.mockResolvedValue("rev-now")
    storage.writeFile.mockResolvedValue("rev-next")
    await new FileRevisionTracker().save("renamed.canvas", "x", undefined, vi.fn())
    expect(storage.writeFile).toHaveBeenCalledWith("renamed.canvas", "x", undefined, "rev-now")
  })
})
