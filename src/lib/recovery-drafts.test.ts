import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  discardRecoveryDraft,
  readRecoveryDraft,
  remapRecoveryDraft,
  saveRecoveryDraft,
} from "./recovery-drafts"

describe("recovery drafts", () => {
  const path = "/vault/Note.md"

  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
  })

  afterEach(() => {
    discardRecoveryDraft(path)
    vi.unstubAllGlobals()
  })

  it("keeps an unsaved buffer until a successful save clears it", () => {
    saveRecoveryDraft(path, "unsaved text")
    expect(readRecoveryDraft(path)?.content).toBe("unsaved text")
    discardRecoveryDraft(path)
    expect(readRecoveryDraft(path)).toBeNull()
  })

  it("moves a recovery draft with a renamed canvas", () => {
    const renamedPath = "/vault/Renamed.canvas"
    saveRecoveryDraft(path, '{"nodes":[],"edges":[]}')

    remapRecoveryDraft(path, renamedPath)

    expect(readRecoveryDraft(path)).toBeNull()
    expect(readRecoveryDraft(renamedPath)?.content).toBe('{"nodes":[],"edges":[]}')
    discardRecoveryDraft(renamedPath)
  })
})
