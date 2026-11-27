// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { helpConnector, helpOverlayLayout, visibleHelpRect } from "./help-overlay-layout"

describe("help overlay geometry", () => {
  it("routes leaders through the gap between a card and its target", () => {
    const card = { left: 300, top: 200, width: 240, height: 160 }
    expect(helpConnector(card, { left: 20, top: 220, width: 32, height: 32 })).toMatch(/^M 295 /)
    expect(helpConnector(card, { left: 600, top: 220, width: 32, height: 32 })).toMatch(/^M 545 /)
    expect(helpConnector(card, { left: 350, top: 20, width: 160, height: 32 })).toMatch(
      /^M 430 195 /,
    )
    expect(helpConnector(card, { left: 350, top: 500, width: 160, height: 32 })).toMatch(
      /^M 430 365 /,
    )
    expect(helpConnector(card, { left: 350, top: 220, width: 32, height: 32 })).toBeNull()
  })

  it("consolidates the help surface on narrow or short windows", () => {
    expect(helpOverlayLayout(1440, 900)).toBe("spacious")
    expect(helpOverlayLayout(1100, 900)).toBe("compact")
    expect(helpOverlayLayout(1440, 600)).toBe("compact")
  })

  it("ignores offscreen, cached and clipped-out controls, including auto-hidden docks", () => {
    const parent = document.createElement("div")
    const target = document.createElement("button")
    document.body.append(parent)
    parent.append(target)
    parent.style.cssText = "overflow: hidden; opacity: 1"
    target.style.opacity = "1"
    parent.getBoundingClientRect = () => new DOMRect(0, 0, 4, 600)
    target.getBoundingClientRect = () => new DOMRect(0, 0, 48, 600)
    expect(visibleHelpRect(target, 1440, 900)).toBeNull()
    parent.style.overflow = "visible"
    target.style.visibility = "hidden"
    expect(visibleHelpRect(target, 1440, 900)).toBeNull()
    target.style.visibility = "visible"
    target.getBoundingClientRect = () => new DOMRect(-48, 0, 48, 600)
    expect(visibleHelpRect(target, 1440, 900)).toBeNull()
    parent.remove()
  })
})
