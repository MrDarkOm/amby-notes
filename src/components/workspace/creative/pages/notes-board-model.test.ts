import { describe, expect, it } from "vitest"
import type { DatabaseRow, Notebook } from "@/lib/storage"
import {
  buildNoteTabs,
  newestNotesFirst,
  notebookForNewNote,
  notebookLabel,
  notesInTab,
} from "./notes-board-model"

const note = (noteId: string, title: string, categoryPath: string[] = []): DatabaseRow => ({
  noteId,
  title,
  relativePath: `${noteId}.md`,
  parentNoteId: null,
  depth: 0,
  categoryPath,
  valuesJson: "{}",
  rowRevision: "r",
})
const notebook = (...segments: string[]): Notebook => ({
  segments,
  path: segments.join("/"),
  itemCount: 0,
})

describe("notes board tabs", () => {
  const rows = [
    note("1", "Идея", ["Идеи"]),
    note("2", "Сюжет", ["Идеи", "Сюжеты"]),
    note("3", "Факты", ["Исследования"]),
    note("4", "Без папки"),
  ]
  const tabs = buildNoteTabs(rows, [
    notebook("Идеи"),
    notebook("Идеи", "Сюжеты"),
    notebook("Пустой"),
  ])

  it("lists All, each top-level notebook (empty ones too) and the notes in none", () => {
    expect(tabs.map((tab) => [tab.kind, tab.name, tab.count])).toEqual([
      ["all", null, 4],
      ["notebook", "Идеи", 2],
      ["notebook", "Исследования", 1],
      ["notebook", "Пустой", 0],
      ["none", null, 1],
    ])
  })

  it("still lists a notebook a note names that the listing missed, and hides an empty 'none'", () => {
    const only = buildNoteTabs([note("1", "A", ["Забытый"])], [])
    expect(only.map((tab) => tab.name)).toEqual([null, "Забытый"])
  })

  it("shows the notes of a tab, nested notebooks included", () => {
    expect(notesInTab(rows, tabs[0]).map((r) => r.noteId)).toEqual(["1", "2", "3", "4"])
    expect(notesInTab(rows, tabs[1]).map((r) => r.noteId)).toEqual(["1", "2"])
    expect(notesInTab(rows, tabs[4]).map((r) => r.noteId)).toEqual(["4"])
  })

  it("makes a new note in the notebook of the tab, or in the root", () => {
    expect(notebookForNewNote(tabs[1])).toEqual(["Идеи"])
    expect(notebookForNewNote(tabs[0])).toBeUndefined()
    expect(notebookForNewNote(tabs[4])).toBeUndefined()
  })

  it("names a note's notebook and orders by the latest change", () => {
    expect(notebookLabel(rows[1])).toBe("Идеи › Сюжеты")
    expect(notebookLabel(rows[3])).toBeNull()
    const times: Record<string, number> = { "1": 5, "3": 9 }
    expect(newestNotesFirst(rows, (id) => times[id]).map((r) => r.noteId)).toEqual([
      "3",
      "1",
      "4",
      "2",
    ])
  })
})
