import { describe, expect, it } from "vitest"
import { EditorSurfaceLeaseManager } from "./editor-surface-lease"

describe("EditorSurfaceLeaseManager", () => {
  it("allows one writable owner and ignores stale releases", () => {
    const manager = new EditorSurfaceLeaseManager()
    expect(manager.acquire("note-1", "databasePeek", "a")).toBe(true)
    expect(manager.acquire("note-1", "document", "b")).toBe(false)
    manager.release("note-1", "b")
    expect(manager.owner("note-1")).toBe("databasePeek")
    manager.release("note-1", "a")
    expect(manager.owner("note-1")).toBeNull()
  })
})
