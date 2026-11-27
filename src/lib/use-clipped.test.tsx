// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { useClipped } from "./use-clipped"

function Probe({ text, scroll, client }: { text: string; scroll: number; client: number }) {
  const [ref, clipped] = useClipped<HTMLSpanElement>(text)
  return (
    <span
      ref={(node) => {
        if (node) {
          Object.defineProperty(node, "scrollWidth", { configurable: true, value: scroll })
          Object.defineProperty(node, "clientWidth", { configurable: true, value: client })
        }
        ref.current = node
      }}
      title={clipped ? text : undefined}
    >
      {text}
    </span>
  )
}

afterEach(cleanup)

describe("useClipped", () => {
  it("gives the tooltip only when the text does not fit", () => {
    const { rerender } = render(<Probe text="Длинное название беседы" scroll={300} client={120} />)
    expect(screen.getByText("Длинное название беседы").getAttribute("title")).toBe(
      "Длинное название беседы",
    )
    rerender(<Probe text="Короткое" scroll={60} client={120} />)
    expect(screen.getByText("Короткое").getAttribute("title")).toBeNull()
  })
})
