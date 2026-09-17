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

  it("does not prompt when both disk and draft represent empty Canvas", () => {
    expect(recoveryNeedsConfirmation("{}", '{\n  "nodes": [],\n  "edges": []\n}\n')).toBe(false)
    expect(resolveRecoveryContent("{}", '{\n  "nodes": [],\n  "edges": []\n}\n', false)).toEqual({
      content: "{}",
      restored: false,
      discardDraft: true,
    })
  })

  it("does not prompt when both disk and draft represent empty Sketch", () => {
    const disk = '{"type":"excalidraw","elements":[],"appState":{"viewBackgroundColor":"#ffffff"}}'
    const draft =
      '{"type":"excalidraw","elements":[],"appState":{"viewBackgroundColor":"#ffffff","currentItemStrokeColor":"#1e1e1e"}}'
    expect(recoveryNeedsConfirmation(disk, draft)).toBe(false)
    expect(resolveRecoveryContent(disk, draft, false)).toEqual({
      content: disk,
      restored: false,
      discardDraft: true,
    })
  })

  it("does not prompt when both disk and draft are whitespace", () => {
    expect(recoveryNeedsConfirmation("", "\n  \n")).toBe(false)
    expect(resolveRecoveryContent("", "\n  \n", false)).toEqual({
      content: "",
      restored: false,
      discardDraft: true,
    })
  })
})
