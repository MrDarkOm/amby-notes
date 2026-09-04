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
      { key: "todo", rows: [row("a", "todo")] },
      { key: EMPTY_BOARD_LANE, rows: [row("b")] },
      { key: "done", rows: [row("c", "done")] },
    ])
  })

  it("optimistically replaces the typed option without changing the row identity", () => {
    const moved = moveRowToBoardLane([row("a", "todo")], "a", field, "done")
    expect(moved[0].noteId).toBe("a")
    expect(JSON.parse(moved[0].valuesJson).status.optionId).toBe("done")
  })

  it("does not invent a lane for an unsupported group field", () => {
    expect(groupBoardRows([row("a")], { kind: "system", field: "title" })).toEqual([
      { key: ALL_BOARD_LANE, rows: [row("a")] },
    ])
  })
})
