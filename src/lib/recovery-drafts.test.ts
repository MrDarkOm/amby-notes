import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  discardRecoveryDraft,
  migrateLegacyRecoveryDrafts,
  readRecoveryDraft,
  remapRecoveryDraft,
  scheduleRecoveryDraft,
  flushRecoveryDraft,
  saveRecoveryDraft,
} from "./recovery-drafts"
import { commands, type RecoveryEntry } from "@/lib/bindings"

describe("recovery drafts", () => {
  const path = "/vault/Note.md"

  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe("web / localStorage fallback", () => {
    it("coalesces rapid edits while preserving the latest snapshot", async () => {
      vi.useFakeTimers()
      const setItem = vi.spyOn(localStorage, "setItem")
      scheduleRecoveryDraft(path, "first", "markdown", path)
      scheduleRecoveryDraft(path, "second", "markdown", path)
      scheduleRecoveryDraft(path, "latest", "markdown", path)

      await flushRecoveryDraft(path, "markdown")

      expect((await readRecoveryDraft(path))?.content).toBe("latest")
      expect(setItem).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it("keeps an unsaved buffer until a successful save clears it", async () => {
      await saveRecoveryDraft(path, "unsaved text")
      expect((await readRecoveryDraft(path))?.content).toBe("unsaved text")
      await discardRecoveryDraft(path)
      expect(await readRecoveryDraft(path)).toBeNull()
    })

    it("moves a recovery draft with a renamed canvas", async () => {
      const renamedPath = "/vault/Renamed.canvas"
      await saveRecoveryDraft(path, '{"nodes":[],"edges":[]}')

      await remapRecoveryDraft(path, renamedPath)

      expect(await readRecoveryDraft(path)).toBeNull()
      expect((await readRecoveryDraft(renamedPath))?.content).toBe('{"nodes":[],"edges":[]}')
      await discardRecoveryDraft(renamedPath)
    })

    it("ignores and cleans up expired or corrupt drafts", async () => {
      const expiredKey = "amby:recovery-draft:" + encodeURIComponent("/vault/Expired.md")
      localStorage.setItem(
        expiredKey,
        JSON.stringify({ content: "old", savedAt: Date.now() - 15 * 24 * 60 * 60 * 1_000 }),
      )
      expect(await readRecoveryDraft("/vault/Expired.md")).toBeNull()
      expect(localStorage.getItem(expiredKey)).toBeNull()

      const corruptKey = "amby:recovery-draft:" + encodeURIComponent("/vault/Corrupt.md")
      localStorage.setItem(corruptKey, "not valid json")
      expect(await readRecoveryDraft("/vault/Corrupt.md")).toBeNull()
    })
  })

  it("does not turn later edits into immediate writes after the first recovery save", async () => {
    vi.useFakeTimers()
    const setItem = vi.spyOn(localStorage, "setItem")
    const scopedPath = "/vault/coalesced-after-first.md"
    scheduleRecoveryDraft(scopedPath, "first", "markdown", scopedPath)
    await Promise.resolve()
    expect(setItem).toHaveBeenCalledTimes(1)

    scheduleRecoveryDraft(scopedPath, "second", "markdown", scopedPath)
    scheduleRecoveryDraft(scopedPath, "latest", "markdown", scopedPath)
    expect(setItem).toHaveBeenCalledTimes(1)
    await flushRecoveryDraft(scopedPath, "markdown")
    expect(setItem).toHaveBeenCalledTimes(2)
    expect((await readRecoveryDraft(scopedPath))?.content).toBe("latest")
    await discardRecoveryDraft(scopedPath)
    vi.useRealTimers()
  })

  describe("desktop mode with Tauri IPC", () => {
    beforeEach(() => {
      vi.stubGlobal("window", {
        __TAURI_INTERNALS__: {},
      })
    })

    it("routes save, read, and delete through generated IPC commands", async () => {
      const mockEntry: RecoveryEntry = {
        version: 1,
        vaultGeneration: 1,
        documentKind: "markdown",
        id: "note-123",
        pathHint: "/vault/Note.md",
        savedAtMs: 123456789,
        content: "desktop draft content",
        contentHash: "hash123",
      }

      vi.spyOn(commands, "saveRecovery").mockResolvedValue({
        status: "ok",
        data: mockEntry,
      })
      vi.spyOn(commands, "readRecovery").mockResolvedValue({
        status: "ok",
        data: mockEntry,
      })
      vi.spyOn(commands, "deleteRecovery").mockResolvedValue({
        status: "ok",
        data: null,
      })

      await saveRecoveryDraft("note-123", "desktop draft content", "markdown", "/vault/Note.md")
      expect(commands.saveRecovery).toHaveBeenCalledWith(
        "note-123",
        "markdown",
        "/vault/Note.md",
        "desktop draft content",
        null,
        null,
      )

      const read = await readRecoveryDraft("note-123")
      expect(read).toEqual({
        content: "desktop draft content",
        savedAt: 123456789,
        id: "note-123",
        documentKind: "markdown",
        pathHint: "/vault/Note.md",
      })

      await discardRecoveryDraft("note-123")
      expect(commands.readRecovery).toHaveBeenCalledWith("note-123", null, null)
      expect(commands.deleteRecovery).toHaveBeenCalledWith("note-123", "hash123", null, null)
    })

    it("migrates valid legacy localStorage drafts to backend journal and clears localStorage only on success", async () => {
      const legacyKey = "amby:recovery-draft:" + encodeURIComponent("/vault/Legacy.md")
      localStorage.setItem(
        legacyKey,
        JSON.stringify({ content: "legacy content", savedAt: Date.now() }),
      )

      const savedEntry: RecoveryEntry = {
        version: 1,
        vaultGeneration: 1,
        documentKind: "markdown",
        id: "/vault/Legacy.md",
        pathHint: "/vault/Legacy.md",
        savedAtMs: Date.now(),
        content: "legacy content",
        contentHash: "abc",
      }

      vi.spyOn(commands, "saveRecovery").mockResolvedValue({
        status: "ok",
        data: savedEntry,
      })
      vi.spyOn(commands, "readRecovery").mockResolvedValue({
        status: "ok",
        data: savedEntry,
      })

      const count = await migrateLegacyRecoveryDrafts()
      expect(count).toBe(1)
      expect(commands.saveRecovery).toHaveBeenCalledWith(
        "/vault/Legacy.md",
        "markdown",
        "/vault/Legacy.md",
        "legacy content",
        null,
        null,
      )
      // Cleared from localStorage after verified write
      expect(localStorage.getItem(legacyKey)).toBeNull()
    })

    it("cleans up corrupt legacy localStorage entries during migration without calling save", async () => {
      const corruptKey = "amby:recovery-draft:" + encodeURIComponent("/vault/Corrupt.md")
      localStorage.setItem(corruptKey, "{ broken")

      const saveSpy = vi.spyOn(commands, "saveRecovery")

      const count = await migrateLegacyRecoveryDrafts()
      expect(count).toBe(0)
      expect(saveSpy).not.toHaveBeenCalled()
      expect(localStorage.getItem(corruptKey)).toBeNull()
    })

    it("preserves legacy localStorage entries if backend journal write fails", async () => {
      const legacyKey = "amby:recovery-draft:" + encodeURIComponent("/vault/Failed.md")
      localStorage.setItem(legacyKey, JSON.stringify({ content: "keep me", savedAt: Date.now() }))

      vi.spyOn(commands, "saveRecovery").mockRejectedValue(new Error("disk full"))

      const count = await migrateLegacyRecoveryDrafts()
      expect(count).toBe(0)
      // Must NOT be deleted if save failed!
      expect(localStorage.getItem(legacyKey)).not.toBeNull()
    })

    it("does not migrate a legacy draft from another vault", async () => {
      const currentKey = "amby:recovery-draft:" + encodeURIComponent("/vault/Current.md")
      const otherKey = "amby:recovery-draft:" + encodeURIComponent("/other/Other.md")
      localStorage.setItem(currentKey, JSON.stringify({ content: "current", savedAt: Date.now() }))
      localStorage.setItem(otherKey, JSON.stringify({ content: "other", savedAt: Date.now() }))

      const save = vi.spyOn(commands, "saveRecovery").mockImplementation(async (id) => ({
        status: "ok",
        data: {
          version: 1,
          vaultGeneration: 5,
          documentKind: "markdown",
          id,
          pathHint: id,
          savedAtMs: Date.now(),
          content: id.endsWith("Current.md") ? "current" : "other",
          contentHash: "hash",
        },
      }))
      vi.spyOn(commands, "readRecovery").mockResolvedValue({
        status: "ok",
        data: {
          version: 1,
          vaultGeneration: 5,
          documentKind: "markdown",
          id: "/vault/Current.md",
          pathHint: "/vault/Current.md",
          savedAtMs: Date.now(),
          content: "current",
          contentHash: "hash",
        },
      })

      const count = await migrateLegacyRecoveryDrafts({ vault: "/vault", generation: 5 })
      expect(count).toBe(1)
      expect(save).toHaveBeenCalledOnce()
      expect(save.mock.calls[0][0]).toBe("/vault/Current.md")
      expect(localStorage.getItem(currentKey)).toBeNull()
      expect(localStorage.getItem(otherKey)).not.toBeNull()
    })

    it("does not let an old discard remove a newer draft", async () => {
      const oldEntry: RecoveryEntry = {
        version: 1,
        vaultGeneration: 1,
        documentKind: "markdown",
        id: "stale-discard-test",
        pathHint: "/vault/stale.md",
        savedAtMs: Date.now(),
        content: "old",
        contentHash: "old-hash",
      }
      const newerEntry = { ...oldEntry, content: "new", contentHash: "new-hash" }
      let resolveFirst!: (value: { status: "ok"; data: RecoveryEntry }) => void
      let saveCount = 0
      vi.spyOn(commands, "saveRecovery").mockImplementation(async () => {
        saveCount += 1
        if (saveCount === 1)
          return new Promise((resolve) => {
            resolveFirst = resolve as typeof resolveFirst
          })
        return { status: "ok", data: newerEntry }
      })
      vi.spyOn(commands, "deleteRecovery").mockResolvedValue({ status: "ok", data: null })
      vi.spyOn(commands, "readRecovery").mockResolvedValue({ status: "ok", data: newerEntry })

      scheduleRecoveryDraft("stale-discard-test", "old", "markdown", "/vault/stale.md")
      const discard = discardRecoveryDraft("stale-discard-test")
      await Promise.resolve()
      scheduleRecoveryDraft("stale-discard-test", "new", "markdown", "/vault/stale.md")
      resolveFirst({ status: "ok", data: oldEntry })
      await discard

      expect(commands.deleteRecovery).not.toHaveBeenCalled()
      expect((await readRecoveryDraft("stale-discard-test"))?.content).toBe("new")
      await flushRecoveryDraft("stale-discard-test", "markdown")
      await discardRecoveryDraft("stale-discard-test")
    })
  })
})
