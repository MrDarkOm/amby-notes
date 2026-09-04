import { describe, expect, it } from "vitest"
import { resolveGalleryPreview } from "./gallery-preview"

describe("resolveGalleryPreview", () => {
  it("selects the first safe bundle-relative file", () => {
    expect(
      resolveGalleryPreview(
        JSON.stringify({ cover: { type: "files", items: [{ relativePath: "assets/cover.png" }] } }),
      ),
    ).toEqual({ kind: "asset", relativePath: "assets/cover.png" })
  })

  it("rejects external and traversal paths", () => {
    expect(
      resolveGalleryPreview(
        JSON.stringify({
          cover: { type: "files", items: [{ relativePath: "https://example.com/a.png" }] },
        }),
      ),
    ).toEqual({ kind: "placeholder", reason: "unsupported" })
    expect(
      resolveGalleryPreview(
        JSON.stringify({ cover: { type: "files", items: [{ relativePath: "../a.png" }] } }),
      ),
    ).toEqual({ kind: "placeholder", reason: "unsupported" })
  })

  it("returns an invalid placeholder for malformed row values", () => {
    expect(resolveGalleryPreview("not-json")).toEqual({ kind: "placeholder", reason: "invalid" })
  })
})
