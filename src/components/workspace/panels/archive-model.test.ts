import { describe, expect, it } from "vitest"
import type { TrashEntry } from "@/lib/storage"
import { archiveEntryLabel, groupArchiveEntries } from "./archive-model"

const entry = (
  id: string,
  date: Date,
  name = "Заметка.md",
  originalPath = "Мир/Заметка.md",
): TrashEntry => ({ id, deletedAtMs: date.getTime(), name, originalPath })

describe("archive presentation", () => {
  it("sorts newest first in local calendar groups without changing the catalog", () => {
    const now = new Date(2026, 9, 29, 12)
    const entries = [
      entry("old", new Date(2025, 9, 29)),
      entry("morning", new Date(2026, 9, 29, 1)),
      entry("yesterday", new Date(2026, 9, 28, 23, 59)),
      entry("noon", now),
    ]
    const groups = groupArchiveEntries(entries, now)
    expect(groups.map((group) => [group.key, group.entries.map((item) => item.id)])).toEqual([
      ["today", ["noon", "morning"]],
      ["yesterday", ["yesterday"]],
      ["earlier", ["old"]],
    ])
    expect(entries.map((item) => item.id)).toEqual(["old", "morning", "yesterday", "noon"])
  })

  it("uses calendar yesterday across month and year boundaries", () => {
    const groups = groupArchiveEntries(
      [entry("last-year", new Date(2025, 11, 31, 0, 1))],
      new Date(2026, 0, 1, 23),
    )
    expect(groups[0].key).toBe("yesterday")
  })

  it("keeps separate archive entries with the same name", () => {
    const now = new Date(2026, 9, 29)
    expect(
      groupArchiveEntries([entry("one", now), entry("two", now)], now)[0].entries,
    ).toHaveLength(2)
  })

  it("strips only known display extensions while preserving original storage names", () => {
    const note = entry("note", new Date(), "Черновик.MD", "Мир\\Черновик.MD")
    expect(archiveEntryLabel(note)).toEqual({ title: "Черновик", parent: "Мир", icon: "file" })
    expect(note.name).toBe("Черновик.MD")
    expect(archiveEntryLabel({ ...note, name: "Схема.canvas" }).icon).toBe("canvas")
    expect(archiveEntryLabel({ ...note, name: "Рисунок.excalidraw" }).icon).toBe("sketch")
    expect(archiveEntryLabel({ ...note, name: "Папка.v2", originalPath: "Папка.v2" })).toEqual({
      title: "Папка.v2",
      parent: "",
      icon: null,
    })
  })
})
