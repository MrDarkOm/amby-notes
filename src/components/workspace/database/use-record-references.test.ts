// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as storage from "@/lib/storage"
import { useDatabaseStore } from "./database-store"
import { referenceTitles, relationTargetIds, useRecordReferences } from "./use-record-references"

describe("useRecordReferences", () => {
  beforeEach(() => useDatabaseStore.getState().reset(7))
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useDatabaseStore.getState().reset(null)
  })

  it("names far-away pages and marks unavailable ones, in one batched call", async () => {
    const resolve = vi
      .spyOn(storage, "resolveRecordReferences")
      .mockImplementation(async ({ noteIds }) => ({
        references: noteIds.map((noteId) =>
          noteId === "gone"
            ? { noteId, state: "missing" as const, title: null, path: null }
            : { noteId, state: "ok" as const, title: `Title of ${noteId}`, path: `${noteId}.md` },
        ),
      }))
    const ids = ["p101", "gone", "p102"]
    const { result } = renderHook(() => useRecordReferences(ids))
    expect(result.current.p101).toEqual({ status: "loading" })
    await waitFor(() => expect(result.current.p102.status).toBe("ok"))
    expect(result.current.p101).toMatchObject({ status: "ok", title: "Title of p101" })
    expect(result.current.gone).toEqual({ status: "missing" })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0][0]).toMatchObject({ expectedGeneration: 7 })
  })

  it("reports a failed lookup per id instead of inventing a title", async () => {
    vi.spyOn(storage, "resolveRecordReferences").mockRejectedValue(new Error("offline"))
    const { result } = renderHook(() => useRecordReferences(["x1"]))
    await waitFor(() => expect(result.current.x1.status).toBe("error"))
    expect(referenceTitles(result.current)).toEqual({})
  })

  it("keeps every cell answered when a change makes all of them ask again", async () => {
    useDatabaseStore.getState().reset(7)
    vi.spyOn(storage, "resolveRecordReferences").mockImplementation(async ({ noteIds }) => ({
      references: noteIds.map((noteId) => ({
        noteId,
        state: "ok" as const,
        title: `Title of ${noteId}`,
        path: `${noteId}.md`,
      })),
    }))
    // Two cells, as in a table: each runs its own hook against the one shared resolver.
    const first = renderHook(() => useRecordReferences(["q1"]))
    const second = renderHook(() => useRecordReferences(["q2"]))
    await waitFor(() => expect(first.result.current.q1.status).toBe("ok"))
    await waitFor(() => expect(second.result.current.q2.status).toBe("ok"))
    useDatabaseStore.getState().invalidateHosts()
    await waitFor(() => expect(first.result.current.q1.status).toBe("ok"))
    await waitFor(() => expect(second.result.current.q2.status).toBe("ok"))
    expect(first.result.current.q1).toMatchObject({ title: "Title of q1" })
    expect(second.result.current.q2).toMatchObject({ title: "Title of q2" })
  })
})

describe("relationTargetIds", () => {
  it("collects unique Relation targets from many rows and ignores bad JSON", () => {
    const row = (targets: string[]) =>
      JSON.stringify({
        r: { type: "relation", targetNoteIds: targets },
        t: { type: "text", value: "x" },
      })
    expect(
      relationTargetIds([row(["a", "b"]), row(["b", "c"]), "not json", "null"]).sort(),
    ).toEqual(["a", "b", "c"])
  })
})
