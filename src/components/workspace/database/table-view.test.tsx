// @vitest-environment happy-dom
import * as React from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
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

  it("parses each row's JSON once, not on every render or scroll step", () => {
    const manyProps: DatabasePropertySummary[] = ["a", "b", "c", "d", "e"].map((id) => ({
      propertyId: id,
      name: id,
      propertyType: "text",
      configJson: "{}",
      options: [],
    }))
    const rows = Array.from({ length: 200 }, (_, index) => ({
      noteId: `n${index}`,
      title: `Row ${index}`,
      valuesJson: JSON.stringify(
        Object.fromEntries(
          manyProps.map((p) => [p.propertyId, { type: "text", value: `value ${index}` }]),
        ),
      ),
    })) as unknown as DatabaseRow[]
    const tree = (loading: boolean) => (
      <TableView
        databaseId="db"
        rows={rows}
        loading={loading}
        error={null}
        hasNextPage={false}
        onLoadNextPage={() => {}}
        onRetry={() => {}}
        properties={manyProps}
      />
    )
    const parse = vi.spyOn(JSON, "parse")
    const { container, rerender } = render(tree(false))
    const initial = parse.mock.calls.length
    // One parse per row for the widths, plus the visible cells (about 4300 before the fix).
    expect(initial).toBeLessThanOrEqual(rows.length * 3)
    parse.mockClear()
    rerender(tree(true))
    rerender(tree(false))
    const scroller = container.querySelector("[class*='overflow']") ?? container
    for (let step = 1; step <= 5; step += 1)
      fireEvent.scroll(scroller, { target: { scrollTop: step * 40 } })
    // Only the visible window's cells may parse; the width pass must not run again.
    expect(parse.mock.calls.length).toBeLessThan(rows.length)
    parse.mockRestore()
  })
})
