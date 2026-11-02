// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { logger } from "@/lib/logger"
import { SurfaceErrorBoundary } from "./surface-error-boundary"

let shouldThrow = true
function Bomb() {
  if (shouldThrow) throw new Error("secret note text")
  return <p>recovered</p>
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  shouldThrow = true
})

describe("SurfaceErrorBoundary", () => {
  it("keeps a sibling panel alive when one panel throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const log = vi.spyOn(logger, "error").mockImplementation(() => null)
    render(
      <div>
        <SurfaceErrorBoundary scope="panel">
          <Bomb />
        </SurfaceErrorBoundary>
        <SurfaceErrorBoundary scope="panel">
          <p>neighbour</p>
        </SurfaceErrorBoundary>
      </div>,
    )
    expect(screen.getByText("neighbour")).toBeTruthy()
    expect(screen.getByRole("alert")).toBeTruthy()
    expect(log).toHaveBeenCalledWith(
      "surface_render_error",
      expect.objectContaining({ scope: "panel", errorType: expect.any(String) }),
    )
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret note text")
  })

  it("remounts the children when the user retries", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(logger, "error").mockImplementation(() => null)
    render(
      <SurfaceErrorBoundary scope="document">
        <Bomb />
      </SurfaceErrorBoundary>,
    )
    shouldThrow = false
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("recovered")).toBeTruthy()
  })

  it("clears the fallback when the reset key changes", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(logger, "error").mockImplementation(() => null)
    const { rerender } = render(
      <SurfaceErrorBoundary scope="document" resetKey="a">
        <Bomb />
      </SurfaceErrorBoundary>,
    )
    expect(screen.getByRole("alert")).toBeTruthy()
    shouldThrow = false
    rerender(
      <SurfaceErrorBoundary scope="document" resetKey="b">
        <Bomb />
      </SurfaceErrorBoundary>,
    )
    expect(screen.getByText("recovered")).toBeTruthy()
  })
})
