// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { useViewStateStore } from "@/components/workspace/use-view-state-store"
import { PageIcon } from "./page-icon"

describe("PageIcon", () => {
  afterEach(() => {
    cleanup()
    useViewStateStore.setState({ iconOverrides: {} })
  })

  it("shows the default page icon when the page has none", () => {
    const { container } = render(<PageIcon noteId="n1" />)
    expect(container.querySelector("svg")).toBeTruthy()
  })

  it("shows the page's own icon", () => {
    useViewStateStore.setState({ iconOverrides: { n1: "🚀" } })
    const { container } = render(<PageIcon noteId="n1" />)
    expect(container.textContent).toBe("🚀")
    expect(container.querySelector("svg")).toBeNull()
  })

  it("does not show another page's icon", () => {
    useViewStateStore.setState({ iconOverrides: { other: "🚀" } })
    const { container } = render(<PageIcon noteId="n1" />)
    expect(container.textContent).toBe("")
  })
})
