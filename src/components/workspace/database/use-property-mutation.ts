import * as React from "react"
import {
  applyDatabaseValueBatch,
  createDatabaseRow,
  updateDatabaseRelationValue,
  type DatabasePropertySummary,
} from "@/lib/storage"
import { logger } from "@/lib/logger"

/**
 * One write path for a property value, shared by the table, the info panel and
 * any other editor. Writes to one row are serialized across all editors, the
 * latest returned revision is reused for the next write, every action owns one
 * operation ID, and Relation always goes through the Relation command so the
 * inverse side and rollups stay consistent.
 */

const rowQueues = new Map<string, Promise<void>>()
const revisionOverrides = new Map<string, string>()

function rowKey(vaultGeneration: number, noteId: string): string {
  return `${vaultGeneration}:${noteId}`
}

export function createDatabaseOperationId(prefix: string, suffix?: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`
  }
  const random = Math.random().toString(36).slice(2)
  const safeSuffix = suffix?.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64)
  return `${prefix}-${Date.now()}${safeSuffix ? `-${safeSuffix}` : ""}-${random}`
}

export function cellKey(noteId: string, propertyId: string): string {
  return `${noteId}:${propertyId}`
}

export interface PropertyMutationRow {
  noteId: string
  /** Revision of the row as last read by the caller; a newer write wins. */
  rowRevision: string
}

export interface PropertyMutationResult {
  /** Revision of the row after the write, when the backend reported one. */
  revision: string | null
  warnings: string[]
}

export interface UsePropertyMutationOptions {
  databaseId: string
  vaultGeneration: number | null
  /** After every attempt, successful or not, so the owner can reload its rows. */
  onSettled?: (outcome: { ok: boolean; result?: PropertyMutationResult }) => void | Promise<void>
}

export interface PropertyMutation {
  commit: (
    row: PropertyMutationRow,
    property: DatabasePropertySummary,
    valueJson?: string,
  ) => Promise<void>
  pendingCells: Set<string>
  cellErrors: Record<string, string>
}

function relationTargets(valueJson: string | undefined): string[] {
  if (!valueJson) return []
  try {
    const parsed = JSON.parse(valueJson) as { targetNoteIds?: unknown }
    return Array.isArray(parsed.targetNoteIds)
      ? parsed.targetNoteIds.filter((id): id is string => typeof id === "string")
      : []
  } catch {
    return []
  }
}

export function usePropertyMutation({
  databaseId,
  vaultGeneration,
  onSettled,
}: UsePropertyMutationOptions): PropertyMutation {
  const [pendingCells, setPendingCells] = React.useState<Set<string>>(new Set())
  const [cellErrors, setCellErrors] = React.useState<Record<string, string>>({})
  const onSettledRef = React.useRef(onSettled)
  onSettledRef.current = onSettled

  const commit = React.useCallback(
    (row: PropertyMutationRow, property: DatabasePropertySummary, valueJson?: string) => {
      if (vaultGeneration === null) return Promise.resolve()
      const generation = vaultGeneration
      const key = cellKey(row.noteId, property.propertyId)
      const queueKey = rowKey(generation, row.noteId)
      const prior = rowQueues.get(queueKey) ?? Promise.resolve()
      logger.info("database.commit_cell", {
        databaseId,
        noteId: row.noteId,
        propertyId: property.propertyId,
        propertyName: property.name,
        propertyType: property.propertyType,
      })
      setPendingCells((current) => new Set(current).add(key))
      setCellErrors((current) => {
        if (!(key in current)) return current
        const next = { ...current }
        delete next[key]
        return next
      })
      const operationId = createDatabaseOperationId("cell", `${row.noteId}-${property.propertyId}`)
      const task: Promise<void> = prior
        .catch(() => {})
        .then(async () => {
          const expectedRevision = revisionOverrides.get(queueKey) ?? row.rowRevision
          let result: PropertyMutationResult
          if (property.propertyType === "relation") {
            const written = await updateDatabaseRelationValue({
              expectedGeneration: generation,
              operationId,
              databaseId,
              noteId: row.noteId,
              propertyId: property.propertyId,
              targetNoteIds: relationTargets(valueJson),
              expectedRevision,
            })
            result = {
              revision:
                written.revisions.find((item) => item.noteId === row.noteId)?.revision ?? null,
              warnings: written.warnings,
            }
          } else {
            const written = await applyDatabaseValueBatch({
              expectedGeneration: generation,
              databaseId,
              operationId,
              cells: [
                {
                  noteId: row.noteId,
                  propertyId: property.propertyId,
                  valueJson,
                  expectedRevision,
                },
              ],
            })
            result = {
              revision:
                written.revisions.find((item) => item.noteId === row.noteId)?.revision ?? null,
              warnings: written.warnings,
            }
          }
          if (result.revision) revisionOverrides.set(queueKey, result.revision)
          await onSettledRef.current?.({ ok: true, result })
        })
        .catch(async (error) => {
          logger.error("database.commit_cell_failed", {
            databaseId,
            noteId: row.noteId,
            propertyId: property.propertyId,
            error,
          })
          // The revision is unknown after a failure; the next write re-reads the row's.
          revisionOverrides.delete(queueKey)
          setCellErrors((current) => ({
            ...current,
            [key]: error instanceof Error ? error.message : String(error),
          }))
          await onSettledRef.current?.({ ok: false })
        })
        .finally(() => {
          setPendingCells((current) => {
            const next = new Set(current)
            next.delete(key)
            return next
          })
          if (rowQueues.get(queueKey) === task) rowQueues.delete(queueKey)
        })
      rowQueues.set(queueKey, task)
      return task
    },
    [databaseId, vaultGeneration],
  )

  return { commit, pendingCells, cellErrors }
}

/** Creates the page a Relation picker offered ("Create «title»") in the target database. */
export async function createRelationTargetRow(
  vaultGeneration: number,
  targetDatabaseId: string,
  title: string,
): Promise<string> {
  const trimmed = title.trim()
  const created = await createDatabaseRow({
    expectedGeneration: vaultGeneration,
    databaseId: targetDatabaseId,
    title: trimmed,
    template: { kind: "empty" },
  })
  logger.info("database.create_relation_row", {
    targetDatabaseId,
    noteId: created.noteId,
    title: trimmed,
  })
  return created.noteId
}

/** Test hook: forget queued writes and cached revisions. */
export function _resetPropertyMutationForTesting(): void {
  rowQueues.clear()
  revisionOverrides.clear()
}
