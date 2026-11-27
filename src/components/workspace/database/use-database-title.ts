import type { DatabaseSummary } from "@/lib/storage"
import * as React from "react"

import { renameDatabase } from "@/lib/storage"

import { normalizeDatabaseIcon } from "./database-icon"
import { operationErrorText, reportOperationError, warningNotices } from "@/lib/operation-errors"

interface UseDatabaseTitleParams {
  title: string
  icon: string | null | undefined
  vaultGeneration: number | null
  database: DatabaseSummary | undefined
  isDatabaseLocked: boolean
  onRenameTitle: ((newName: string) => void) | undefined
  databaseId: string
  onCatalogChanged: (() => Promise<void>) | undefined
  retry: () => Promise<void>
  setMutationError: React.Dispatch<React.SetStateAction<string | null>>
}

export function useDatabaseTitle({
  title,
  icon,
  vaultGeneration,
  database,
  isDatabaseLocked,
  onRenameTitle,
  databaseId,
  onCatalogChanged,
  retry,
  setMutationError,
}: UseDatabaseTitleParams) {
  const [databaseTitle, setDatabaseTitle] = React.useState(title)
  const [editingDatabaseTitle, setEditingDatabaseTitle] = React.useState(false)
  const [databaseIcon, setDatabaseIcon] = React.useState(() => normalizeDatabaseIcon(icon) ?? "")
  const [iconPickerOpen, setIconPickerOpen] = React.useState(false)
  const iconTriggerRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => setDatabaseTitle(title), [title])
  React.useEffect(() => setDatabaseIcon(normalizeDatabaseIcon(icon) ?? ""), [icon])

  // A refused name keeps the field open, with the name as typed and the reason under it
  // (docs/notices.md, section 8).
  const [titleRefusal, setTitleRefusal] = React.useState<{ name: string; text: string } | null>(
    null,
  )
  const renamingRef = React.useRef(false)
  // The name just taken: leaving the field after Enter must not hand it over a second time.
  const settledRef = React.useRef<string | null>(null)

  /** `true` when the name was taken (or there was nothing to do), `false` when it was refused. */
  const persistDatabaseTitle = React.useCallback(
    async (next: string): Promise<boolean> => {
      if (vaultGeneration === null || !database?.manifestRevision || isDatabaseLocked) {
        onRenameTitle?.(next)
        return true
      }
      try {
        const renamed = await renameDatabase({
          expectedGeneration: vaultGeneration,
          databaseId,
          expectedManifestRevision: database.manifestRevision,
          name: next,
        })
        onRenameTitle?.(renamed.title)
        const refreshResults = await Promise.allSettled([onCatalogChanged?.(), retry()])
        const refreshFailure = refreshResults.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        )
        const notices = warningNotices(renamed.warnings)
        if (refreshFailure) {
          notices.push(operationErrorText(refreshFailure.reason))
        }
        setMutationError(notices.length ? notices.join("; ") : null)
        return true
      } catch (error) {
        setTitleRefusal({ name: next, text: reportOperationError(error) })
        return false
      }
    },
    [
      database,
      databaseId,
      isDatabaseLocked,
      onCatalogChanged,
      onRenameTitle,
      retry,
      vaultGeneration,
      setMutationError,
    ],
  )

  const cancelDatabaseTitle = () => {
    setDatabaseTitle(title)
    setTitleRefusal(null)
    setEditingDatabaseTitle(false)
  }

  const commitDatabaseTitle = () => {
    const next = databaseTitle.trim()
    if (renamingRef.current) return
    if (next && next === settledRef.current) {
      setEditingDatabaseTitle(false)
      return
    }
    // Leaving the field with the refused name still in it gives up, instead of asking again.
    if (!next || next === title || next === titleRefusal?.name) {
      cancelDatabaseTitle()
      return
    }
    renamingRef.current = true
    void persistDatabaseTitle(next)
      .then((taken) => {
        if (!taken) return
        setTitleRefusal(null)
        settledRef.current = next
        setEditingDatabaseTitle(false)
      })
      .finally(() => {
        renamingRef.current = false
      })
  }

  const changeDatabaseTitle = (value: string) => {
    settledRef.current = null
    setDatabaseTitle(value)
  }

  const titleHint =
    titleRefusal && databaseTitle.trim() === titleRefusal.name ? titleRefusal.text : null

  const displayedDatabaseIcon =
    normalizeDatabaseIcon(databaseIcon) ?? normalizeDatabaseIcon(database?.icon)

  return {
    iconTriggerRef,
    iconPickerOpen,
    setIconPickerOpen,
    displayedDatabaseIcon,
    setDatabaseIcon,
    databaseTitle,
    setDatabaseTitle: changeDatabaseTitle,
    editingDatabaseTitle,
    setEditingDatabaseTitle,
    commitDatabaseTitle,
    cancelDatabaseTitle,
    titleHint,
  }
}
