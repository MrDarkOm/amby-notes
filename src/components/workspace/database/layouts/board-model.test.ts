import { describe, expect, it } from "vitest"
import {
  ALL_BOARD_LANE,
  EMPTY_BOARD_LANE,
  arrangeLanes,
  groupBoardRows,
  groupListOrder,
  moveRowToBoardLane,
  type BoardLane,
} from "./board-model"

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

describe("arranging the columns of a board", () => {
  const lane = (key: string, label: string | null, count = 1): BoardLane => ({
    key,
    label,
    color: null,
    rows: [],
    count,
  })
  const natural = [
    lane("b", "Beta"),
    lane("a", "Alpha"),
    lane("c", "Charlie", 0),
    lane(EMPTY_BOARD_LANE, null),
  ]
  const base = { sort: "manual" as const, order: [], hidden: [], hideEmpty: false }

  it("keeps the schema order without a manual order", () => {
    expect(arrangeLanes(natural, base).map((l) => l.key)).toEqual(["b", "a", "c", EMPTY_BOARD_LANE])
  })

  it("follows a manual order and puts columns it does not know after the known ones", () => {
    const result = arrangeLanes(natural, { ...base, order: ["c", "a"] })
    expect(result.map((l) => l.key)).toEqual(["c", "a", "b", EMPTY_BOARD_LANE])
  })

  it("sorts by name, either way, without moving the no-value column into the middle", () => {
    expect(arrangeLanes(natural, { ...base, sort: "alphabetical" }).map((l) => l.key)).toEqual([
      "a",
      "b",
      "c",
      EMPTY_BOARD_LANE,
    ])
    expect(
      arrangeLanes(natural, { ...base, sort: "reverseAlphabetical" }).map((l) => l.key),
    ).toEqual(["c", "b", "a", EMPTY_BOARD_LANE])
  })

  it("leaves out hidden columns, and empty ones when asked", () => {
    expect(arrangeLanes(natural, { ...base, hidden: ["a"] }).map((l) => l.key)).toEqual([
      "b",
      "c",
      EMPTY_BOARD_LANE,
    ])
    expect(arrangeLanes(natural, { ...base, hideEmpty: true }).map((l) => l.key)).toEqual([
      "b",
      "a",
      EMPTY_BOARD_LANE,
    ])
  })

  it("lists every column for the settings, hidden and empty ones too", () => {
    expect(
      groupListOrder(natural, { ...base, hidden: ["a"], hideEmpty: true }).map((l) => l.key),
    ).toEqual(["b", "a", "c", EMPTY_BOARD_LANE])
  })
})
