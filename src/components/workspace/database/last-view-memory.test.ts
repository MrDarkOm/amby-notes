import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  readLastView,
  rememberBlockView,
  rememberLastView,
  rememberedBlockView,
} from "./last-view-memory"

function installStorage() {
  const data = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
  })
}

describe("last view memory", () => {
  beforeEach(installStorage)
  afterEach(() => vi.unstubAllGlobals())

  it("remembers the last view of a database", () => {
    expect(readLastView("db")).toBeNull()
    rememberLastView("db", "v2")
    rememberLastView("db", "v3")
    expect(readLastView("db")).toBe("v3")
    expect(readLastView("other")).toBeNull()
  })

  it("finds an embedded block's tab through any of its view ids", () => {
    rememberBlockView(["a", "b", "c"], "b")
    expect(rememberedBlockView(["a", "b", "c"])).toBe("b")
    // A tab was deleted: the choice survives while its own tab does.
    expect(rememberedBlockView(["a", "b"])).toBe("b")
    // The chosen tab was deleted: nothing to restore.
    expect(rememberedBlockView(["a", "c"])).toBeNull()
  })

  it("does not remember a block with a single tab", () => {
    rememberBlockView(["a"], "a")
    expect(localStorage.getItem("amby:db-last-views")).toBeNull()
  })

  it("survives broken storage content", () => {
    localStorage.setItem("amby:db-last-views", "{not json")
    expect(readLastView("db")).toBeNull()
    rememberLastView("db", "v1")
    expect(readLastView("db")).toBe("v1")
  })

  it("keeps the memory bounded, dropping the oldest entries", () => {
    for (let i = 0; i < 320; i++) rememberLastView(`db${i}`, "v")
    expect(readLastView("db0")).toBeNull()
    expect(readLastView("db319")).toBe("v")
  })
})
