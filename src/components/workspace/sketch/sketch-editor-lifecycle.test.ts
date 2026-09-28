// @vitest-environment happy-dom

import * as React from "react"
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as sketchFormat from "@/lib/sketch-format"
import { SketchEditor } from "./sketch-editor"

const api = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateScene: vi.fn(),
  getSceneElements: () => [],
  getAppState: () => ({}),
  getFiles: () => ({}),
}))

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: function MockExcalidraw(props: { excalidrawAPI: (api: unknown) => void }) {
    const { excalidrawAPI } = props
    React.useEffect(() => excalidrawAPI(api), [excalidrawAPI])
    return React.createElement("div")
  },
  MainMenu: Object.assign(() => null, {
    Item: () => null,
    Group: () => null,
    Separator: () => null,
    DefaultItems: {
      SaveAsImage: () => null,
      Export: () => null,
      Help: () => null,
      ClearCanvas: () => null,
    },
  }),
  convertToExcalidrawElements: vi.fn(),
  restoreElements: vi.fn(),
  viewportCoordsToSceneCoords: vi.fn(),
}))

describe("sketch editor layout lifecycle", () => {
  let notifyResize: (entries: ResizeObserverEntry[]) => void
  let disconnect: ReturnType<typeof vi.fn>
  let frames: Map<number, FrameRequestCallback>
  let nextFrame: number

  beforeEach(() => {
    frames = new Map()
    nextFrame = 0
    disconnect = vi.fn()
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: (entries: ResizeObserverEntry[]) => void) {
          notifyResize = callback
        }
        observe() {}
        disconnect = disconnect
      },
    )
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    })
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame))
    api.refresh.mockClear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function runFrames() {
    act(() => {
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach((callback) => callback(0))
    })
  }

  function resize(width: number, height: number) {
    act(() => {
      notifyResize([{ contentRect: { width, height } } as ResizeObserverEntry])
    })
  }

  it("refreshes only the sketch when shown again and coalesces size changes", () => {
    const onChange = vi.fn()
    const windowResize = vi.fn()
    window.addEventListener("resize", windowResize)
    try {
      render(
        React.createElement(SketchEditor, { value: sketchFormat.defaultSketchJson(), onChange }),
      )
      runFrames()
      api.refresh.mockClear()

      resize(900, 600)
      resize(920, 600)
      runFrames()
      expect(api.refresh).toHaveBeenCalledTimes(1)
      resize(920, 600)
      runFrames()
      expect(api.refresh).toHaveBeenCalledTimes(1)

      resize(0, 0)
      runFrames()
      expect(api.refresh).toHaveBeenCalledTimes(1)
      resize(920, 600)
      runFrames()
      expect(api.refresh).toHaveBeenCalledTimes(2)
      expect(windowResize).not.toHaveBeenCalled()
      expect(onChange).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener("resize", windowResize)
    }
  })

  it("does not parse the sketch again on parent renders and cancels pending resize work", () => {
    const parse = vi.spyOn(sketchFormat, "parseSketch")
    const props = { value: sketchFormat.defaultSketchJson(), onChange: vi.fn() }
    const { rerender, unmount } = render(React.createElement(SketchEditor, props))
    runFrames()
    const parseCount = parse.mock.calls.length
    rerender(React.createElement(SketchEditor, { ...props, isLocked: true }))
    rerender(React.createElement(SketchEditor, props))
    expect(parse).toHaveBeenCalledTimes(parseCount)

    resize(900, 600)
    api.refresh.mockClear()
    unmount()
    runFrames()
    expect(api.refresh).not.toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalled()
  })
})
