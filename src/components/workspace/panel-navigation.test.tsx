// @vitest-environment happy-dom
// A part of the interface that has no access to the layout opens a dock panel with an event; the
// workspace listens (docs/notices.md: the card that says a version went to the history offers it).
import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import {
  OPEN_PANEL_REQUEST_EVENT,
  requestOpenPanel,
  useOpenPanelRequests,
} from "./panel-navigation"

describe("a request to open a panel", () => {
  it("reaches the workspace with the id of the panel", () => {
    const activate = vi.fn()
    renderHook(() => useOpenPanelRequests(activate))
    requestOpenPanel("history")
    expect(activate).toHaveBeenCalledWith("history")
  })

  it("is the event the cards send", () => {
    const seen = vi.fn()
    window.addEventListener(OPEN_PANEL_REQUEST_EVENT, seen)
    requestOpenPanel("history")
    window.removeEventListener(OPEN_PANEL_REQUEST_EVENT, seen)
    expect((seen.mock.calls[0]![0] as CustomEvent).detail).toEqual({ panelId: "history" })
  })

  it("is not listened to after the workspace is gone", () => {
    const activate = vi.fn()
    const { unmount } = renderHook(() => useOpenPanelRequests(activate))
    unmount()
    requestOpenPanel("history")
    expect(activate).not.toHaveBeenCalled()
  })
})
