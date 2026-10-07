// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import { GalleryLanesView } from "./gallery-lanes-view"
import type { BoardLaneState } from "./use-board-lanes"

const lanesHook = vi.hoisted(() => ({
  value: {
    lanes: [] as BoardLaneState[],
    status: "ready" as "ready" | "loading" | "error" | "idle",
    error: null as string | null,
    loadMore: vi.fn(),
    moveLocally: vi.fn(),
    reload: vi.fn(),
  },
  options: null as unknown,
}))
vi.mock("./use-board-lanes", () => ({
  useBoardLanes: (options: unknown) => {
    lanesHook.options = options
    return lanesHook.value
  },
}))

const row = (noteId: string, title: string): DatabaseRow => ({
  noteId,
  title,
  relativePath: `${title}.md`,
  parentNoteId: null,
  depth: 0,
  categoryPath: [],
  valuesJson: "{}",
  rowRevision: "r",
})

const lane = (
  key: string,
  label: string | null,
  rows: DatabaseRow[],
  extra = {},
): BoardLaneState => ({
  key,
  label,
  color: key === "main" ? "#22c55e" : null,
  rows,
  count: rows.length,
  hasMore: false,
  status: "ready",
  error: null,
  ...extra,
})

const property = {
  propertyId: "importance",
  name: "Значимость",
  propertyType: "select",
  configJson: "{}",
  options: [
    { optionId: "main", name: "Главные", color: "#22c55e" },
    { optionId: "side", name: "Второстепенные", color: "#94a3b8" },
  ],
} as unknown as DatabasePropertySummary

function mount(props: Partial<React.ComponentProps<typeof GalleryLanesView>> = {}) {
  return render(
    <GalleryLanesView
      databaseId="db"
      groupProperty={property}
      properties={[property]}
      enabled
      {...props}
    />,
  )
}

describe("GalleryLanesView", () => {
  beforeEach(() => {
    lanesHook.value = {
      lanes: [
        lane("main", "Главные", [row("1", "Алиса"), row("2", "Боб")], { count: 12, hasMore: true }),
        lane("side", "Второстепенные", [row("3", "Карл")]),
        lane("__empty__", null, []),
      ],
      status: "ready",
      error: null,
      loadMore: vi.fn(),
      moveLocally: vi.fn(),
      reload: vi.fn(),
    }
  })
  afterEach(cleanup)

  it("groups the cards under a heading per option with the count of the whole view", () => {
    mount()
    const main = screen.getByRole("region", { name: "Главные" })
    expect(within(main).getByText("12")).toBeTruthy()
    expect(within(main).getByText("Алиса")).toBeTruthy()
    expect(within(main).getByText("Боб")).toBeTruthy()
    expect(
      within(screen.getByRole("region", { name: "Второстепенные" })).getByText("Карл"),
    ).toBeTruthy()
    // Cards without a value get their own group, last.
    expect(screen.getByRole("region", { name: "Без значения" })).toBeTruthy()
  })

  it("asks the lane data for the property, the filter and the search of the view", () => {
    const filter = {
      kind: "condition",
      field: { kind: "property", propertyId: "x" },
      operator: "isEmpty",
    } as const
    mount({ filter, search: "эл", contextPageId: "page" })
    expect(lanesHook.options).toMatchObject({
      databaseId: "db",
      groupPropertyId: "importance",
      options: property.options,
      filter,
      search: "эл",
      contextPageId: "page",
      enabled: true,
    })
  })

  it("applies the view's group settings: order, hidden and empty groups", () => {
    mount({
      groupDisplay: {
        sort: "manual",
        order: ["side", "main"],
        hidden: ["__empty__"],
        hideEmpty: false,
      },
    })
    const names = screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))
    expect(names).toEqual(["Второстепенные", "Главные"])
  })

  it("folds and unfolds a group", () => {
    mount()
    const main = screen.getByRole("region", { name: "Главные" })
    fireEvent.click(within(main).getByRole("button", { name: /Главные/u }))
    expect(within(main).queryByText("Алиса")).toBeNull()
    fireEvent.click(within(main).getByRole("button", { name: /Главные/u }))
    expect(within(main).getByText("Алиса")).toBeTruthy()
  })

  it("loads more cards of one group only", () => {
    mount()
    const main = screen.getByRole("region", { name: "Главные" })
    fireEvent.click(within(main).getByRole("button", { name: "Загрузить ещё" }))
    expect(lanesHook.value.loadMore).toHaveBeenCalledWith("main")
    expect(
      within(screen.getByRole("region", { name: "Второстепенные" })).queryByRole("button", {
        name: "Загрузить ещё",
      }),
    ).toBeNull()
  })

  it("adds a card to the group it was asked in, then reloads the groups", async () => {
    const onCreateCard = vi.fn().mockResolvedValue(undefined)
    mount({ onCreateCard })
    const side = screen.getByRole("region", { name: "Второстепенные" })
    await act(async () => {
      fireEvent.click(within(side).getByRole("button", { name: "Новая страница" }))
    })
    expect(onCreateCard).toHaveBeenCalledWith("side")
    expect(lanesHook.value.reload).toHaveBeenCalled()
  })

  it("opens a card", () => {
    const onRowSelect = vi.fn()
    mount({ onRowSelect })
    fireEvent.click(screen.getByText("Карл"))
    expect(onRowSelect).toHaveBeenCalledWith(expect.objectContaining({ noteId: "3" }))
  })

  it("shows a load error with a retry", () => {
    lanesHook.value = { ...lanesHook.value, lanes: [], status: "error", error: "нет связи" }
    mount()
    expect(screen.getByRole("alert").textContent).toContain("нет связи")
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }))
    expect(lanesHook.value.reload).toHaveBeenCalled()
  })
})
