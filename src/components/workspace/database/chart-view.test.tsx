// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import * as storage from "@/lib/storage"
import type { DatabaseFilterNode } from "@/lib/storage"
import { useDatabaseStore } from "./database-store"
import { ChartView } from "./chart-view"

const result = (label: string, count: number) => ({
  databaseId: "db",
  groups: [{ key: label, label, count, value: null }],
  totalCount: count,
  warnings: [],
})
const category = { kind: "property" as const, propertyId: "s" }
const filterFor = (value: string): DatabaseFilterNode => ({
  kind: "condition",
  field: { kind: "property", propertyId: "n" },
  operator: "equals",
  value: JSON.stringify(value),
})

describe("ChartView", () => {
  beforeEach(() => useDatabaseStore.getState().reset(1))
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useDatabaseStore.getState().reset(null)
  })

  it("counts what the view shows: its filter and the search go into the aggregate", async () => {
    const aggregate = vi.spyOn(storage, "aggregateDatabase").mockResolvedValue(result("Done", 2))
    render(
      <ChartView
        databaseId="db"
        expectedGeneration={1}
        enabled
        category={category}
        filter={filterFor("a")}
        search=" acme "
      />,
    )
    await screen.findByText("Done")
    expect(aggregate.mock.calls[0][0]).toMatchObject({
      source: { kind: "inline", spec: { filter: filterFor("a"), sorts: [] } },
      search: "acme",
      category,
    })
  })

  it("recounts when the filter changes and ignores a slower older answer", async () => {
    let releaseOld: (value: ReturnType<typeof result>) => void = () => {}
    const aggregate = vi
      .spyOn(storage, "aggregateDatabase")
      .mockImplementationOnce(() => new Promise((resolve) => (releaseOld = resolve)))
      .mockResolvedValue(result("New", 1))
    const { rerender } = render(
      <ChartView
        databaseId="db"
        expectedGeneration={1}
        enabled
        category={category}
        filter={filterFor("a")}
      />,
    )
    rerender(
      <ChartView
        databaseId="db"
        expectedGeneration={1}
        enabled
        category={category}
        filter={filterFor("b")}
      />,
    )
    await screen.findByText("New")
    await act(async () => releaseOld(result("Old", 9)))
    expect(screen.queryByText("Old")).toBeNull()
    expect(aggregate).toHaveBeenCalledTimes(2)
  })

  it("recounts after the projection changed, without reopening the chart", async () => {
    const aggregate = vi
      .spyOn(storage, "aggregateDatabase")
      .mockResolvedValueOnce(result("Before", 1))
      .mockResolvedValueOnce(result("After", 2))
    render(<ChartView databaseId="db" expectedGeneration={1} enabled category={category} />)
    await screen.findByText("Before")
    act(() => useDatabaseStore.getState().invalidateHosts())
    await screen.findByText("After")
    expect(aggregate).toHaveBeenCalledTimes(2)
  })

  it("shows an error with retry instead of an empty chart", async () => {
    vi.spyOn(storage, "aggregateDatabase").mockRejectedValue(new Error("projection unavailable"))
    render(<ChartView databaseId="db" expectedGeneration={1} enabled category={category} />)
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("projection unavailable"),
    )
  })
})
