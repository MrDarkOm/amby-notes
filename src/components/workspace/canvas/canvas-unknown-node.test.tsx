// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { ReactFlowProvider } from "@xyflow/react"
import { afterEach, describe, expect, it } from "vitest"
import { UnknownNode } from "./canvas-nodes"

afterEach(cleanup)

describe("UnknownNode (CRE-02)", () => {
  it("shows a read-only placeholder with no text field", () => {
    const props = {
      id: "u1",
      data: { originalType: "whiteboard" },
      selected: false,
    } as unknown as React.ComponentProps<typeof UnknownNode>
    const { container } = render(
      <ReactFlowProvider>
        <UnknownNode {...props} />
      </ReactFlowProvider>,
    )
    expect(screen.getByTestId("canvas-unknown-node")).toBeTruthy()
    expect(container.querySelector("textarea, input")).toBeNull()
  })
})
