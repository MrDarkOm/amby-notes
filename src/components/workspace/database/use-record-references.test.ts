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
