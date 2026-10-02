// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as storage from "@/lib/storage"
import type { DatabaseRow } from "@/lib/storage"
import { useDatabaseStore } from "./database-store"
import { useBoardLanes } from "./use-board-lanes"

const options = [
  { optionId: "todo", name: "To do", color: "#94a3b8" },
  { optionId: "done", name: "Done", color: "#22c55e" },
]

const row = (noteId: string, optionId?: string): DatabaseRow => ({
  noteId,
  title: noteId,
  relativePath: `${noteId}.md`,
  parentNoteId: null,
  depth: 0,
  categoryPath: [],
  valuesJson: JSON.stringify(optionId ? { s: { type: "status", optionId } } : {}),
  rowRevision: "r",
})

function mockBackend(groups: Array<{ key: string; count: number }>) {
  vi.spyOn(storage, "aggregateDatabase").mockResolvedValue({
    databaseId: "db",
    groups: groups.map((group) => ({ ...group, label: group.key, value: null })),
    totalCount: groups.reduce((sum, group) => sum + group.count, 0),
    warnings: [],
  })
  return vi.spyOn(storage, "queryDatabase").mockImplementation(async (request) => {
    const condition = JSON.stringify(request.filter)
    const key = condition.includes("isEmpty")
      ? "__empty__"
      : (/"value":"\\"(\w+)\\""/.exec(condition)?.[1] ?? "")
    const all =
      key === "todo"
        ? [row("a", "todo"), row("b", "todo"), row("c", "todo")]
        : key === "done"
          ? [row("d", "done")]
          : [row("e")]
    const start = request.page.cursor ? Number(request.page.cursor) : 0
    const slice = all.slice(start, start + 2)
    return {
      database: {} as never,
      projection: {} as never,
      rows: slice,
      nextCursor: start + 2 < all.length ? String(start + 2) : null,
      diagnostics: [],
      totalCount: all.length,
    }
  })
}

describe("useBoardLanes", () => {
  beforeEach(() => useDatabaseStore.getState().reset(1))
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useDatabaseStore.getState().reset(null)
  })

  const render = (extra: Partial<Parameters<typeof useBoardLanes>[0]> = {}) =>
    renderHook(() =>
      useBoardLanes({ databaseId: "db", groupPropertyId: "s", options, enabled: true, ...extra }),
    )

  it("shows every option lane with the full count, even before any row is loaded", async () => {
    const query = mockBackend([
      { key: "todo", count: 3 },
      { key: "__empty__", count: 1 },
    ])
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(
      result.current.lanes.map((lane) => [lane.key, lane.label, lane.count, lane.rows.length]),
    ).toEqual([
      ["todo", "To do", 3, 2],
      ["done", "Done", 0, 0],
      ["__empty__", null, 1, 1],
    ])
    // Lanes without cards are not queried at all.
    expect(query.mock.calls.length).toBe(2)
    expect(result.current.lanes[0].hasMore).toBe(true)
  })

  it("keeps a lane for values of a removed option, before the no-value lane", async () => {
    mockBackend([
      { key: "gone", count: 1 },
      { key: "done", count: 1 },
    ])
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.lanes.map((lane) => lane.key)).toEqual([
      "todo",
      "done",
      "gone",
      "__empty__",
    ])
    expect(result.current.lanes[2].label).toBeNull()
  })

  it("pages one lane without touching the others", async () => {
    const query = mockBackend([{ key: "todo", count: 3 }])
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe("ready"))
    const callsBefore = query.mock.calls.length
    act(() => result.current.loadMore("todo"))
    await waitFor(() => expect(result.current.lanes[0].rows).toHaveLength(3))
    expect(query.mock.calls.length).toBe(callsBefore + 1)
    expect(query.mock.calls[query.mock.calls.length - 1][0].page.cursor).toBe("2")
    expect(result.current.lanes[0].hasMore).toBe(false)
  })

  it("applies the view filter and search to counts and lane queries", async () => {
    const query = mockBackend([{ key: "todo", count: 1 }])
    const filter = {
      kind: "condition" as const,
      field: { kind: "property" as const, propertyId: "p" },
      operator: "equals",
      value: '"x"',
    }
    const { result } = render({ filter, search: " acme " })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(vi.mocked(storage.aggregateDatabase).mock.calls[0][0]).toMatchObject({
      search: "acme",
      source: { kind: "inline", spec: { filter } },
      category: { kind: "property", propertyId: "s" },
    })
    const request = query.mock.calls[0][0]
    expect(request.search).toBe("acme")
    expect(request.filter).toMatchObject({ kind: "group", operator: "and" })
  })

  it("moves a card between lanes at once and adjusts both counts", async () => {
    mockBackend([
      { key: "todo", count: 3 },
      { key: "done", count: 1 },
    ])
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe("ready"))
    const card = result.current.lanes[0].rows[0]
    act(() => result.current.moveLocally(card, "todo", "done"))
    const [todo, done] = result.current.lanes
    expect(todo.count).toBe(2)
    expect(done.count).toBe(2)
    expect(done.rows[0].noteId).toBe(card.noteId)
    expect(JSON.parse(done.rows[0].valuesJson).s.optionId).toBe("done")
    expect(todo.rows.some((candidate) => candidate.noteId === card.noteId)).toBe(false)
  })

  it("reports a failed aggregate as an error and stays idle while disabled", async () => {
    vi.spyOn(storage, "aggregateDatabase").mockRejectedValue(new Error("projection unavailable"))
    const failing = render()
    await waitFor(() => expect(failing.result.current.status).toBe("error"))
    expect(failing.result.current.error).toBe("projection unavailable")
    const idle = render({ enabled: false })
    expect(idle.result.current.status).toBe("idle")
  })
})
