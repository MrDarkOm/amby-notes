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

  it("does not prompt when disk and draft are the same empty Sketch", () => {
    const disk = '{"type":"excalidraw","elements":[],"appState":{"viewBackgroundColor":"#ffffff"}}'
    const draft = '{"type":"excalidraw","elements":[],"appState":{"viewBackgroundColor":"#ffffff"}}'
    expect(recoveryNeedsConfirmation(disk, `${draft}\n`)).toBe(false)
  })

  it("asks when a Sketch draft differs only in appState", () => {
    const disk = '{"type":"excalidraw","elements":[],"appState":{"viewBackgroundColor":"#ffffff"}}'
    const draft = '{"type":"excalidraw","elements":[],"appState":{"viewBackgroundColor":"#000000"}}'
    expect(recoveryNeedsConfirmation(disk, draft)).toBe(true)
    expect(resolveRecoveryContent(disk, draft, true)).toEqual({
      content: draft,
      restored: true,
      discardDraft: false,
    })
  })

  it("asks when a draft differs only in whitespace at the edges", () => {
    expect(recoveryNeedsConfirmation("text", "text\n")).toBe(true)
    expect(recoveryNeedsConfirmation("text", "  text")).toBe(true)
    expect(recoveryNeedsConfirmation("", "\n  \n")).toBe(true)
    expect(resolveRecoveryContent("text", "text\n", false).discardDraft).toBe(true)
    expect(resolveRecoveryContent("text", "text\n", true)).toEqual({
      content: "text\n",
      restored: true,
      discardDraft: false,
    })
  })

  it("treats a draft that differs only in line endings as equal", () => {
    expect(recoveryNeedsConfirmation("a\r\nb\r\n", "a\nb\n")).toBe(false)
  })
})
