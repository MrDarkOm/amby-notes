// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as storage from "@/lib/storage"
import { useDatabaseStore } from "./database-store"
import { useRelationCandidates } from "./use-relation-candidates"

const candidate = (index: number) => ({
  noteId: `01J${String(index).padStart(23, "0")}`,
  title: `Page ${index}`,
  path: `Pages/Page ${index}.md`,
})

describe("useRelationCandidates", () => {
  beforeEach(() => useDatabaseStore.getState().reset(1))
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useDatabaseStore.getState().reset(null)
  })

  it("loads the first page, then appends the next page without duplicates", async () => {
    const search = vi
      .spyOn(storage, "searchRelationCandidates")
      .mockResolvedValueOnce({ candidates: [candidate(1), candidate(2)], nextCursor: "c1" })
      .mockResolvedValueOnce({ candidates: [candidate(2), candidate(3)], nextCursor: null })
    const { result } = renderHook(() =>
      useRelationCandidates({ databaseId: "db", query: "", enabled: true }),
    )
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.hasMore).toBe(true)
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(3))
    expect(result.current.hasMore).toBe(false)
    expect(search.mock.calls[1][0]).toMatchObject({ cursor: "c1" })
  })

  it("searches the server for the typed text and ignores a slower older answer", async () => {
    let releaseOld: (value: storage.RelationCandidatePage) => void = () => {}
    const search = vi
      .spyOn(storage, "searchRelationCandidates")
      .mockImplementationOnce(() => new Promise((resolve) => (releaseOld = resolve)))
      .mockResolvedValue({ candidates: [candidate(437)], nextCursor: null })
    const { result, rerender } = renderHook(
      ({ query }) => useRelationCandidates({ databaseId: "db", query, enabled: true }),
      { initialProps: { query: "" } },
    )
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    rerender({ query: "page 437" })
    await waitFor(() =>
      expect(result.current.items.map((item) => item.title)).toEqual(["Page 437"]),
    )
    expect(search.mock.calls[1][0]).toMatchObject({ search: "page 437" })
    // The older, slower response must not replace the newer result.
    await act(async () => releaseOld({ candidates: [candidate(1)], nextCursor: null }))
    expect(result.current.items.map((item) => item.title)).toEqual(["Page 437"])
    expect(result.current.settledQuery).toBe("page 437")
  })

  it("reports a failure as an error, not as an empty list, and can retry", async () => {
    const search = vi
      .spyOn(storage, "searchRelationCandidates")
      .mockRejectedValueOnce(new Error("projection unavailable"))
      .mockResolvedValueOnce({ candidates: [candidate(1)], nextCursor: null })
    const { result } = renderHook(() =>
      useRelationCandidates({ databaseId: "db", query: "", enabled: true }),
    )
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current.error).toBe("projection unavailable")
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(search).toHaveBeenCalledTimes(2)
    expect(result.current.items).toHaveLength(1)
  })

  it("does not query while closed", () => {
    const search = vi.spyOn(storage, "searchRelationCandidates")
    renderHook(() => useRelationCandidates({ databaseId: "db", query: "", enabled: false }))
    expect(search).not.toHaveBeenCalled()
  })
})
