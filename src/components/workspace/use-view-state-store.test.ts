import { beforeEach, describe, expect, it } from "vitest"
import { useViewStateStore } from "./use-view-state-store"
import { remapPath } from "./workspace-mutations"

const session = { icons: {}, favorites: [], viewModes: {}, lockedFileIds: [] }
beforeEach(() => useViewStateStore.getState().hydrateFromSession(session))

describe("tree view state", () => {
  it("restores collapsed branches and resets them when another vault has no saved state", () => {
    useViewStateStore
      .getState()
      .hydrateFromSession({ ...session, closedTreeIds: ["folder", "note"] })
    useViewStateStore.getState().expandTreeItem("note")
    expect([...useViewStateStore.getState().closedTreeIds]).toEqual(["folder"])
    useViewStateStore.getState().hydrateFromSession(session)
    expect(useViewStateStore.getState().closedTreeIds.size).toBe(0)
  })

  it("remaps collapsed folder paths and web note IDs while keeping stable IDs", () => {
    useViewStateStore.getState().hydrateFromSession({
      ...session,
      closedTreeIds: ["folder:/vault/old", "/vault/old/Note.md", "stable-id", "deleted"],
    })
    useViewStateStore
      .getState()
      .applyMutation(["deleted"], (path) =>
        remapPath(path, [{ oldPath: "/vault/old", newPath: "/vault/new" }]),
      )
    expect([...useViewStateStore.getState().closedTreeIds]).toEqual([
      "folder:/vault/new",
      "/vault/new/Note.md",
      "stable-id",
    ])
  })

  it("hydrates per-page widths and database title labels", () => {
    useViewStateStore.getState().hydrateFromSession({
      ...session,
      contentWidths: { note: "wide", invalid: "huge" },
      databaseTitleLabels: { "database:db-1": "Страницы" },
    })
    expect(useViewStateStore.getState().contentWidths).toEqual({ note: "wide" })
    expect(useViewStateStore.getState().databaseTitleLabels).toEqual({
      "database:db-1": "Страницы",
    })
  })
})

describe("layer view state helpers", () => {
  it("tracks view mode and lock independently per layer", async () => {
    const { getLayerViewMode, isLayerLocked } = await import("./use-view-state-store")
    const viewModes = {
      "note-1": "source" as const,
      "note-1:canvas": "live" as const,
      "note-1:sketch": "read" as const,
    }
    const lockedFileIds = new Set(["note-1:canvas"])

    expect(getLayerViewMode(viewModes, "note-1", "editor")).toBe("source")
    expect(getLayerViewMode(viewModes, "note-1", "canvas")).toBe("live")
    expect(getLayerViewMode(viewModes, "note-1", "sketch")).toBe("read")
    expect(getLayerViewMode(viewModes, "note-1", "database")).toBe("live")

    expect(isLayerLocked(lockedFileIds, viewModes, "note-1", "editor")).toBe(false)
    expect(isLayerLocked(lockedFileIds, viewModes, "note-1", "canvas")).toBe(true)
    expect(isLayerLocked(lockedFileIds, viewModes, "note-1", "sketch")).toBe(true) // because mode is read
    expect(isLayerLocked(lockedFileIds, viewModes, "note-1", "database")).toBe(false)
  })

  it("cleans up per-layer state when document is deleted", () => {
    const store = useViewStateStore.getState()
    store.setViewMode("note-1", "source")
    store.setViewMode("note-1:canvas", "read")
    store.toggleLock("note-1:canvas")
    store.toggleLock("note-2:sketch")

    expect(useViewStateStore.getState().lockedFileIds.has("note-1:canvas")).toBe(true)
    expect(useViewStateStore.getState().viewModes["note-1:canvas"]).toBe("read")

    store.applyMutation(["note-1"])

    expect(useViewStateStore.getState().lockedFileIds.has("note-1:canvas")).toBe(false)
    expect(useViewStateStore.getState().lockedFileIds.has("note-2:sketch")).toBe(true)
    expect(useViewStateStore.getState().viewModes["note-1"]).toBeUndefined()
    expect(useViewStateStore.getState().viewModes["note-1:canvas"]).toBeUndefined()
  })
})
