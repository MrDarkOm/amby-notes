// @vitest-environment happy-dom

import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { IconValue } from "./icon-value"

describe("IconValue", () => {
  it("does not render system icon marker superdatabase as text", () => {
    const { container } = render(
      <IconValue value="superdatabase" fallback={<span data-testid="fallback">fallback</span>} />,
    )
    expect(container.textContent).toBe("fallback")
  })

  it("does not render system icon marker database as text", () => {
    const { container } = render(
      <IconValue value="database" fallback={<span data-testid="fallback">fallback</span>} />,
    )
    expect(container.textContent).toBe("fallback")
  })

  it("does not render system icon marker file as text", () => {
    const { container } = render(
      <IconValue value="file" fallback={<span data-testid="fallback">fallback</span>} />,
    )
    expect(container.textContent).toBe("fallback")
  })

  it("renders emoji values directly", () => {
    const { container } = render(<IconValue value="🚀" />)
    expect(container.textContent).toBe("🚀")
  })

  it("renders emoji values inside a styled span with className applied", () => {
    const { container } = render(<IconValue value="🚀" className="size-3.5" />)
    const span = container.querySelector("span")
    expect(span).not.toBeNull()
    expect(span?.textContent).toBe("🚀")
    expect(span?.className).toContain("size-3.5")
    expect(span?.className).toContain("inline-flex")
  })

  it("renders rich icons via SVG", () => {
    const { container } = render(<IconValue value="amby-icon:database:%230ea5e9" />)
    expect(container.querySelector("svg")).not.toBeNull()
  })
})
