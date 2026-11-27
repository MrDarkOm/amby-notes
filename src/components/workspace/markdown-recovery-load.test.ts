import { describe, expect, it, vi } from "vitest"
import type { RecoveryDraft } from "@/lib/recovery-drafts"
import { InFlightDocumentLoads, resolveMarkdownRecoveryLoad } from "./markdown-recovery-load"

function draft(content: string): RecoveryDraft {
  return { content, savedAt: 1, documentKind: "markdown" }
}

describe("Markdown recovery load", () => {
  it("offers a differing draft instead of asking: the note opens with the disk text", async () => {
    await expect(
      resolveMarkdownRecoveryLoad({
        fileId: "note-id",
        path: "/vault/Note.md",
        diskContent: "disk",
        readDraft: async (id) => (id === "note-id" ? draft("recovered") : null),
        isCurrent: () => true,
      }),
    ).resolves.toEqual({
      status: "ready",
      content: "disk",
      offer: "recovered",
      discardDraft: false,
    })
  })

  it("discards an equal draft without an offer", async () => {
    const result = await resolveMarkdownRecoveryLoad({
      fileId: "note-id",
      path: "/vault/Note.md",
      diskContent: "same",
      readDraft: async () => draft("same"),
      isCurrent: () => true,
    })

    expect(result).toEqual({
      status: "ready",
      content: "same",
      offer: null,
      discardDraft: true,
    })
  })

  it("has nothing to do without a draft", async () => {
    await expect(
      resolveMarkdownRecoveryLoad({
        fileId: "note-id",
        path: "/vault/Note.md",
        diskContent: "disk",
        readDraft: async () => null,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({ status: "ready", content: "disk", offer: null, discardDraft: false })
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
      isCurrent: () => true,
    })

    expect(reads).toEqual(["note-id", "/vault/Note.md"])
    expect(result).toMatchObject({ status: "ready", content: "disk", offer: "path recovery" })
  })

  it("abandons the decision when the vault changes while the draft is read", async () => {
    let current = true
    const result = await resolveMarkdownRecoveryLoad({
      fileId: "note-id",
      path: "/vault/Note.md",
      diskContent: "disk",
      readDraft: async () => {
        current = false
        return draft("recovered")
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
