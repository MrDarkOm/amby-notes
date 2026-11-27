// @vitest-environment happy-dom
import { renderHook, waitFor } from "@testing-library/react"
import { useMotionValue } from "motion/react"
import { describe, expect, it } from "vitest"
import {
  panelLength,
  useEdgeProgress,
  usePanelLength,
  usePanelPresence,
} from "./use-panel-presence"

const state = (presence: ReturnType<typeof usePanelPresence>) => ({
  mounted: presence.mounted,
  settled: presence.settled,
  progress: presence.progress.get(),
})

describe("usePanelPresence", () => {
  it("starts where the panel is, without moving", () => {
    expect(state(renderHook(() => usePanelPresence(true)).result.current)).toEqual({
      mounted: true,
      settled: true,
      progress: 1,
    })
    expect(state(renderHook(() => usePanelPresence(false)).result.current)).toEqual({
      mounted: false,
      settled: false,
      progress: 0,
    })
  })

  it("mounts a panel, moves it in with Motion and gives it its width only at the end", async () => {
    const { result, rerender } = renderHook(({ open }) => usePanelPresence(open), {
      initialProps: { open: false },
    })
    rerender({ open: true })
    expect(result.current.mounted).toBe(true)
    expect(result.current.settled).toBe(false)
    await waitFor(() =>
      expect(state(result.current)).toEqual({ mounted: true, settled: true, progress: 1 }),
    )
  })

  it("gives the width back at once, moves the panel out and unmounts it at the end", async () => {
    const { result, rerender } = renderHook(({ open }) => usePanelPresence(open), {
      initialProps: { open: true },
    })
    rerender({ open: false })
    expect(result.current.mounted).toBe(true)
    expect(result.current.settled).toBe(false)
    await waitFor(() =>
      expect(state(result.current)).toEqual({ mounted: false, settled: false, progress: 0 }),
    )
  })

  it("keeps a panel reopened while it was closing", async () => {
    const { result, rerender } = renderHook(({ open }) => usePanelPresence(open), {
      initialProps: { open: true },
    })
    rerender({ open: false })
    rerender({ open: true })
    await waitFor(() =>
      expect(state(result.current)).toMatchObject({ mounted: true, settled: true }),
    )
  })

  it("does not settle a panel closed again while it was opening", async () => {
    const { result, rerender } = renderHook(({ open }) => usePanelPresence(open), {
      initialProps: { open: false },
    })
    rerender({ open: true })
    rerender({ open: false })
    await waitFor(() =>
      expect(state(result.current)).toMatchObject({ mounted: false, settled: false }),
    )
  })
})

describe("panel lengths", () => {
  it("are calc() of the progress, with no CSS transition", () => {
    expect(panelLength(0.5, "0px", "300px")).toBe("calc(0px + 0.5 * (300px - 0px))")
  })

  it("follow new ends after a resize without waiting for the progress to move", () => {
    const { result, rerender } = renderHook(
      ({ open }) => {
        const progress = useMotionValue(1)
        return usePanelLength(progress, "0px", open)
      },
      { initialProps: { open: "300px" } },
    )
    expect(result.current.get()).toBe("calc(0px + 1 * (300px - 0px))")
    rerender({ open: "420px" })
    expect(result.current.get()).toBe("calc(0px + 1 * (420px - 0px))")
  })

  it("jump with the open flag when the layout gives no progress", () => {
    const { result, rerender } = renderHook(({ open }) => useEdgeProgress(undefined, open), {
      initialProps: { open: false },
    })
    expect(result.current.get()).toBe(0)
    rerender({ open: true })
    expect(result.current.get()).toBe(1)
  })
})
