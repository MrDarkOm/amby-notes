// @vitest-environment happy-dom
import * as React from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabasePropertySummary } from "@/lib/storage"
import { TableView } from "./table-view"

const properties: DatabasePropertySummary[] = [
  { propertyId: "a", name: "Alpha", propertyType: "text", configJson: "{}", options: [] },
  { propertyId: "b", name: "Beta", propertyType: "text", configJson: "{}", options: [] },
]

function Host() {
  // Like the workspace: the parent stores the list and passes a fresh callback every render.
  const [hidden, setHidden] = React.useState(new Set<string>(["b"]))
  return (
    <TableView
      databaseId="db"
      rows={[]}
      loading={false}
      error={null}
      hasNextPage={false}
      onLoadNextPage={() => {}}
      onRetry={() => {}}
      properties={properties}
      hiddenPropertyIds={hidden}
      onHiddenPropertyIdsChange={(next) => setHidden(new Set(next))}
    />
  )
}

describe("TableView", () => {
  afterEach(cleanup)

  it("does not loop when the parent keeps the hidden list and rebuilds its callback every render", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    render(<Host />)
    expect(screen.getByText("Alpha")).toBeTruthy()
    expect(screen.queryByText("Beta")).toBeNull()
    expect(errors.mock.calls.some((call) => String(call[0]).includes("Maximum update depth"))).toBe(
      false,
    )
    errors.mockRestore()
  })
})
