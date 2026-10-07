// @vitest-environment happy-dom
import * as React from "react"
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useScrollbarCompensation } from "./use-scrollbar-compensation"

let notify: () => void = () => {}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback
      }
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Scroller() {
  const ref = React.useRef<HTMLDivElement>(null)
  useScrollbarCompensation(ref)
  return (
    <div ref={ref} data-testid="scroller">
      <div />
    </div>
  )
}

function size(element: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight })
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight })
}

it("tells the stylesheet whether the note has a scrollbar as its content changes", () => {
  const { getByTestId } = render(<Scroller />)
  const scroller = getByTestId("scroller")
  size(scroller, 300, 600)
  act(() => notify())
  expect(scroller.dataset.scrollbar).toBe("off")
  size(scroller, 900, 600)
  act(() => notify())
  expect(scroller.dataset.scrollbar).toBe("on")
  // A hidden layer reports no size: the last answer stands.
  size(scroller, 0, 0)
  act(() => notify())
  expect(scroller.dataset.scrollbar).toBe("on")
})
