// @vitest-environment happy-dom
// A canvas or sketch whose draft question was closed without an answer is "held": it is read only, so nothing
// can write over the draft, and the question comes again when the layer is shown again. The hook is what the
// body of the document wears.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { useHeldDraftGate, useHeldDraftsStore } from "./held-drafts-store"

const PATH = "/vault/План.canvas"

beforeEach(() => useHeldDraftsStore.setState(useHeldDraftsStore.getInitialState()))
afterEach(cleanup)

describe("the store", () => {
  it("holds a path with a way to ask again, and lets it go", () => {
    const resolve = vi.fn(async () => {})
    useHeldDraftsStore.getState().hold(PATH, resolve)
    expect(useHeldDraftsStore.getState().held[PATH]).toMatchObject({ fresh: true })
    useHeldDraftsStore.getState().release(PATH)
    expect(useHeldDraftsStore.getState().held[PATH]).toBeUndefined()
  })

  it("holding again keeps one entry and is fresh again", () => {
    useHeldDraftsStore.getState().hold(PATH, async () => {})
    useHeldDraftsStore.getState().acknowledge(PATH)
    useHeldDraftsStore.getState().hold(PATH, async () => {})
    expect(Object.keys(useHeldDraftsStore.getState().held)).toEqual([PATH])
    expect(useHeldDraftsStore.getState().held[PATH].fresh).toBe(true)
  })
})

describe("the gate of a document body", () => {
  it("is open (not locked) while nothing is held", () => {
    const { result } = renderHook(() => useHeldDraftGate(PATH, true))
    expect(result.current).toBe(false)
  })

  it("locks a held layer and does not ask at once: the question was just closed", () => {
    const resolve = vi.fn(async () => {})
    useHeldDraftsStore.getState().hold(PATH, resolve)
    const { result } = renderHook(() => useHeldDraftGate(PATH, true))
    expect(result.current).toBe(true)
    expect(resolve).not.toHaveBeenCalled()
    expect(useHeldDraftsStore.getState().held[PATH].fresh).toBe(false)
  })

  it("asks again when the layer is shown again", () => {
    const resolve = vi.fn(async () => {})
    useHeldDraftsStore.getState().hold(PATH, resolve)
    const { rerender } = renderHook(({ active }) => useHeldDraftGate(PATH, active), {
      initialProps: { active: true },
    })
    rerender({ active: false })
    expect(resolve).not.toHaveBeenCalled()
    rerender({ active: true })
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it("asks when the document is opened again (a new body)", () => {
    const resolve = vi.fn(async () => {})
    useHeldDraftsStore.getState().hold(PATH, resolve)
    renderHook(() => useHeldDraftGate(PATH, true)).unmount()
    renderHook(() => useHeldDraftGate(PATH, true))
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it("does not ask for a layer that is not shown", () => {
    const resolve = vi.fn(async () => {})
    useHeldDraftsStore.getState().hold(PATH, resolve)
    useHeldDraftsStore.getState().acknowledge(PATH)
    renderHook(() => useHeldDraftGate(PATH, false))
    expect(resolve).not.toHaveBeenCalled()
  })

  it("unlocks when the question is answered", () => {
    useHeldDraftsStore.getState().hold(PATH, async () => {})
    const { result } = renderHook(() => useHeldDraftGate(PATH, true))
    act(() => useHeldDraftsStore.getState().release(PATH))
    expect(result.current).toBe(false)
  })
})
