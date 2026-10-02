// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as storage from "@/lib/storage"
import { useSavedView } from "./use-saved-view"

const docFor = (viewId: string, extra: Record<string, unknown> = {}) => ({
  format: "amby-database-view",
  formatVersion: 1,
  databaseId: "db",
  viewId,
  name: viewId,
  layout: "table",
  openMode: "sidePeek",
  fields: [{ field: { kind: "system", field: "title" }, visible: true, width: null, frozen: true }],
  filter: null,
  sorts: [],
  layoutConfig: {},
  ...extra,
})

const viewDoc = (viewId: string, revision: string, extra?: Record<string, unknown>) => ({
  databaseId: "db",
  viewId,
  title: viewId,
  layout: "table",
  revision,
  configJson: JSON.stringify(docFor(viewId, extra)),
})

function setup(
  props: Partial<Parameters<typeof useSavedView>[0]> = {},
  docs: Record<string, ReturnType<typeof viewDoc>> = { v1: viewDoc("v1", "r1") },
) {
  vi.spyOn(storage, "getDatabaseView").mockImplementation(async (request) => {
    const doc = docs[request.viewId]
    if (!doc || doc.revision !== request.expectedViewRevision) {
      throw new Error("View revision conflict")
    }
    return doc
  })
  return renderHook((hookProps: Parameters<typeof useSavedView>[0]) => useSavedView(hookProps), {
    initialProps: {
      databaseId: "db",
      vaultGeneration: 1,
      view: { viewId: "v1", revision: "r1" },
      persist: true,
      ...props,
    },
  })
}

describe("useSavedView", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("reads the view document and exposes its settings", async () => {
    const docs = {
      v1: viewDoc("v1", "r1", { layoutConfig: { frozenBoundary: "title", wrappedFields: ["a"] } }),
    }
    const { result } = setup({}, docs)
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.settings).toMatchObject({ frozenKey: "title", wrapped: ["a"] })
  })

  it("applies changes at once and writes them once after a pause, without reloading", async () => {
    const write = vi.spyOn(storage, "updateDatabaseViewConfig").mockResolvedValue({
      databaseId: "db",
      viewId: "v1",
      viewRevision: "r2",
      manifestRevision: "m",
      warnings: [],
    })
    const { result, rerender } = setup()
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => {
      result.current.update({ widths: { a: 210 } })
      result.current.update({ widths: { b: 300 }, wrapped: ["a"] })
    })
    expect(result.current.settings.widths).toEqual({ a: 210, b: 300 })
    expect(write).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(write).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(write.mock.calls[0][0].configJson)
    expect(write.mock.calls[0][0].expectedViewRevision).toBe("r1")
    expect(sent.layoutConfig.wrappedFields).toEqual(["a"])
    expect(sent.fields.map((f: { width: number | null }) => f.width)).toEqual([null, 210, 300])
    // The catalog now reports our own new revision: no reload, local state kept.
    rerender({
      databaseId: "db",
      vaultGeneration: 1,
      view: { viewId: "v1", revision: "r2" },
      persist: true,
    })
    expect(storage.getDatabaseView).toHaveBeenCalledTimes(1)
    expect(result.current.settings.widths).toEqual({ a: 210, b: 300 })
  })

  it("rebases onto a newer document when another window changed the view", async () => {
    const theirs = viewDoc("v1", "r9", { layoutConfig: { frozenBoundary: "title" } })
    const write = vi
      .spyOn(storage, "updateDatabaseViewConfig")
      .mockRejectedValueOnce(new Error("View revision conflict"))
      .mockResolvedValueOnce({
        databaseId: "db",
        viewId: "v1",
        viewRevision: "r10",
        manifestRevision: "m",
        warnings: [],
      })
    vi.spyOn(storage, "listDatabases").mockResolvedValue([
      {
        databaseId: "db",
        title: "Db",
        icon: null,
        attachedNoteId: null,
        manifestRevision: "m",
        locked: false,
        properties: [],
        views: [{ viewId: "v1", title: "v1", layout: "table", revision: "r9", groupField: null }],
        templates: [],
        diagnostics: [],
      },
    ])
    const docs: Record<string, ReturnType<typeof viewDoc>> = { v1: viewDoc("v1", "r1") }
    const { result } = setup({}, docs)
    await waitFor(() => expect(result.current.ready).toBe(true))
    // The other window's version becomes readable after our first attempt fails.
    docs.v1 = theirs
    act(() => result.current.update({ wrapped: ["a"] }))
    await act(() => vi.advanceTimersByTimeAsync(500))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    const second = JSON.parse(write.mock.calls[1][0].configJson)
    expect(write.mock.calls[1][0].expectedViewRevision).toBe("r9")
    // Their setting and ours both survive.
    expect(second.layoutConfig).toEqual({ frozenBoundary: "title", wrappedFields: ["a"] })
    await waitFor(() =>
      expect(result.current.settings).toMatchObject({ frozenKey: "title", wrapped: ["a"] }),
    )
  })

  it("flushes a pending change to the old view when switching views", async () => {
    const write = vi.spyOn(storage, "updateDatabaseViewConfig").mockResolvedValue({
      databaseId: "db",
      viewId: "v1",
      viewRevision: "r2",
      manifestRevision: "m",
      warnings: [],
    })
    const docs = { v1: viewDoc("v1", "r1"), v2: viewDoc("v2", "s1") }
    const { result, rerender } = setup({}, docs)
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => result.current.update({ wrapped: ["a"] }))
    rerender({
      databaseId: "db",
      vaultGeneration: 1,
      view: { viewId: "v2", revision: "s1" },
      persist: true,
    })
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(write.mock.calls[0][0].viewId).toBe("v1")
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.settings.wrapped).toEqual([])
  })

  it("reloads when the view changed elsewhere and nothing is pending", async () => {
    const docs: Record<string, ReturnType<typeof viewDoc>> = { v1: viewDoc("v1", "r1") }
    const { result, rerender } = setup({}, docs)
    await waitFor(() => expect(result.current.ready).toBe(true))
    docs.v1 = viewDoc("v1", "r5", { layoutConfig: { wrappedFields: ["z"] } })
    rerender({
      databaseId: "db",
      vaultGeneration: 1,
      view: { viewId: "v1", revision: "r5" },
      persist: true,
    })
    await waitFor(() => expect(result.current.settings.wrapped).toEqual(["z"]))
  })

  it("keeps changes local when the database is locked", async () => {
    const write = vi.spyOn(storage, "updateDatabaseViewConfig")
    const { result } = setup({ persist: false })
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => result.current.update({ wrapped: ["a"] }))
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(write).not.toHaveBeenCalled()
    expect(result.current.settings.wrapped).toEqual(["a"])
  })
})
