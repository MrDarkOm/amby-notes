// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { DOCK_GAP, useBellAnchor } from "./use-bell-anchor"

const box = (left: number, width: number, top: number, bottom: number) =>
  ({
    left,
    right: left + width,
    top,
    bottom,
    width,
    height: bottom - top,
    x: left,
    y: top,
  }) as DOMRect

function mountDock() {
  const dock = document.createElement("div")
  dock.setAttribute("data-activity-bar", "left")
  dock.getBoundingClientRect = () => box(0, 48, 0, 768)
  const bell = document.createElement("button")
  bell.setAttribute("data-activity-button", "notices")
  // The bell sits at the foot of the dock, beside the workspace switcher of the sidebar.
  bell.getBoundingClientRect = () => box(4, 36, 700, 740)
  dock.append(bell)
  document.body.append(dock)
}

function mountSwitcher(rect: DOMRect) {
  const switcher = document.createElement("div")
  switcher.setAttribute("data-workspace-switcher", "")
  switcher.getBoundingClientRect = () => rect
  document.body.append(switcher)
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("useBellAnchor and the workspace switcher", () => {
  it("keeps the gap from the dock and the foot of the bell when nothing is in the way", () => {
    mountDock()
    const { result } = renderHook(() => useBellAnchor(true))
    expect(result.current.left).toBe(48 + DOCK_GAP)
    expect(result.current.bottom).toBe(window.innerHeight - 740)
  })

  it("stands above the workspace switcher instead of covering it", () => {
    mountDock()
    mountSwitcher(box(48, 260, 690, 750))
    const { result } = renderHook(() => useBellAnchor(true))
    expect(result.current.left).toBe(48 + DOCK_GAP)
    expect(result.current.bottom as number).toBeGreaterThanOrEqual(window.innerHeight - 690 + 8)
  })

  it("is not lifted by a switcher that is not beside it", () => {
    mountDock()
    mountSwitcher(box(900, 200, 690, 750))
    const { result } = renderHook(() => useBellAnchor(true))
    expect(result.current.bottom).toBe(window.innerHeight - 740)
  })
})
