import { afterEach, describe, expect, it, vi } from "vitest"
import * as storage from "@/lib/storage"
import { placeNewRecordInLane } from "./new-record-lane"

const created = {
  databaseId: "db",
  noteId: "n1",
  title: "x",
  notePath: "/x.md",
  recordPath: "",
  recordRevision: "",
  warnings: [],
}
const base = {
  vaultGeneration: 1,
  databaseId: "db",
  created,
}

afterEach(() => vi.restoreAllMocks())

describe("placing a new page in a board lane", () => {
  it("writes the lane's option into the group property", async () => {
    const batch = vi.spyOn(storage, "applyDatabaseValueBatch").mockResolvedValue({} as never)
    await placeNewRecordInLane({
      ...base,
      groupProperty: { propertyId: "p", propertyType: "status" },
      laneKey: "opt1",
    })
    const cell = batch.mock.calls[0][0].cells[0]
    expect(cell).toMatchObject({ noteId: "n1", propertyId: "p", expectedRevision: "" })
    expect(JSON.parse(cell.valueJson ?? "{}")).toEqual({ type: "status", optionId: "opt1" })
  })

  it("writes nothing for the no-value lane or a property that has no lanes", async () => {
    const batch = vi.spyOn(storage, "applyDatabaseValueBatch").mockResolvedValue({} as never)
    await placeNewRecordInLane({
      ...base,
      groupProperty: { propertyId: "p", propertyType: "select" },
      laneKey: "__empty__",
    })
    await placeNewRecordInLane({
      ...base,
      groupProperty: { propertyId: "p", propertyType: "text" },
      laneKey: "opt1",
    })
    expect(batch).not.toHaveBeenCalled()
  })
})
