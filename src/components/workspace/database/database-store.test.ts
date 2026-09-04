import { beforeEach, describe, expect, it } from "vitest"
import { databaseHostKey, emptyDatabaseHost, useDatabaseStore } from "./database-store"

describe("database store lifecycle", () => {
  beforeEach(() => useDatabaseStore.getState().reset(null))

  it("clears catalog and host sessions when the vault generation changes", () => {
    const host = emptyDatabaseHost("tab", "db-1")
    useDatabaseStore
      .getState()
      .setCatalog([{ databaseId: "db-1", title: "Notes", views: [], diagnostics: [] }])
    useDatabaseStore.getState().setHost({ ...host, status: "ready" })
    useDatabaseStore.getState().reset(12)

    const state = useDatabaseStore.getState()
    expect(state.vaultGeneration).toBe(12)
    expect(state.databases).toEqual([])
    expect(state.hosts).toEqual({})
    expect(state.runtime).toBeNull()
  })

  it("keeps host sessions isolated by kind and view", () => {
    const tab = emptyDatabaseHost("tab", "db-1")
    const view = emptyDatabaseHost("tab", "db-1", "view-1")
    useDatabaseStore.getState().setHost({ ...tab, status: "ready" })
    useDatabaseStore.getState().setHost({ ...view, status: "loading" })

    const state = useDatabaseStore.getState()
    expect(state.hosts[databaseHostKey("tab", "db-1")]?.status).toBe("ready")
    expect(state.hosts[databaseHostKey("tab", "db-1", "view-1")]?.status).toBe("loading")
  })
})
