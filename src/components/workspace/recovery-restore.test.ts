import { describe, expect, it } from "vitest"
import { recoveryNeedsConfirmation, resolveRecoveryContent } from "./recovery-restore"

describe("recovery restore decisions", () => {
  it("keeps the disk Canvas when a stale draft is declined", () => {
    const result = resolveRecoveryContent('{"nodes":["disk"]}', '{"nodes":["draft"]}', false)

    expect(recoveryNeedsConfirmation('{"nodes":["disk"]}', '{"nodes":["draft"]}')).toBe(true)
    expect(result).toEqual({
      content: '{"nodes":["disk"]}',
      restored: false,
      discardDraft: true,
    })
  })

  it("restores a confirmed stale Canvas draft without discarding its journal entry", () => {
    expect(resolveRecoveryContent('{"nodes":[]}', '{"nodes":["draft"]}', true)).toEqual({
      content: '{"nodes":["draft"]}',
      restored: true,
      discardDraft: false,
    })
  })

  it("does not prompt for an already-persisted recovery draft", () => {
    expect(recoveryNeedsConfirmation('{"nodes":[]}', '{"nodes":[]}')).toBe(false)
    expect(resolveRecoveryContent('{"nodes":[]}', '{"nodes":[]}', false)).toEqual({
      content: '{"nodes":[]}',
      restored: false,
      discardDraft: true,
    })
  })
})
