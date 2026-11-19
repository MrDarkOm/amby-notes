// @vitest-environment happy-dom

import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { IconValue } from "./icon-value"

describe("IconValue", () => {
  it.each(["superdatabase", "database", "file"])(
    "does not render system icon marker %s as text",
    (marker) => {
      const { container } = render(
        <IconValue value={marker} fallback={<span data-testid="fallback">fallback</span>} />,
      )
      expect(container.textContent).toBe("fallback")
    },
  )

  it("renders emoji values with local Noto artwork", () => {
    const { container } = render(<IconValue value="🚀" />)
    expect(container.querySelector("img")?.getAttribute("src")).toContain("emoji_u1f680.svg")
  })

  it("renders emoji values inside a styled span with className applied", () => {
    const { container } = render(<IconValue value="🚀" className="size-3.5" />)
    const span = container.querySelector("span")
    expect(span).not.toBeNull()
    expect(span?.querySelector("img")).not.toBeNull()
    expect(span?.className).toContain("size-3.5")
  })

  it("renders rich icons via SVG", () => {
    const { container } = render(<IconValue value="amby-icon:database:%230ea5e9" />)
    expect(container.querySelector("svg")).not.toBeNull()
  })
})
