import { describe, expect, it } from "vitest"
import { catalogDownloadUrl } from "./catalog"

describe("MOD-05: catalogDownloadUrl", () => {
  it("is the address the copies used to build by hand", () => {
    expect(catalogDownloadUrl("tags", "1.0.0")).toBe(
      "https://github.com/MrDarkOm/amby-notes/releases/download/v0.1.4/tags-1.0.0.amby-pkg",
    )
  })

  it("prefers the address the catalog entry names", () => {
    const entry = {
      versions: { "1.2.0": { downloadUrl: "https://example.test/tags.amby-pkg" } },
    } as unknown as Parameters<typeof catalogDownloadUrl>[2]
    expect(catalogDownloadUrl("tags", "1.2.0", entry)).toBe("https://example.test/tags.amby-pkg")
  })
})
