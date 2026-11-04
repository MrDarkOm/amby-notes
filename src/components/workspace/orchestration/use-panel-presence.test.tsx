// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { panelTransition, usePanelPresence } from "./use-panel-presence"

const CLOSED = { mounted: false, expanded: false, settled: false }
const OPEN = { mounted: true, expanded: true, settled: true }

describe("usePanelPresence", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("mounts a panel off-screen, slides it in and gives it its width only at the end", () => {
    const { result, rerender } = renderHook(({ open }) => usePanelPresence(open), {
      initialProps: { open: false },
    })
    expect(result.current).toEqual(CLOSED)

    rerender({ open: true })
    expect(result.current).toEqual({ mounted: true, expanded: false, settled: false })

    act(() => vi.advanceTimersByTime(40))
    expect(result.current).toEqual({ mounted: true, expanded: true, settled: false })

    act(() => vi.advanceTimersByTime(220))
    expect(result.current).toEqual(OPEN)
  })

  it("gives the width back at once, slides the panel out and unmounts it after the transition", () => {
    const { result, rerender } = renderHook(({ open }) => usePanelPresence(open), {
      initialProps: { open: true },
    })
    expect(result.current).toEqual(OPEN)

    rerender({ open: false })
    expect(result.current).toEqual({ mounted: true, expanded: false, settled: false })

    act(() => vi.advanceTimersByTime(219))
    expect(result.current.mounted).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toEqual(CLOSED)
  })

  it("keeps a panel reopened during its close transition", () => {
    const { result, rerender } = renderHook(({ open }) => usePanelPresence(open), {
      initialProps: { open: true },
    })
    rerender({ open: false })
    act(() => vi.advanceTimersByTime(100))
    rerender({ open: true })
    act(() => vi.advanceTimersByTime(400))
    expect(result.current).toEqual(OPEN)
  })

  it("does not settle a panel closed again while it slides in", () => {
    const { result, rerender } = renderHook(({ open }) => usePanelPresence(open), {
      initialProps: { open: false },
    })
    rerender({ open: true })
    act(() => vi.advanceTimersByTime(100))
    rerender({ open: false })
    act(() => vi.advanceTimersByTime(400))
    expect(result.current).toEqual(CLOSED)
  })

  it("writes the shared panel timing as a CSS transition", () => {
    expect(panelTransition("transform")).toBe("transform 220ms cubic-bezier(0.32, 0.72, 0, 1)")
  })
})
