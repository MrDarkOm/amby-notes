import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const warn = vi.fn()
vi.mock("@/lib/logger", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/logger")>()
  return {
    ...original,
    logger: { ...original.logger, warn: (...args: unknown[]) => warn(...args) },
  }
})

import {
  resetTreeViewStorageLog,
  writeManualTreeOrder,
  writeTreeSortSelection,
} from "./tree-view-storage"

describe("tree view storage writes", () => {
  const store = new Map<string, string>()
  let refuse = false

  beforeEach(() => {
    store.clear()
    refuse = false
    warn.mockReset()
    resetTreeViewStorageLog()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (refuse) throw new DOMException("quota", "QuotaExceededError")
        store.set(key, value)
      },
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it("stores the sort and the manual order", () => {
    writeTreeSortSelection("manual", "desc")
    writeManualTreeOrder("/vault", { "": ["a", "b"] })
    expect(JSON.parse(store.get("amby:tree-sort")!)).toEqual({ key: "manual", direction: "desc" })
    expect(JSON.parse(store.get("amby:tree-order:/vault")!)).toEqual({ "": ["a", "b"] })
  })

  it("does not throw when the storage refuses a write, and logs once", () => {
    refuse = true
    expect(() => writeTreeSortSelection("name", "asc")).not.toThrow()
    expect(() => writeManualTreeOrder("/vault", {})).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toBe("tree.view_state_save_failed")
  })
})
