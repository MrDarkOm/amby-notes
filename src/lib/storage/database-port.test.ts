import { describe, expect, it } from "vitest"

import {
  getDatabaseModuleState,
  listDatabases,
  setDatabaseModuleEnabled,
  setStorageAdapter,
} from "./index"
import type { ProjectionVersion } from "./database-types"
import { WebAdapter } from "./web-adapter"

describe("database port skeleton", () => {
  it("has identical disabled and empty-list semantics in the web adapter", async () => {
    const adapter = new WebAdapter()
    setStorageAdapter(adapter)

    try {
      await expect(listDatabases()).rejects.toMatchObject({ kind: "moduleDisabled" })
      await expect(setDatabaseModuleEnabled(true, 0)).resolves.toMatchObject({
        enabled: true,
        vaultGeneration: 0,
      })
      await expect(listDatabases()).resolves.toEqual([])
      const projection: ProjectionVersion | null = (await getDatabaseModuleState()).projection
      expect(projection).toBeNull()
    } finally {
      setStorageAdapter(null)
    }
  })
})
