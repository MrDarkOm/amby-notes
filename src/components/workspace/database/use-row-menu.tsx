import * as React from "react"
import { useTranslation } from "react-i18next"
import { duplicateDatabaseRow, type DatabaseRow, type DatabaseSummary } from "@/lib/storage"
import { logger } from "@/lib/logger"
import type { RowMenuModel } from "./row-menu"
import type { RowReorderConfig } from "./table-view"
import { moveRowInOrder, type RowDropPlacement } from "./row-order"

/** What the workspace lends a database for the pages it holds: favourites, windows, delete, move. */
export interface DatabaseRowActions {
  favorites: ReadonlySet<string>
  onToggleFavorite?: (noteId: string) => void
  onOpenInNewTab?: (noteId: string) => void
  onOpenInNewWindow?: (noteId: string) => void
  /** Deletes the page the way the file tree does (confirmation, trash, open tabs). */
  onDelete?: (noteId: string) => Promise<void> | void
  /** Deletes several pages at once, with one confirmation. */
  onDeleteMany?: (noteIds: string[]) => Promise<void> | void
  /** Moves the page into another database's folder. */
  onMoveToDatabase?: (noteId: string, target: DatabaseSummary) => Promise<void>
}

interface UseRowMenuOptions {
  databaseId: string
  databases: DatabaseSummary[]
  openMode: string
  /** A locked database refuses changes to its pages. */
  locked: boolean
  vaultGeneration: number | null
  actions?: DatabaseRowActions
  openRow: (row: DatabaseRow) => void
  onRenameRow?: (rowId: string, name: string) => Promise<void> | void
  /** Reloads the rows after a page was added, renamed, moved or removed. */
  refresh: () => void
  onError?: (message: string) => void
  renderProperties?: (row: DatabaseRow) => React.ReactNode
}

function fileStem(relativePath: string): string {
  const name = relativePath.replace(/\\/gu, "/").split("/").pop() ?? ""
  return name.replace(/\.md$/iu, "")
}

/** Builds the menu of a row's grip from what the host can do. */
export function useRowMenu({
  databaseId,
  databases,
  openMode,
  locked,
  vaultGeneration,
  actions,
  openRow,
  onRenameRow,
  refresh,
  onError,
  renderProperties,
}: UseRowMenuOptions): (row: DatabaseRow) => RowMenuModel {
  const { t } = useTranslation()
  const latest = React.useRef({ refresh, onError })
  latest.current = { refresh, onError }

  const fail = React.useCallback(
    (event: string, error: unknown) => {
      logger.error(event, { databaseId, error })
      latest.current.onError?.(error instanceof Error ? error.message : String(error))
    },
    [databaseId],
  )

  return React.useCallback(
    (row: DatabaseRow): RowMenuModel => ({
      isFavorite: actions?.favorites.has(row.noteId) ?? false,
      openMode,
      currentDatabaseId: databaseId,
      databases,
      onToggleFavorite: actions?.onToggleFavorite
        ? () => actions.onToggleFavorite?.(row.noteId)
        : undefined,
      onOpen: () => openRow(row),
      onOpenInNewTab: actions?.onOpenInNewTab
        ? () => actions.onOpenInNewTab?.(row.noteId)
        : undefined,
      onOpenInNewWindow: actions?.onOpenInNewWindow
        ? () => actions.onOpenInNewWindow?.(row.noteId)
        : undefined,
      onRename:
        onRenameRow && !locked
          ? async (name) => {
              await onRenameRow(row.noteId, name)
              latest.current.refresh()
            }
          : undefined,
      onCopyLink: () => {
        const stem = fileStem(row.relativePath) || row.title
        void navigator.clipboard?.writeText(`[[${stem}]]`).catch(() => undefined)
      },
      onDuplicate:
        locked || vaultGeneration === null
          ? undefined
          : async () => {
              try {
                const copy = await duplicateDatabaseRow({
                  expectedGeneration: vaultGeneration,
                  databaseId,
                  noteId: row.noteId,
                  title: t("databaseRowMenu.duplicateTitle", { name: row.title }),
                })
                logger.info("database.duplicate_row", { databaseId, rowId: copy.noteId })
                latest.current.refresh()
              } catch (error) {
                fail("database.duplicate_row_failed", error)
              }
            },
      onMoveTo:
        locked || !actions?.onMoveToDatabase
          ? undefined
          : async (targetId) => {
              const target = databases.find((database) => database.databaseId === targetId)
              if (!target) return
              try {
                await actions.onMoveToDatabase?.(row.noteId, target)
                latest.current.refresh()
              } catch (error) {
                fail("database.move_row_failed", error)
              }
            },
      onDelete:
        locked || !actions?.onDelete
          ? undefined
          : async () => {
              try {
                await actions.onDelete?.(row.noteId)
                latest.current.refresh()
              } catch (error) {
                fail("database.delete_row_failed", error)
              }
            },
      renderProperties: renderProperties ? () => renderProperties(row) : undefined,
    }),
    [
      actions,
      databaseId,
      databases,
      fail,
      locked,
      onRenameRow,
      openMode,
      openRow,
      renderProperties,
      t,
      vaultGeneration,
    ],
  )
}

interface UseRowReorderConfigOptions {
  /** The rows as shown, in order. */
  rows: DatabaseRow[]
  manualOrder: string[]
  /** False while a sort decides the order, or the database is locked. */
  enabled: boolean
  onChange: (manualOrder: string[]) => void
  /** A drag was tried while `enabled` is false because of a sort. */
  onBlockedDrag?: () => void
}

/** Turns a drop (or an arrow key on the grip) into the view's new manual order. */
export function useRowReorderConfig({
  rows,
  manualOrder,
  enabled,
  onChange,
  onBlockedDrag,
}: UseRowReorderConfigOptions): RowReorderConfig {
  const latest = React.useRef({ rows, manualOrder, onChange })
  latest.current = { rows, manualOrder, onChange }

  const onReorder = React.useCallback(
    (rowId: string, overId: string, placement: RowDropPlacement) => {
      const { rows: shown, manualOrder: order, onChange: save } = latest.current
      const next = moveRowInOrder(
        order,
        shown.map((row) => row.noteId),
        rowId,
        overId,
        placement,
      )
      if (next) save(next)
    },
    [],
  )
  const onNudge = React.useCallback(
    (rowId: string, offset: -1 | 1) => {
      const shown = latest.current.rows
      const index = shown.findIndex((row) => row.noteId === rowId)
      const neighbour = shown[index + offset]
      if (index === -1 || !neighbour) return
      onReorder(rowId, neighbour.noteId, offset < 0 ? "before" : "after")
    },
    [onReorder],
  )
  return React.useMemo(
    () => ({ enabled, onReorder, onNudge, onBlockedDrag }),
    [enabled, onBlockedDrag, onNudge, onReorder],
  )
}

/** Deletes the ticked rows; `undefined` when the workspace offers no delete or the database is locked. */
export function useDeleteRows({
  actions,
  locked,
  refresh,
}: {
  actions?: DatabaseRowActions
  locked: boolean
  refresh: () => void
}): ((noteIds: string[]) => Promise<void>) | undefined {
  const onDeleteMany = actions?.onDeleteMany
  return React.useMemo(
    () =>
      locked || !onDeleteMany
        ? undefined
        : async (noteIds: string[]) => {
            await onDeleteMany(noteIds)
            refresh()
          },
    [locked, onDeleteMany, refresh],
  )
}
