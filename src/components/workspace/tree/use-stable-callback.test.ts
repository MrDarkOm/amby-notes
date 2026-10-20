// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { useStableCallback } from "./use-stable-callback"

it("keeps one identity, calls the latest handler and stays absent when there is none", () => {
  const first = vi.fn()
  const second = vi.fn()
  const { result, rerender } = renderHook(
    ({ fn }: { fn: ((id: string) => void) | undefined }) => useStableCallback(fn),
    { initialProps: { fn: first as ((id: string) => void) | undefined } },
  )
  const stable = result.current
  rerender({ fn: second })
  expect(result.current).toBe(stable)
  result.current?.("a")
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledWith("a")
  rerender({ fn: undefined })
  expect(result.current).toBeUndefined()
})
