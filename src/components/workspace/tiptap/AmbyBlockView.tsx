import * as React from "react"
import { useTranslation } from "react-i18next"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { Database, Plus, X } from "lucide-react"

import { loadVaultJSON, saveVaultJSON } from "@/lib/storage"

/** On-disk shape of a `db` block's sidecar (`.amby/blocks/<id>.json`). */
interface DbData {
  columns: string[]
  rows: string[][]
}

import i18n from "@/lib/i18n"

const DEFAULT_DATA: DbData = {
  columns: [i18n.t("dbBlock.defaultColumn", { n: 1 }), i18n.t("dbBlock.defaultColumn", { n: 2 })],
  rows: [["", ""]],
}

const blockPath = (id: string) => `blocks/${id}.json`

/** Make sure rows are rectangular against the column count. */
function normalize(d: Partial<DbData> | null): DbData {
  const columns =
    Array.isArray(d?.columns) && d!.columns.length ? d!.columns.map(String) : DEFAULT_DATA.columns
  const rawRows = Array.isArray(d?.rows) ? d!.rows : []
  const rows = (rawRows.length ? rawRows : DEFAULT_DATA.rows).map((row) => {
    const r = Array.isArray(row) ? row.map(String) : []
    while (r.length < columns.length) r.push("")
    return r.slice(0, columns.length)
  })
  return { columns, rows }
}

export function AmbyBlockView({ node, editor }: NodeViewProps) {
  const { t } = useTranslation()
  const blockId = node.attrs.blockId as string
  const editable = editor.isEditable
  const [data, setData] = React.useState<DbData | null>(null)
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    let cancelled = false
    if (!blockId) {
      setData(DEFAULT_DATA)
      return
    }
    loadVaultJSON<Partial<DbData>>(blockPath(blockId), {}).then((d) => {
      if (!cancelled) setData(normalize(d))
    })
    return () => {
      cancelled = true
    }
  }, [blockId])

  React.useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  const persist = React.useCallback(
    (next: DbData) => {
      setData(next)
      if (!blockId) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        void saveVaultJSON(blockPath(blockId), next)
      }, 400)
    },
    [blockId],
  )

  const setCell = (r: number, c: number, value: string) => {
    if (!data) return
    const rows = data.rows.map((row, ri) =>
      ri === r ? row.map((cell, ci) => (ci === c ? value : cell)) : row,
    )
    persist({ ...data, rows })
  }

  const setColumn = (c: number, value: string) => {
    if (!data) return
    persist({ ...data, columns: data.columns.map((col, ci) => (ci === c ? value : col)) })
  }

  const addRow = () => {
    if (!data) return
    persist({ ...data, rows: [...data.rows, data.columns.map(() => "")] })
  }

  const addColumn = () => {
    if (!data) return
    persist({
      columns: [...data.columns, t("dbBlock.defaultColumn", { n: data.columns.length + 1 })],
      rows: data.rows.map((row) => [...row, ""]),
    })
  }

  const removeRow = (r: number) => {
    if (!data) return
    persist({ ...data, rows: data.rows.filter((_, ri) => ri !== r) })
  }

  const removeColumn = (c: number) => {
    if (!data || data.columns.length <= 1) return
    persist({
      columns: data.columns.filter((_, ci) => ci !== c),
      rows: data.rows.map((row) => row.filter((_, ci) => ci !== c)),
    })
  }

  return (
    <NodeViewWrapper
      className="amby-db-block my-2 rounded-lg border border-border bg-card"
      data-block-type={node.attrs.blockType}
    >
      <div contentEditable={false} onKeyDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
          <Database className="size-3.5" />
          {t("dbBlock.database")}
        </div>

        {data === null ? (
          <div className="px-3 py-4 text-[13px] text-muted-foreground">{t("dbBlock.loading")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px] text-foreground">
              <thead>
                <tr>
                  {data.columns.map((col, c) => (
                    <th key={c} className="border-b border-border p-0 text-left font-medium">
                      <div className="group flex items-center">
                        <input
                          value={col}
                          disabled={!editable}
                          onChange={(e) => setColumn(c, e.target.value)}
                          className="w-full bg-transparent px-2 py-1.5 text-foreground outline-none placeholder:text-muted-foreground"
                          placeholder={t("dbBlock.columnPlaceholder")}
                        />
                        {editable && data.columns.length > 1 && (
                          <button
                            type="button"
                            title={t("dbBlock.deleteColumn")}
                            onClick={() => removeColumn(c)}
                            className="invisible mr-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground group-hover:visible"
                          >
                            <X className="size-3" />
                          </button>
                        )}
                      </div>
                    </th>
                  ))}
                  <th className="w-8 border-b border-border">
                    {editable && (
                      <button
                        type="button"
                        title={t("dbBlock.addColumn")}
                        onClick={addColumn}
                        className="flex size-7 items-center justify-center text-muted-foreground hover:text-foreground"
                      >
                        <Plus className="size-3.5" />
                      </button>
                    )}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, r) => (
                  <tr key={r} className="group/row">
                    {row.map((cell, c) => (
                      <td key={c} className="border-b border-border p-0 align-top">
                        <input
                          value={cell}
                          disabled={!editable}
                          onChange={(e) => setCell(r, c, e.target.value)}
                          className="w-full bg-transparent px-2 py-1.5 outline-none"
                        />
                      </td>
                    ))}
                    <td className="border-b border-border text-center align-middle">
                      {editable && (
                        <button
                          type="button"
                          title={t("dbBlock.deleteRow")}
                          onClick={() => removeRow(r)}
                          className="invisible rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground group-hover/row:visible"
                        >
                          <X className="size-3" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {editable && (
              <button
                type="button"
                onClick={addRow}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-card hover:text-foreground"
              >
                <Plus className="size-3.5" />
                {t("dbBlock.addRow")}
              </button>
            )}
          </div>
        )}
      </div>
    </NodeViewWrapper>
  )
}
