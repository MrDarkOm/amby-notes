import { afterEach, describe, expect, it } from "vitest"
import {
  clearSourceRewriteSnapshots,
  pendingSourceRewriteSnapshot,
  requestSourceRewriteSnapshot,
  settleSourceRewriteSnapshot,
} from "./source-rewrite"

afterEach(clearSourceRewriteSnapshots)

describe("history snapshot before a block's source is rewritten", () => {
  it("is carried by the save that starts after the request and cleared when it succeeds", () => {
    expect(pendingSourceRewriteSnapshot("note")).toBeNull()
    requestSourceRewriteSnapshot("note")
    const request = pendingSourceRewriteSnapshot("note")
    expect(request).not.toBeNull()
    expect(pendingSourceRewriteSnapshot("other")).toBeNull()
    settleSourceRewriteSnapshot("note", request)
    expect(pendingSourceRewriteSnapshot("note")).toBeNull()
  })

  it("survives a save that failed", () => {
    requestSourceRewriteSnapshot("note")
    const request = pendingSourceRewriteSnapshot("note")
    // The write threw: nothing is settled, and the retry carries the request again.
    expect(pendingSourceRewriteSnapshot("note")).toBe(request)
  })

  it("is not consumed by a save that was already in flight", () => {
    // The save started before the editor rewrote a block: it carries older content.
    const inFlight = pendingSourceRewriteSnapshot("note")
    requestSourceRewriteSnapshot("note")
    settleSourceRewriteSnapshot("note", inFlight)
    expect(pendingSourceRewriteSnapshot("note")).not.toBeNull()
  })

  it("keeps a newer request made while the save carrying an older one was in flight", () => {
    requestSourceRewriteSnapshot("note")
    const first = pendingSourceRewriteSnapshot("note")
    requestSourceRewriteSnapshot("note")
    settleSourceRewriteSnapshot("note", first)
    expect(pendingSourceRewriteSnapshot("note")).not.toBeNull()
  })
})
