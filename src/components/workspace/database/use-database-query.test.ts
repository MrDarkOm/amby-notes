// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useDatabaseQuery, _clearInFlightQueriesForTesting } from "./use-database-query"
import { useDatabaseStore } from "./database-store"
import * as storage from "@/lib/storage"

describe("useDatabaseQuery", () => {
  beforeEach(() => {
    _clearInFlightQueriesForTesting()
    useDatabaseStore.getState().reset(1)
    useDatabaseStore.getState().setRuntime({
      enabled: true,
      vaultGeneration: 1,
      projection: null,
    })
    useDatabaseStore.getState().setCatalog([
      {
        databaseId: "db-1",
        title: "Test DB",
        icon: null,
        attachedNoteId: null,
        manifestRevision: "rev-1",
        locked: false,
        properties: [],
        views: [],
        templates: [],
        diagnostics: [],
      },
    ])
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useDatabaseStore.getState().reset(null)
    _clearInFlightQueriesForTesting()
  })

  it("loads the first page of rows and transitions to ready", async () => {
    const mockRows: storage.DatabaseRow[] = [
      {
        noteId: "note-1",
        title: "First Row",
        relativePath: "note-1.md",
        parentNoteId: null,
        depth: 0,
        categoryPath: [],
        valuesJson: "{}",
        rowRevision: "r1",
      },
    ]

    vi.spyOn(storage, "queryDatabase").mockResolvedValueOnce({
      database: {
        databaseId: "db-1",
        title: "Test DB",
        icon: null,
        attachedNoteId: null,
        manifestRevision: "rev-1",
        locked: false,
        properties: [],
        views: [],
        templates: [],
        diagnostics: [],
      },
      projection: { epoch: "ep-1", seq: 1 },
      rows: mockRows,
      nextCursor: null,
      diagnostics: [],
      totalCount: 1,
    })

    const { result } = renderHook(() =>
      useDatabaseQuery({
        databaseId: "db-1",
        vaultGeneration: 1,
        enabled: true,
      }),
    )

    // Wait for the async loadPage to resolve
    await vi.waitFor(() => {
      expect(result.current.host?.status).toBe("ready")
    })

    expect(result.current.host?.rows).toHaveLength(1)
    expect(result.current.host?.rows[0].title).toBe("First Row")
    expect(result.current.host?.totalCount).toBe(1)
    expect(result.current.host?.error).toBeNull()
  })

  it("handles React StrictMode unmount-remount without getting stuck in loading", async () => {
    const mockRows: storage.DatabaseRow[] = [
      {
        noteId: "note-1",
        title: "Row 1",
        relativePath: "note-1.md",
        parentNoteId: null,
        depth: 0,
        categoryPath: [],
        valuesJson: "{}",
        rowRevision: "r1",
      },
    ]

    let resolveQuery: (value: storage.DatabaseQueryResult) => void
    const queryPromise = new Promise<storage.DatabaseQueryResult>((resolve) => {
      resolveQuery = resolve
    })

    vi.spyOn(storage, "queryDatabase").mockReturnValue(queryPromise)

    // First mount
    const hook1 = renderHook(() =>
      useDatabaseQuery({
        databaseId: "db-1",
        vaultGeneration: 1,
        enabled: true,
      }),
    )

    // StrictMode unmounts immediately while query is still in-flight
    hook1.unmount()

    // StrictMode mounts a second time
    const hook2 = renderHook(() =>
      useDatabaseQuery({
        databaseId: "db-1",
        vaultGeneration: 1,
        enabled: true,
      }),
    )

    // Now the in-flight query completes
    await act(async () => {
      resolveQuery({
        database: {
          databaseId: "db-1",
          title: "Test DB",
          icon: null,
          attachedNoteId: null,
          manifestRevision: "rev-1",
          locked: false,
          properties: [],
          views: [],
          templates: [],
          diagnostics: [],
        },
        projection: { epoch: "ep-1", seq: 1 },
        rows: mockRows,
        nextCursor: null,
        diagnostics: [],
        totalCount: 1,
      })
    })

    // The second mount must see status "ready" and rows, NOT stuck in "loading"
    await vi.waitFor(() => {
      expect(hook2.result.current.host?.status).toBe("ready")
    })
    expect(hook2.result.current.host?.rows).toHaveLength(1)
  })

  it("appends subsequent pages on loadNextPage", async () => {
    const page1Rows: storage.DatabaseRow[] = [
      {
        noteId: "n-1",
        title: "Row 1",
        relativePath: "n-1.md",
        parentNoteId: null,
        depth: 0,
        categoryPath: [],
        valuesJson: "{}",
        rowRevision: "r1",
      },
    ]
    const page2Rows: storage.DatabaseRow[] = [
      {
        noteId: "n-2",
        title: "Row 2",
        relativePath: "n-2.md",
        parentNoteId: null,
        depth: 0,
        categoryPath: [],
        valuesJson: "{}",
        rowRevision: "r2",
      },
    ]

    const querySpy = vi.spyOn(storage, "queryDatabase")
    querySpy
      .mockResolvedValueOnce({
        database: {
          databaseId: "db-1",
          title: "Test DB",
          icon: null,
          attachedNoteId: null,
          manifestRevision: "rev-1",
          locked: false,
          properties: [],
          views: [],
          templates: [],
          diagnostics: [],
        },
        projection: { epoch: "ep-1", seq: 1 },
        rows: page1Rows,
        nextCursor: "cursor-page-2",
        diagnostics: [],
        totalCount: 2,
      })
      .mockResolvedValueOnce({
        database: {
          databaseId: "db-1",
          title: "Test DB",
          icon: null,
          attachedNoteId: null,
          manifestRevision: "rev-1",
          locked: false,
          properties: [],
          views: [],
          templates: [],
          diagnostics: [],
        },
        projection: { epoch: "ep-1", seq: 1 },
        rows: page2Rows,
        nextCursor: null,
        diagnostics: [],
        totalCount: 2,
      })

    const { result } = renderHook(() =>
      useDatabaseQuery({
        databaseId: "db-1",
        vaultGeneration: 1,
        enabled: true,
      }),
    )

    await vi.waitFor(() => {
      expect(result.current.host?.status).toBe("ready")
    })
    expect(result.current.host?.rows).toHaveLength(1)
    expect(result.current.host?.nextCursor).toBe("cursor-page-2")

    // Trigger loadNextPage
    await act(async () => {
      await result.current.loadNextPage()
    })

    await vi.waitFor(() => {
      expect(result.current.host?.rows).toHaveLength(2)
    })
    expect(result.current.host?.rows[0].title).toBe("Row 1")
    expect(result.current.host?.rows[1].title).toBe("Row 2")
    expect(result.current.host?.nextCursor).toBeNull()
  })

  it("transitions to error on query failure and allows retry", async () => {
    const querySpy = vi.spyOn(storage, "queryDatabase")
    querySpy.mockRejectedValueOnce(new Error("Database connection lost"))

    const { result } = renderHook(() =>
      useDatabaseQuery({
        databaseId: "db-1",
        vaultGeneration: 1,
        enabled: true,
      }),
    )

    await vi.waitFor(() => {
      expect(result.current.host?.status).toBe("error")
    })
    expect(result.current.host?.error).toBe("Database connection lost")

    // Successful retry
    querySpy.mockResolvedValueOnce({
      database: {
        databaseId: "db-1",
        title: "Test DB",
        icon: null,
        attachedNoteId: null,
        manifestRevision: "rev-1",
        locked: false,
        properties: [],
        views: [],
        templates: [],
        diagnostics: [],
      },
      projection: { epoch: "ep-1", seq: 1 },
      rows: [],
      nextCursor: null,
      diagnostics: [],
      totalCount: 0,
    })

    await act(async () => {
      await result.current.retry()
    })

    await vi.waitFor(() => {
      expect(result.current.host?.status).toBe("ready")
    })
    expect(result.current.host?.error).toBeNull()
  })
})
