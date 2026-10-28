import { describe, expect, it, vi } from "vitest"
import { flushAutosaveGeneration } from "./autosave/autosave-lifecycle"
import {
  beginPropertyMutation,
  enqueueNoteMutation,
  enqueueNotePropertyMutation,
  propertyReadIsCurrent,
  propertyVersion,
} from "./note-mutation-queue"
vi.mock("@/lib/recovery-drafts", () => ({ flushAllRecoveryDrafts: vi.fn(async () => {}) }))

describe("note mutation ordering", () => {
  it("waits for a property queued after the body before allowing a close", async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const order: string[] = []
    const body = enqueueNoteMutation(10001, "note", async () => {
      order.push("body")
      await pending
    })
    const property = enqueueNotePropertyMutation(10001, "note", async () => {
      order.push("property")
    })
    let closed = false
    const closing = flushAutosaveGeneration(10001).then((result) => {
      closed = result.flushed
      return result
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    release()
    await Promise.all([body, property])
    expect((await closing).flushed).toBe(true)
    expect(order).toEqual(["body", "property"])
  })

  it("rejects a property read that predates a new optimistic edit", () => {
    const original = propertyVersion(10002, "note")
    const edit = beginPropertyMutation(10002, "note")
    expect(propertyReadIsCurrent(10002, "note", original)).toBe(false)
    expect(propertyReadIsCurrent(10002, "note", edit.version)).toBe(false)
    edit.finish()
    expect(propertyReadIsCurrent(10002, "note", original)).toBe(false)
    expect(propertyReadIsCurrent(10002, "note", edit.version)).toBe(true)
  })
})
