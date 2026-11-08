import type { DatabaseSummary } from "@/lib/storage"
import * as React from "react"

import { renameDatabase } from "@/lib/storage"

import { normalizeDatabaseIcon } from "./database-icon"
import { operationErrorText, reportOperationError } from "@/lib/operation-errors"

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

  const persistDatabaseTitle = React.useCallback(
    async (next: string) => {
      if (vaultGeneration === null || !database?.manifestRevision || isDatabaseLocked) {
        onRenameTitle?.(next)
        return
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
        const notices = [...renamed.warnings]
        if (refreshFailure) {
          notices.push(operationErrorText(refreshFailure.reason))
        }
        setMutationError(notices.length ? notices.join("; ") : null)
      } catch (error) {
        setMutationError(reportOperationError(error))
        setDatabaseTitle(title)
      }
    },
    [
      database,
      databaseId,
      isDatabaseLocked,
      onCatalogChanged,
      onRenameTitle,
      retry,
      title,
      vaultGeneration,
      setMutationError,
    ],
  )

  const commitDatabaseTitle = () => {
    const next = databaseTitle.trim()
    if (next && next !== title) void persistDatabaseTitle(next)
    setEditingDatabaseTitle(false)
  }

  const displayedDatabaseIcon =
    normalizeDatabaseIcon(databaseIcon) ?? normalizeDatabaseIcon(database?.icon)

  return {
    iconTriggerRef,
    iconPickerOpen,
    setIconPickerOpen,
    displayedDatabaseIcon,
    setDatabaseIcon,
    databaseTitle,
    setDatabaseTitle,
    editingDatabaseTitle,
    setEditingDatabaseTitle,
    commitDatabaseTitle,
  }
}
