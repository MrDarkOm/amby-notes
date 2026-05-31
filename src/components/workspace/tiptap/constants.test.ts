import { describe, it, expect } from "vitest"
import { getWikiLinkParts } from "./constants"

describe("getWikiLinkParts", () => {
  it("plain note — no anchor, no alias", () => {
    const r = getWikiLinkParts("Note")
    expect(r.target).toBe("Note")
    expect(r.anchor).toBeNull()
    expect(r.label).toBe("Note")
  })

  it("heading anchor #", () => {
    const r = getWikiLinkParts("Note#My Heading")
    expect(r.target).toBe("Note")
    expect(r.anchor).toBe("#My Heading")
    expect(r.label).toBe("Note#My Heading")
  })

  it("block anchor ^", () => {
    const r = getWikiLinkParts("Note^block-id")
    expect(r.target).toBe("Note")
    expect(r.anchor).toBe("^block-id")
  })

  it("alias overrides label", () => {
    const r = getWikiLinkParts("Note#Heading|See this")
    expect(r.target).toBe("Note")
    expect(r.anchor).toBe("#Heading")
    expect(r.label).toBe("See this")
  })

  it("alias without anchor", () => {
    const r = getWikiLinkParts("Note|Alias")
    expect(r.target).toBe("Note")
    expect(r.anchor).toBeNull()
    expect(r.label).toBe("Alias")
  })

  it("# wins when both # and ^ present", () => {
    // # comes before ^ → anchorStart at #
    const r = getWikiLinkParts("Note#Head^block")
    expect(r.anchor).toBe("#Head^block")
    expect(r.target).toBe("Note")
  })

  it("^ wins when only ^ present", () => {
    const r = getWikiLinkParts("Note^block")
    expect(r.anchor).toBe("^block")
  })
})
