import { describe, expect, it, vi } from "vitest"
import { scrollEditorToAnchor } from "./anchor-navigation"

describe("scrollEditorToAnchor", () => {
  it("dispatches source-editor navigation after render", () => {
    vi.useFakeTimers()
    const dispatchEvent = vi.fn()
    vi.stubGlobal("document", { querySelector: vi.fn(() => ({ dispatchEvent })) })

    scrollEditorToAnchor("#Heading")
    vi.runAllTimers()

    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "amby:navigate-markdown-anchor", detail: "#Heading" }),
    )
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})
