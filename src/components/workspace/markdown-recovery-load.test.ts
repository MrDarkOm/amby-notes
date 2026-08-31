import { describe, expect, it, vi } from "vitest"
import type { RecoveryDraft } from "@/lib/recovery-drafts"
import { InFlightDocumentLoads, resolveMarkdownRecoveryLoad } from "./markdown-recovery-load"

function draft(content: string): RecoveryDraft {
  return { content, savedAt: 1, documentKind: "markdown" }
}

describe("Markdown recovery load", () => {
  it("restores a differing draft after confirmation", async () => {
    const confirmRestore = vi.fn(async () => true)

    await expect(
      resolveMarkdownRecoveryLoad({
        fileId: "note-id",
        path: "/vault/Note.md",
        diskContent: "disk",
        readDraft: async (id) => (id === "note-id" ? draft("recovered") : null),
        confirmRestore,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({
      status: "ready",
      content: "recovered",
      restored: true,
      discardDraft: false,
    })
    expect(confirmRestore).toHaveBeenCalledOnce()
  })

  it("keeps disk content and requests draft cleanup after decline", async () => {
    await expect(
      resolveMarkdownRecoveryLoad({
        fileId: "note-id",
        path: "/vault/Note.md",
        diskContent: "disk",
        readDraft: async () => draft("recovered"),
        confirmRestore: async () => false,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({
      status: "ready",
      content: "disk",
      restored: false,
      discardDraft: true,
    })
  })

  it("discards an equal draft without prompting", async () => {
    const confirmRestore = vi.fn(async () => true)

    const result = await resolveMarkdownRecoveryLoad({
      fileId: "note-id",
      path: "/vault/Note.md",
      diskContent: "same",
      readDraft: async () => draft("same"),
      confirmRestore,
      isCurrent: () => true,
    })

    expect(result).toEqual({
      status: "ready",
      content: "same",
      restored: false,
      discardDraft: true,
    })
    expect(confirmRestore).not.toHaveBeenCalled()
  })

  it("falls back to a path-keyed legacy draft", async () => {
    const reads: string[] = []

    const result = await resolveMarkdownRecoveryLoad({
      fileId: "note-id",
      path: "/vault/Note.md",
      diskContent: "disk",
      readDraft: async (id) => {
        reads.push(id)
        return id === "/vault/Note.md" ? draft("path recovery") : null
      },
      confirmRestore: async () => true,
      isCurrent: () => true,
    })

    expect(reads).toEqual(["note-id", "/vault/Note.md"])
    expect(result).toMatchObject({ status: "ready", content: "path recovery", restored: true })
  })

  it("abandons a decision when the vault changes while its prompt is open", async () => {
    let current = true
    const result = await resolveMarkdownRecoveryLoad({
      fileId: "note-id",
      path: "/vault/Note.md",
      diskContent: "disk",
      readDraft: async () => draft("recovered"),
      confirmRestore: async () => {
        current = false
        return false
      },
      isCurrent: () => current,
    })

    expect(result).toEqual({ status: "stale" })
  })

  it("shares one in-flight decision across session and ordinary open entry points", async () => {
    const registry = new InFlightDocumentLoads<string>()
    let resolve!: (value: string) => void
    const pending = new Promise<string>((done) => {
      resolve = done
    })
    const load = vi.fn(() => pending)

    const fromSession = registry.run("vault:1", "note-id", load)
    const fromClick = registry.run("vault:1", "note-id", load)
    expect(fromClick).toBe(fromSession)
    expect(load).toHaveBeenCalledOnce()

    resolve("loaded")
    await expect(fromSession).resolves.toBe("loaded")
  })

  it("allows a retry after a failed in-flight load", async () => {
    const registry = new InFlightDocumentLoads<string>()

    await expect(
      registry.run("vault:1", "note-id", async () => Promise.reject(new Error("read failed"))),
    ).rejects.toThrow("read failed")
    await expect(
      registry.run("vault:1", "note-id", async () => Promise.resolve("retried")),
    ).resolves.toBe("retried")
  })
})
