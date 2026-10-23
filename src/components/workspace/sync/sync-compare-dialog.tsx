import * as React from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { errorType, logger } from "@/lib/logger"
import { readFile } from "@/lib/storage"
import { syncErrorMessage } from "@/lib/sync/sync-errors"
import type { ConflictChoice, SyncPort } from "@/lib/sync/sync-port"
import { absoluteVaultPath, type SyncConflict } from "./use-sync-notices-store"

type Loaded = { original: string; copy: string }

/**
 * The two versions of a conflict side by side, with the same three ways out as the list (Р7). The
 * window of the external changes of the editor is tied to an open, edited buffer and writes
 * through it, so it does not fit here: this one only reads the two files and uses the command that
 * resolves a conflict, which keeps the snapshots of the history and the trash as before.
 */
export function SyncCompareDialog({
  port,
  conflict,
  vault,
  onClose,
}: {
  port: SyncPort
  conflict: SyncConflict
  vault: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [loaded, setLoaded] = React.useState<Loaded | null>(null)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let alive = true
    setLoaded(null)
    setLoadFailed(false)
    Promise.all([
      readFile(absoluteVaultPath(vault, conflict.originalPath)),
      readFile(absoluteVaultPath(vault, conflict.copyPath)),
    ])
      .then(([original, copy]) => alive && setLoaded({ original, copy }))
      .catch((caught) => {
        logger.warn("sync.compare_read_failed", { errorType: errorType(caught) })
        if (alive) setLoadFailed(true)
      })
    return () => {
      alive = false
    }
  }, [vault, conflict.originalPath, conflict.copyPath])

  const resolve = async (choice: ConflictChoice) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await port.resolveConflict(conflict.id, choice)
      onClose()
    } catch (caught) {
      setError(syncErrorMessage(caught, t))
      setBusy(false)
    }
  }

  const pane = (title: string, path: string, text: string | undefined) => (
    <section className="flex min-w-0 flex-col rounded-md border">
      <h3 className="border-b px-3 py-2 text-sm font-medium">{title}</h3>
      <p className="break-all border-b px-3 py-1 text-[11px] text-muted-foreground">{path}</p>
      <pre className="max-h-72 min-h-24 flex-1 overflow-auto whitespace-pre-wrap p-3 text-xs">
        {text ?? (loadFailed ? "" : t("sync.notices.loading"))}
      </pre>
    </section>
  )

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[calc(100vh-3rem)] overflow-y-auto sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>{t("sync.notices.compareTitle")}</DialogTitle>
          <DialogDescription>{t("sync.notices.compareDescription")}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {pane(t("sync.notices.originalVersion"), conflict.originalPath, loaded?.original)}
          {pane(t("sync.notices.copyVersion"), conflict.copyPath, loaded?.copy)}
        </div>
        {loadFailed && (
          <p role="alert" className="text-sm text-destructive">
            {t("sync.notices.loadFailed")}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["keepOriginal", "sync.vault.conflicts.keepOriginal"],
              ["keepCopy", "sync.vault.conflicts.keepCopy"],
              ["keepBoth", "sync.vault.conflicts.keepBoth"],
            ] as const
          ).map(([choice, key]) => (
            <Button
              key={choice}
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void resolve(choice)}
            >
              {t(key)}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("sync.vault.conflicts.hint")}</p>
      </DialogContent>
    </Dialog>
  )
}
