import { describe, expect, it } from "vitest"
import type { DatabasePropertySummary } from "@/lib/storage"
import {
  OPTION_COLORS,
  draftsChanged,
  draftsFromProperty,
  draftsToInputs,
  findDraftProblem,
  nextOptionColor,
  type OptionDraft,
} from "./option-model"

const status: DatabasePropertySummary = {
  propertyId: "p",
  name: "Stage",
  propertyType: "status",
  configJson: JSON.stringify({
    options: [
      { id: "a", name: "Todo", color: "#94a3b8", group: "notStarted" },
      { id: "b", name: "Doing", color: "#f59e0b", group: "inProgress" },
      { id: "c", name: "Done", color: "#22c55e", group: "done" },
    ],
  }),
  options: [
    { optionId: "a", name: "Todo", color: "#94a3b8" },
    { optionId: "b", name: "Doing", color: "#f59e0b" },
    { optionId: "c", name: "Done", color: "#22c55e" },
  ],
}

describe("option drafts", () => {
  it("reads status groups from the stored configuration", () => {
    expect(draftsFromProperty(status).map((draft) => draft.group)).toEqual([
      "notStarted",
      "inProgress",
      "done",
    ])
  })

  it("falls back to the summary when the configuration cannot be read", () => {
    const drafts = draftsFromProperty({ ...status, configJson: "not json" })
    expect(drafts.map((draft) => draft.name)).toEqual(["Todo", "Doing", "Done"])
    expect(drafts.every((draft) => draft.group === "notStarted")).toBe(true)
  })

  it("sends groups only for a status and keeps IDs", () => {
    const drafts = draftsFromProperty(status)
    expect(draftsToInputs(drafts, true)[1]).toEqual({
      id: "b",
      name: "Doing",
      color: "#f59e0b",
      group: "inProgress",
    })
    expect(draftsToInputs(drafts, false)[1].group).toBeNull()
  })

  it("detects edits, reordering and an unchanged list", () => {
    const drafts = draftsFromProperty(status)
    expect(draftsChanged(drafts, status)).toBe(false)
    expect(draftsChanged([drafts[1], drafts[0], drafts[2]], status)).toBe(true)
    expect(draftsChanged(drafts.slice(0, 2), status)).toBe(true)
    expect(
      draftsChanged(
        drafts.map((d) => ({ ...d, name: `${d.name} ` })),
        status,
      ),
    ).toBe(false)
    expect(draftsChanged([{ ...drafts[0], color: "#EF4444" }, ...drafts.slice(1)], status)).toBe(
      true,
    )
  })

  it("finds empty and repeated names, ignoring case and spaces", () => {
    const base = draftsFromProperty(status)
    expect(findDraftProblem(base)).toBeNull()
    const empty: OptionDraft[] = [...base, { ...base[0], key: "x", id: null, name: "  " }]
    expect(findDraftProblem(empty)).toEqual({ index: 3, problem: "emptyName" })
    const repeated: OptionDraft[] = [...base, { ...base[0], key: "y", id: null, name: " todo " }]
    expect(findDraftProblem(repeated)).toEqual({ index: 3, problem: "duplicateName" })
  })

  it("gives a new option the least used color", () => {
    expect(nextOptionColor([])).not.toBe(OPTION_COLORS[0].hex)
    const used = OPTION_COLORS.slice(1).map((color) => ({ color: color.hex }))
    expect(nextOptionColor(used)).toBe(OPTION_COLORS[0].hex)
    expect(nextOptionColor([{ color: "#EF4444" }])).not.toBe("#ef4444")
  })
})
