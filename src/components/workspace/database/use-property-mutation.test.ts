// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as storage from "@/lib/storage"
import type { DatabasePropertySummary } from "@/lib/storage"
import {
  _resetPropertyMutationForTesting,
  cellKey,
  usePropertyMutation,
} from "./use-property-mutation"

const textProperty: DatabasePropertySummary = {
  propertyId: "p-text",
  name: "Note",
  propertyType: "text",
  configJson: "{}",
  options: [],
}
const relationProperty: DatabasePropertySummary = {
  propertyId: "p-rel",
  name: "Project",
  propertyType: "relation",
  configJson: "{}",
  options: [],
}
const row = { noteId: "n1", rowRevision: "rev-0" }

describe("usePropertyMutation", () => {
  beforeEach(() => _resetPropertyMutationForTesting())
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("writes Relation through the Relation command, never the plain batch", async () => {
    const relation = vi.spyOn(storage, "updateDatabaseRelationValue").mockResolvedValue({
      operationId: "x",
      databaseId: "db",
      noteId: "n1",
      targetNoteIds: ["t1"],
      affectedNotes: [],
      revisions: [{ noteId: "n1", revision: "rev-1" }],
      warnings: [],
    })
    const batch = vi.spyOn(storage, "applyDatabaseValueBatch")
    const { result } = renderHook(() =>
      usePropertyMutation({ databaseId: "db", vaultGeneration: 3 }),
    )
    await act(() =>
      result.current.commit(
        row,
        relationProperty,
        JSON.stringify({ type: "relation", targetNoteIds: ["t1"] }),
      ),
    )
    expect(batch).not.toHaveBeenCalled()
    expect(relation).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 3,
        databaseId: "db",
        noteId: "n1",
        propertyId: "p-rel",
        targetNoteIds: ["t1"],
        expectedRevision: "rev-0",
        operationId: expect.stringMatching(/^cell-/),
      }),
    )
  })

  it("serializes writes to one row and chains the returned revision, across editors", async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const batch = vi
      .spyOn(storage, "applyDatabaseValueBatch")
      .mockImplementationOnce(async (request) => {
        order.push(`start:${request.cells[0].expectedRevision}`)
        await new Promise<void>((resolve) => (release = resolve))
        order.push("end:first")
        return {
          operationId: "a",
          databaseId: "db",
          revisions: [{ noteId: "n1", revision: "rev-1" }],
          warnings: [],
        }
      })
      .mockImplementationOnce(async (request) => {
        order.push(`start:${request.cells[0].expectedRevision}`)
        return {
          operationId: "b",
          databaseId: "db",
          revisions: [{ noteId: "n1", revision: "rev-2" }],
          warnings: [],
        }
      })
    // Two separate editors (for example the table and the info panel).
    const table = renderHook(() => usePropertyMutation({ databaseId: "db", vaultGeneration: 3 }))
    const panel = renderHook(() => usePropertyMutation({ databaseId: "db", vaultGeneration: 3 }))
    let first: Promise<void> = Promise.resolve()
    let second: Promise<void> = Promise.resolve()
    act(() => {
      first = table.result.current.commit(
        row,
        textProperty,
        JSON.stringify({ type: "text", value: "a" }),
      )
      // The panel still holds the old revision of the row.
      second = panel.result.current.commit(
        row,
        textProperty,
        JSON.stringify({ type: "text", value: "b" }),
      )
    })
    await vi.waitFor(() => expect(order).toEqual(["start:rev-0"]))
    release()
    await act(async () => {
      await first
      await second
    })
    expect(order).toEqual(["start:rev-0", "end:first", "start:rev-1"])
    expect(batch).toHaveBeenCalledTimes(2)
  })

  it("keeps the failure per cell, drops the cached revision and reports through onSettled", async () => {
    const settled = vi.fn()
    vi.spyOn(storage, "applyDatabaseValueBatch")
      .mockRejectedValueOnce(new Error("Record revision conflict"))
      .mockResolvedValueOnce({ operationId: "c", databaseId: "db", revisions: [], warnings: ["w"] })
    const { result } = renderHook(() =>
      usePropertyMutation({ databaseId: "db", vaultGeneration: 3, onSettled: settled }),
    )
    await act(() => result.current.commit(row, textProperty, undefined))
    expect(result.current.cellErrors[cellKey("n1", "p-text")]).toBe("Record revision conflict")
    expect(settled).toHaveBeenLastCalledWith({ ok: false })
    expect(result.current.pendingCells.size).toBe(0)

    await act(() => result.current.commit(row, textProperty, undefined))
    expect(result.current.cellErrors[cellKey("n1", "p-text")]).toBeUndefined()
    expect(settled).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: true, result: expect.objectContaining({ warnings: ["w"] }) }),
    )
    // The failed write left no revision behind: the retry used the row's own.
    expect(
      vi.mocked(storage.applyDatabaseValueBatch).mock.calls[1][0].cells[0].expectedRevision,
    ).toBe("rev-0")
  })

  it("does nothing without an open vault", async () => {
    const batch = vi.spyOn(storage, "applyDatabaseValueBatch")
    const { result } = renderHook(() =>
      usePropertyMutation({ databaseId: "db", vaultGeneration: null }),
    )
    await act(() => result.current.commit(row, textProperty, undefined))
    expect(batch).not.toHaveBeenCalled()
  })
})
