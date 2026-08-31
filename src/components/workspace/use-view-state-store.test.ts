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
})
