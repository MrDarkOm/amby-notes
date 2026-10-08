import { describe, expect, it } from "vitest"
import { EditorState, TextSelection } from "@tiptap/pm/state"

import { docToMarkdown, editorSchema, markdownToDoc, roundTripCheck } from "./markdown"
import { appendToTable, editTable, tableAtSelection, type TableEdit } from "./table-commands"

const TABLE = [
  "| Name | Age | City |",
  "| :--- | ---: | :-: |",
  "| Ann | 30 | Oslo |",
  "| Bob | 41 | Rome |",
].join("\n")

/** The state with the cursor in the cell that holds `text`. */
function inCell(markdown: string, text: string): EditorState {
  const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
  let at = -1
  doc.descendants((node, pos) => {
    if (node.isText && node.text === text) at = pos
  })
  expect(at, `cell "${text}"`).toBeGreaterThan(-1)
  const base = EditorState.create({ schema: editorSchema, doc })
  return base.apply(base.tr.setSelection(TextSelection.create(doc, at)))
}

function run(state: EditorState, edit: TableEdit): EditorState {
  let next = state
  expect(editTable(edit)(state, (tr) => (next = state.apply(tr)))).toBe(true)
  return next
}

// A rebuilt table ends with a line break; the editor boundary restores the file's own ending.
const written = (state: EditorState) => docToMarkdown(state.doc).trimEnd()
const sound = (state: EditorState) => expect(roundTripCheck(written(state)).ok).toBe(true)

describe("rows and columns of a Markdown table", () => {
  it("does nothing outside a table", () => {
    const state = EditorState.create({
      schema: editorSchema,
      doc: editorSchema.nodeFromJSON(markdownToDoc("Text")),
    })
    expect(editTable("rowAfter")(state)).toBe(false)
    expect(tableAtSelection(state)).toBeNull()
  })

  it("adds a row above and below the cursor", () => {
    const below = run(inCell(TABLE, "Ann"), "rowAfter")
    expect(written(below)).toBe(
      [
        "| Name | Age | City |",
        "| :--- | ---: | :---: |",
        "| Ann | 30 | Oslo |",
        "|   |   |   |",
        "| Bob | 41 | Rome |",
      ].join("\n"),
    )
    sound(below)
    const above = run(inCell(TABLE, "Ann"), "rowBefore")
    expect(written(above).split("\n")[2]).toBe("|   |   |   |")
    sound(above)
  })

  it("keeps one header row when a row is added above the header", () => {
    const state = run(inCell(TABLE, "Name"), "rowBefore")
    const table = state.doc.firstChild!
    expect(table.child(0).firstChild?.type.name).toBe("tableHeader")
    expect(table.child(1).firstChild?.type.name).toBe("tableCell")
    expect(written(state).split("\n").slice(0, 3)).toEqual([
      "|   |   |   |",
      "| :--- | ---: | :---: |",
      "| Name | Age | City |",
    ])
    sound(state)
  })

  it("makes the next row the header when the header row is deleted", () => {
    const state = run(inCell(TABLE, "Age"), "deleteRow")
    expect(written(state)).toBe(
      ["| Ann | 30 | Oslo |", "| :--- | ---: | :---: |", "| Bob | 41 | Rome |"].join("\n"),
    )
    expect(state.doc.firstChild!.child(0).firstChild?.type.name).toBe("tableHeader")
    sound(state)
  })

  it("adds a column and keeps the alignment of the others", () => {
    const right = run(inCell(TABLE, "30"), "columnAfter")
    expect(written(right).split("\n").slice(0, 2)).toEqual([
      "| Name | Age |   | City |",
      "| :--- | ---: | --- | :---: |",
    ])
    sound(right)
    const left = run(inCell(TABLE, "Name"), "columnBefore")
    expect(written(left).split("\n")[1]).toBe("| --- | :--- | ---: | :---: |")
    sound(left)
  })

  it("deletes a column together with its alignment", () => {
    const state = run(inCell(TABLE, "41"), "deleteColumn")
    expect(written(state)).toBe(
      ["| Name | City |", "| :--- | :---: |", "| Ann | Oslo |", "| Bob | Rome |"].join("\n"),
    )
    sound(state)
  })

  it("removes the table with its last row or column, leaving a line to write on", () => {
    const one = "| Only |\n| --- |"
    for (const edit of ["deleteRow", "deleteColumn", "deleteTable"] as const) {
      const state = run(inCell(one, "Only"), edit)
      expect(state.doc.childCount, edit).toBe(1)
      expect(state.doc.firstChild?.type.name, edit).toBe("paragraph")
    }
  })

  it("leaves the text around a deleted table", () => {
    const state = run(inCell(`Before\n\n${TABLE}\n\nAfter`, "Rome"), "deleteTable")
    expect(written(state)).toBe("Before\n\nAfter")
  })

  it("appends a row and a column from the edges of the table", () => {
    const state = inCell(`Intro\n\n${TABLE}`, "Intro")
    const tablePos = state.doc.firstChild!.nodeSize
    let rows = state
    expect(appendToTable(state, tablePos, "row", (tr) => (rows = state.apply(tr)))).toBe(true)
    expect(written(rows).split("\n").pop()).toBe("|   |   |   |")
    expect(tableAtSelection(rows)).toBe(tablePos)
    sound(rows)

    let columns = state
    appendToTable(state, tablePos, "column", (tr) => (columns = state.apply(tr)))
    expect(written(columns).split("\n").slice(2, 4)).toEqual([
      "| Name | Age | City |   |",
      "| :--- | ---: | :---: | --- |",
    ])
    sound(columns)
    expect(appendToTable(state, 0, "row")).toBe(false)
  })

  it("leaves a table that was not touched as it was written", () => {
    const odd = "|Name|Age|\n|:-|-:|\n|Ann|30|"
    const state = inCell(`${odd}\n\nText`, "Text")
    expect(written(state)).toBe(`${odd}\n\nText`)
  })

  it("puts the cursor in the new row or column", () => {
    const row = run(inCell(TABLE, "Bob"), "rowAfter")
    expect(row.selection.$from.parent.textContent).toBe("")
    expect(tableAtSelection(row)).toBe(0)
    const column = run(inCell(TABLE, "Bob"), "columnAfter")
    expect(column.selection.$from.parent.textContent).toBe("")
  })
})
