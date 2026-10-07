// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useOperationId } from "./use-operation-id"

describe("useOperationId", () => {
  it("keeps one ID for the same request and renews it when the request changes", () => {
    const { result, rerender } = renderHook(({ payload }) => useOperationId("op", payload), {
      initialProps: { payload: { name: "A" } },
    })
    const first = result.current()
    expect(first).toMatch(/^op-/u)
    expect(result.current()).toBe(first)
    rerender({ payload: { name: "A" } })
    expect(result.current()).toBe(first)
    rerender({ payload: { name: "B" } })
    const second = result.current()
    expect(second).not.toBe(first)
    rerender({ payload: { name: "A" } })
    expect(result.current()).not.toBe(second)
  })
})
