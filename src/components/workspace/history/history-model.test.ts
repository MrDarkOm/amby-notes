import { describe, expect, it } from "vitest"
import {
  compactHistoryDiff,
  diffHistory,
  formatHistorySize,
  groupHistoryByDay,
  historyReasonKey,
} from "./history-model"

function reconstruct(previous: string, current: string) {
  const diff = diffHistory(previous, current)
  expect(
    diff.lines
      .filter((line) => line.kind !== "added")
      .map((line) => line.text)
      .join(""),
  ).toBe(previous)
  expect(
    diff.lines
      .filter((line) => line.kind !== "removed")
      .map((line) => line.text)
      .join(""),
  ).toBe(current)
  expect(diff.identical).toBe(previous === current)
  return diff
}

describe("history comparison", () => {
  it("highlights replacements and preserves unchanged context and line numbers", () => {
    const diff = reconstruct("first\nold\nlast\n", "first\nnew\nlast\n")
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(diff.lines.map((line) => line.kind)).toEqual(["same", "removed", "added", "same"])
    expect(diff.lines[diff.lines.length - 1]).toMatchObject({ previousLine: 3, currentLine: 3 })
  })
  it.each([
    ["", ""],
    ["", "text\n"],
    ["text\n", ""],
    ["a\n", "a"],
    ["\uFEFF---\r\nid: old\r\n---\r\n", "\uFEFF---\r\nid: new\r\n---\r\n"],
    ["\n\n", "\r\n\n"],
    ["same\n", "same\n"],
    ["a\nb\na\nc\n", "a\na\nb\nc\n"],
  ])("retains every byte in both versions", (previous, current) => {
    reconstruct(previous, current)
  })
  it("bounds large comparisons without losing source text", () => {
    const diff = reconstruct(
      "prefix\n" + "old\n".repeat(1100) + "end",
      "prefix\n" + "new\n".repeat(1100) + "end",
    )
    expect(diff.simplified).toBe(true)
    expect(diff.added).toBe(1100)
    expect(diff.removed).toBe(1100)
  })
  it("compacts unchanged stretches while keeping the changes visible", () => {
    const previous = "same\n".repeat(50) + "old\n" + "same\n".repeat(50)
    const current = previous.replace("old", "new")
    const rows = compactHistoryDiff(diffHistory(previous, current).lines)
    expect(rows).toHaveLength(16)
    expect(rows.filter((row) => row.kind === "gap")).toEqual([
      { kind: "gap", count: 44 },
      { kind: "gap", count: 44 },
    ])
    expect(rows.filter((row) => row.kind === "added" || row.kind === "removed")).toHaveLength(2)
  })
  it("preserves a deterministic corpus with repeated lines", () => {
    for (let sample = 0; sample < 60; sample++) {
      const source = Array.from({ length: sample }, (_, i) => `${(i * 7) % 11}\n`)
      const next = source.filter((_, i) => (i + sample) % 5 !== 0)
      next.splice(sample % (next.length + 1), 0, "inserted\r\n")
      reconstruct(source.join(""), next.join(""))
    }
  })
})

describe("history presentation", () => {
  it("groups descending versions by local calendar day without changing their order in storage", () => {
    const entries = [1, 3, 2].map((day) => ({
      id: `${day}`,
      createdAtMs: new Date(2026, 7, day, 23).getTime(),
      reason: "note-save",
      sizeBytes: 100,
    }))
    const groups = groupHistoryByDay(entries)
    expect(groups.map((group) => group.entries[0].id)).toEqual(["3", "2", "1"])
    expect(entries.map((entry) => entry.id)).toEqual(["1", "3", "2"])
  })
  it("uses readable event labels and accurate zero/large sizes", () => {
    expect(historyReasonKey("note-save")).toBe("historyPanel.autosave")
    expect(historyReasonKey("unrecognized")).toBe("historyPanel.savedVersion")
    expect(formatHistorySize(0, "en")).toBe("0 byte")
    expect(formatHistorySize(1048576, "en")).toBe("1 MB")
  })
})
