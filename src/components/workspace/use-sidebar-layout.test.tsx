// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useSidebarLayout } from "./use-sidebar-layout"

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
  window.dispatchEvent(new Event("resize"))
}

function renderLayout(options?: {
  activityButtons?: { defId: string; side: "left" | "right"; order: number }[]
  leftPinned?: boolean
  rightPinned?: boolean
}) {
  return renderHook(() =>
    useSidebarLayout({
      activityButtons: (options?.activityButtons ?? []) as never,
      setActivityButtons: vi.fn(),
      activeBySide: { left: "files", right: "links" },
      setActiveBySide: vi.fn(),
      actionContext: {} as never,
      dockPrefs: {
        leftPinned: options?.leftPinned ?? true,
        rightPinned: options?.rightPinned ?? true,
        rightEnabled: true,
      } as never,
      onDockPrefsChange: vi.fn(),
      windowPrefs: { leftPanelWidth: 280, rightPanelWidth: 280 } as never,
      onWindowPrefsChange: vi.fn(),
    }),
  )
}

describe("useSidebarLayout compact layout", () => {
  const initialWidth = window.innerWidth
  afterEach(() => setWindowWidth(initialWidth))

  it("closes both panels in a narrow window and restores them when it grows back", () => {
    setWindowWidth(1280)
    const { result } = renderLayout()
    act(() => result.current.setIsRightSidebarOpen(false))

    act(() => setWindowWidth(800))
    expect(result.current.isLeftSidebarOpen).toBe(false)
    expect(result.current.isRightSidebarOpen).toBe(false)

    act(() => setWindowWidth(1280))
    expect(result.current.isLeftSidebarOpen).toBe(true)
    expect(result.current.isRightSidebarOpen).toBe(false)
  })

  it("moves only the right panel aside between 960 and 1100 px and brings it back", () => {
    setWindowWidth(1280)
    const { result } = renderLayout()

    act(() => setWindowWidth(1024))
    expect(result.current.isLeftSidebarOpen).toBe(true)
    expect(result.current.isRightSidebarOpen).toBe(false)

    act(() => setWindowWidth(800))
    expect(result.current.isLeftSidebarOpen).toBe(false)

    act(() => setWindowWidth(1024))
    expect(result.current.isLeftSidebarOpen).toBe(true)
    expect(result.current.isRightSidebarOpen).toBe(false)

    act(() => setWindowWidth(1280))
    expect(result.current.isLeftSidebarOpen).toBe(true)
    expect(result.current.isRightSidebarOpen).toBe(true)
  })

  it("keeps a panel the person opened while the window stays narrow", () => {
    setWindowWidth(1024)
    const { result } = renderLayout()
    expect(result.current.isRightSidebarOpen).toBe(false)
    act(() => result.current.setIsRightSidebarOpen(true))
    act(() => setWindowWidth(1050))
    expect(result.current.isRightSidebarOpen).toBe(true)
  })

  it("replaces the open side panel when opening the opposite side in compact layout", () => {
    setWindowWidth(800)
    const { result } = renderLayout({
      activityButtons: [
        { defId: "files", side: "left", order: 0 },
        { defId: "links", side: "right", order: 0 },
      ],
    })
    expect(result.current.isCompactLayout).toBe(true)
    expect(result.current.isLeftSidebarOpen).toBe(false)
    expect(result.current.isRightSidebarOpen).toBe(false)

    act(() => result.current.toggleSidebar("left"))
    expect(result.current.isLeftSidebarOpen).toBe(true)
    expect(result.current.isRightSidebarOpen).toBe(false)

    act(() => result.current.toggleSidebar("right"))
    expect(result.current.isLeftSidebarOpen).toBe(false)
    expect(result.current.isRightSidebarOpen).toBe(true)

    act(() => result.current.handleActivate("files"))
    expect(result.current.isLeftSidebarOpen).toBe(true)
    expect(result.current.isRightSidebarOpen).toBe(false)

    act(() => result.current.activatePanelAnywhere("links"))
    expect(result.current.isLeftSidebarOpen).toBe(false)
    expect(result.current.isRightSidebarOpen).toBe(true)
  })

  it("allows both side panels to stay open together in wide layout", () => {
    setWindowWidth(1280)
    const { result } = renderLayout({
      activityButtons: [
        { defId: "files", side: "left", order: 0 },
        { defId: "links", side: "right", order: 0 },
      ],
    })
    expect(result.current.isCompactLayout).toBe(false)
    act(() => result.current.toggleSidebar("left"))
    act(() => result.current.toggleSidebar("right"))
    expect(result.current.isLeftSidebarOpen).toBe(false)
    expect(result.current.isRightSidebarOpen).toBe(false)

    act(() => result.current.toggleSidebar("left"))
    act(() => result.current.toggleSidebar("right"))
    expect(result.current.isLeftSidebarOpen).toBe(true)
    expect(result.current.isRightSidebarOpen).toBe(true)
  })

  it("waits one second before hiding an unpinned sidebar after pointer leave", () => {
    vi.useFakeTimers()
    try {
      setWindowWidth(1280)
      const { result } = renderLayout({ leftPinned: false })
      expect(result.current.isLeftSidebarVisible).toBe(false)

      act(() => result.current.setSidebarHover("left", true))
      expect(result.current.isLeftSidebarVisible).toBe(true)

      act(() => result.current.setSidebarHover("left", false))
      act(() => vi.advanceTimersByTime(999))
      expect(result.current.isLeftSidebarVisible).toBe(true)

      act(() => vi.advanceTimersByTime(1))
      expect(result.current.isLeftSidebarVisible).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps an unpinned sidebar open while a context menu is open and when the pointer stays over the sidebar", () => {
    vi.useFakeTimers()
    const overlay = document.createElement("div")
    overlay.className = "amby-sidebar-overlay--left"
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 44, right: 348, bottom: 800, width: 348, height: 756 }) as DOMRect
    document.body.appendChild(overlay)

    const menu = document.createElement("div")
    menu.setAttribute("data-slot", "context-menu-content")
    menu.setAttribute("data-state", "open")
    document.body.appendChild(menu)

    try {
      setWindowWidth(1280)
      const { result } = renderLayout({ leftPinned: false })

      act(() => result.current.setSidebarHover("left", true))
      expect(result.current.isLeftSidebarVisible).toBe(true)

      // Opening/hovering a portaled context menu triggers mouseleave on the sidebar.
      act(() => result.current.setSidebarHover("left", false))
      act(() => vi.advanceTimersByTime(2500))
      expect(result.current.isLeftSidebarVisible).toBe(true)

      // Move pointer back over the sidebar and close the menu: sidebar must remain open.
      act(() => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: 120, clientY: 200 }))
      })
      menu.remove()
      act(() => vi.advanceTimersByTime(2000))
      expect(result.current.isLeftSidebarVisible).toBe(true)

      // Moving pointer outside the sidebar and leaving hides it after 1 second.
      act(() => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: 600, clientY: 200 }))
        result.current.setSidebarHover("left", false)
      })
      act(() => vi.advanceTimersByTime(999))
      expect(result.current.isLeftSidebarVisible).toBe(true)
      act(() => vi.advanceTimersByTime(1))
      expect(result.current.isLeftSidebarVisible).toBe(false)
    } finally {
      menu.remove()
      overlay.remove()
      vi.useRealTimers()
    }
  })
})
