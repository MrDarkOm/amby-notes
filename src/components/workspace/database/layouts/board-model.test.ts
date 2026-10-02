import { describe, expect, it } from "vitest"
import { ALL_BOARD_LANE, EMPTY_BOARD_LANE, groupBoardRows, moveRowToBoardLane } from "./board-model"

const field = { kind: "property" as const, propertyId: "status" }
const row = (noteId: string, optionId?: string) => ({
  noteId,
  title: noteId,
  relativePath: `${noteId}.md`,
  parentNoteId: null,
  depth: 0,
  categoryPath: [],
  valuesJson: JSON.stringify(optionId ? { status: { type: "status", optionId } } : {}),
  rowRevision: "revision",
})

describe("board model", () => {
  it("groups status/select rows and keeps an empty lane", () => {
    expect(groupBoardRows([row("a", "todo"), row("b"), row("c", "done")], field)).toEqual([
      { key: "todo", rows: [row("a", "todo")], label: null, color: null },
      { key: EMPTY_BOARD_LANE, rows: [row("b")], label: null, color: null },
      { key: "done", rows: [row("c", "done")], label: null, color: null },
    ])
  })

  it("optimistically replaces the typed option without changing the row identity", () => {
    const moved = moveRowToBoardLane([row("a", "todo")], "a", field, "done")
    expect(moved[0].noteId).toBe("a")
    expect(JSON.parse(moved[0].valuesJson).status.optionId).toBe("done")
  })

  it("does not invent a lane for an unsupported group field", () => {
    expect(groupBoardRows([row("a")], { kind: "system", field: "title" })).toEqual([
      { key: ALL_BOARD_LANE, rows: [row("a")], label: null, color: null },
    ])
  })

  describe("with a Status schema", () => {
    const properties = [
      {
        propertyId: "status",
        name: "Status",
        propertyType: "status",
        configJson: "{}",
        options: [
          { optionId: "todo", name: "To do", color: "#94a3b8" },
          { optionId: "doing", name: "Doing", color: "bad-color" },
          { optionId: "done", name: "Done", color: "#22c55e" },
        ],
      },
    ]

    it("shows every option as a lane in schema order, including empty ones", () => {
      const lanes = groupBoardRows([row("c", "done")], field, properties)
      expect(lanes.map((lane) => [lane.key, lane.label, lane.rows.length])).toEqual([
        ["todo", "To do", 0],
        ["doing", "Doing", 0],
        ["done", "Done", 1],
        [EMPTY_BOARD_LANE, null, 0],
      ])
      expect(lanes.map((lane) => lane.color)).toEqual(["#94a3b8", null, "#22c55e", null])
    })

    it("keeps rows with a removed option in their own lane before the no-value lane", () => {
      const lanes = groupBoardRows([row("a", "gone"), row("b")], field, properties)
      expect(lanes.map((lane) => lane.key)).toEqual([
        "todo",
        "doing",
        "done",
        "gone",
        EMPTY_BOARD_LANE,
      ])
      expect(lanes[3]).toMatchObject({ label: null, rows: [row("a", "gone")] })
      expect(lanes[4].rows).toEqual([row("b")])
    })

    it("does not depend on the loaded page: no rows still gives all lanes", () => {
      expect(groupBoardRows([], field, properties)).toHaveLength(4)
    })
  })
})
