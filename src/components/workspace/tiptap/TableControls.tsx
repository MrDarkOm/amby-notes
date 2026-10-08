"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Plus,
  Trash2,
} from "lucide-react"
import type { Editor } from "@tiptap/react"
import type { EditorState, Transaction } from "@tiptap/pm/state"

import { appendToTable, editTable, tableAtSelection, type TableEdit } from "./table-commands"

interface Box {
  tablePos: number
  left: number
  top: number
  right: number
  bottom: number
}

const TOOLBAR_HEIGHT = 30
const EDGE = 16

/** Where the table the cursor is in stands on screen, or null. */
function locate(editor: Editor): Box | null {
  if (editor.isDestroyed || !editor.isEditable || !editor.isFocused) return null
  const tablePos = tableAtSelection(editor.state)
  if (tablePos === null) return null
  const dom = editor.view.nodeDOM(tablePos)
  const table = dom instanceof HTMLElement ? (dom.querySelector("table") ?? dom) : null
  if (!table) return null
  const rect = table.getBoundingClientRect()
  if (rect.width === 0 || rect.bottom < 0 || rect.top > window.innerHeight) return null
  return { tablePos, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
}

const same = (a: Box | null, b: Box | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.tablePos === b.tablePos &&
    a.left === b.left &&
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom)

/**
 * Row and column controls of the table the cursor is in: a bar above it for the row and
 * column of the current cell, and a strip on its bottom and right edge that adds a row
 * or a column at the end.
 */
export function TableControls({ editor }: { editor: Editor }) {
  const { t } = useTranslation()
  const [box, setBox] = React.useState<Box | null>(null)

  React.useEffect(() => {
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const next = locate(editor)
        setBox((prev) => (same(prev, next) ? prev : next))
      })
    }
    update()
    editor.on("transaction", update)
    editor.on("focus", update)
    editor.on("blur", update)
    window.addEventListener("scroll", update, true)
    window.addEventListener("resize", update)
    return () => {
      cancelAnimationFrame(frame)
      editor.off("transaction", update)
      editor.off("focus", update)
      editor.off("blur", update)
      window.removeEventListener("scroll", update, true)
      window.removeEventListener("resize", update)
    }
  }, [editor])

  if (!box) return null

  const apply = (command: (state: EditorState, dispatch: (tr: Transaction) => void) => boolean) => {
    if (editor.isDestroyed) return
    command(editor.state, (tr) => editor.view.dispatch(tr.setMeta("uiEvent", "table")))
    editor.view.focus()
  }
  const edit = (kind: TableEdit) => () => apply(editTable(kind))
  const append = (what: "row" | "column") => () =>
    apply((state, dispatch) => appendToTable(state, box.tablePos, what, dispatch))

  const button =
    "flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
  const strip =
    "fixed z-[40] flex items-center justify-center rounded border border-dashed border-border/80 bg-card/80 text-muted-foreground hover:border-primary hover:text-foreground"
  // The buttons take no focus: the cursor stays in its cell.
  const keepFocus = (event: React.MouseEvent) => event.preventDefault()
  const above = box.top - TOOLBAR_HEIGHT - 6

  return createPortal(
    <>
      <div
        role="toolbar"
        aria-label={t("tableControls.title")}
        data-table-controls="bar"
        className="fixed z-[40] flex items-center gap-0.5 rounded-lg border border-border bg-popover px-1 shadow-md"
        style={{
          left: Math.max(8, box.left),
          top: above >= 8 ? above : box.bottom + EDGE + 10,
          height: TOOLBAR_HEIGHT,
        }}
        onMouseDown={keepFocus}
      >
        <button
          type="button"
          className={button}
          title={t("tableControls.rowAbove")}
          onClick={edit("rowBefore")}
        >
          <BetweenHorizontalStart className="size-3.5" />
        </button>
        <button
          type="button"
          className={button}
          title={t("tableControls.rowBelow")}
          onClick={edit("rowAfter")}
        >
          <BetweenHorizontalEnd className="size-3.5" />
        </button>
        <button
          type="button"
          className={button}
          title={t("tableControls.columnLeft")}
          onClick={edit("columnBefore")}
        >
          <BetweenVerticalStart className="size-3.5" />
        </button>
        <button
          type="button"
          className={button}
          title={t("tableControls.columnRight")}
          onClick={edit("columnAfter")}
        >
          <BetweenVerticalEnd className="size-3.5" />
        </button>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <button
          type="button"
          className={button}
          title={t("tableControls.deleteRow")}
          onClick={edit("deleteRow")}
        >
          <Trash2 className="size-3" />
          {t("tableControls.row")}
        </button>
        <button
          type="button"
          className={button}
          title={t("tableControls.deleteColumn")}
          onClick={edit("deleteColumn")}
        >
          <Trash2 className="size-3" />
          {t("tableControls.column")}
        </button>
        <button
          type="button"
          className={button}
          title={t("tableControls.deleteTable")}
          onClick={edit("deleteTable")}
        >
          <Trash2 className="size-3" />
          {t("tableControls.table")}
        </button>
      </div>
      <button
        type="button"
        data-table-controls="add-row"
        className={strip}
        style={{ left: box.left, top: box.bottom + 3, width: box.right - box.left, height: EDGE }}
        title={t("tableControls.addRow")}
        onMouseDown={keepFocus}
        onClick={append("row")}
      >
        <Plus className="size-3" />
      </button>
      <button
        type="button"
        data-table-controls="add-column"
        className={strip}
        style={{ left: box.right + 3, top: box.top, width: EDGE, height: box.bottom - box.top }}
        title={t("tableControls.addColumn")}
        onMouseDown={keepFocus}
        onClick={append("column")}
      >
        <Plus className="size-3" />
      </button>
    </>,
    document.body,
  )
}
