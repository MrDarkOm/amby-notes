import { describe, expect, it } from "vitest"
import { normalizeDatabaseIcon } from "./database-icon"

describe("normalizeDatabaseIcon", () => {
  it("uses the database fallback for internal tree icon markers", () => {
    expect(normalizeDatabaseIcon("file")).toBeUndefined()
    expect(normalizeDatabaseIcon("folder")).toBeUndefined()
    expect(normalizeDatabaseIcon("database")).toBeUndefined()
    expect(normalizeDatabaseIcon("superdatabase")).toBeUndefined()
    expect(normalizeDatabaseIcon(undefined)).toBeUndefined()
  })

  it("preserves icons selected by the user", () => {
    expect(normalizeDatabaseIcon("🗺️")).toBe("🗺️")
    expect(normalizeDatabaseIcon("amby-icon:database:%230ea5e9")).toBe(
      "amby-icon:database:%230ea5e9",
    )
  })
})
