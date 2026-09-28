import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { errorType, logger } from "@/lib/logger"
import {
  isTauri,
  NoteRevisionConflictError,
  readNote,
  restoreDeletedNote,
  saveConflictCopy,
  writeFile,
  writeNote,
} from "@/lib/storage"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { useDocStore } from "./use-doc-store"
import { useVaultStore } from "./use-vault-store"
import { emitAutosaveConflictResolution } from "./autosave/conflict-events"

/**
 * Prevents an external editor from being silently overwritten by a dirty
 * Amby buffer. The user can keep their version, accept the external version,
 * or put both versions into a manual merge buffer.
 */
export function ExternalConflictDialog() {
  const { t } = useTranslation()
  const conflict = useDocStore((s) =>
    s.activeConflictDialogFileId
      ? (s.externalConflicts[s.activeConflictDialogFileId] ?? null)
      : null,
  )
  const currentDocument = useDocStore((s) => (conflict ? s.openDocs[conflict.fileId] : undefined))
  const closeConflictDialog = useDocStore((s) => s.closeConflictDialog)
  const vault = useVaultStore((s) => s.vault)
  const backendGeneration = useVaultStore((s) => s.backendGeneration)
  const [saving, setSaving] = React.useState(false)
  const [copyPath, setCopyPath] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setCopyPath(null)
    setError(null)
  }, [conflict?.fileId])

  if (!conflict || !currentDocument) return null
  const document = currentDocument
  const activeConflict = conflict
  const { patchDoc, markSaved, markUnsaved, clearExternalConflict } = useDocStore.getState()
  const originWindow = isTauri() ? getCurrentWindow().label : "web"

  async function keepLocal() {
    setSaving(true)
    setError(null)
    try {
      const content =
        useDocStore.getState().openDocs[activeConflict.fileId]?.content ??
        activeConflict.localContent
      if (vault && activeConflict.externalContent === null) {
        const outcome = await restoreDeletedNote(
          vault,
          document.noteId ?? activeConflict.fileId,
          activeConflict.path,
          content,
          activeConflict.sourceTemplate ?? document.source,
          backendGeneration,
          originWindow,
        )
        patchDoc(activeConflict.fileId, {
          revision: outcome.revision,
          source: activeConflict.sourceTemplate ?? document.source,
          externallyDeleted: false,
        })
      } else if (vault) {
        const outcome = await writeNote(
          vault,
          document.noteId ?? activeConflict.fileId,
          content,
          backendGeneration,
          activeConflict.externalRevision ?? document.revision ?? "",
          originWindow,
        )
        patchDoc(activeConflict.fileId, {
          revision: outcome.revision,
          source: activeConflict.sourceTemplate ?? document.source,
        })
      } else await writeFile(activeConflict.path, content)
      const hasNewerEdits =
        useDocStore.getState().openDocs[activeConflict.fileId]?.content !== content
      if (!hasNewerEdits) markSaved(activeConflict.fileId)
      clearExternalConflict(activeConflict.fileId)
      emitAutosaveConflictResolution(activeConflict.fileId, hasNewerEdits ? "resume" : "discard")
    } catch (err) {
      logger.error("external_conflict.keep_local_failed", { errorType: errorType(err) })
      setError(t("conflict.saveFailed"))
      if (vault && err instanceof NoteRevisionConflictError) {
        try {
          const external = await readNote(vault, document.noteId ?? activeConflict.fileId)
          useDocStore.getState().setExternalConflict({
            ...activeConflict,
            localContent:
              useDocStore.getState().openDocs[activeConflict.fileId]?.content ?? document.content,
            externalContent: external.content,
            externalRevision: external.revision,
            sourceTemplate: external.source,
          })
          setError(t("conflict.changedAgain"))
        } catch {
          // Keep both versions and the error visible when rereading fails.
        }
      }
    } finally {
      setSaving(false)
    }
  }

  function acceptExternal() {
    if (activeConflict.externalContent !== null) {
      patchDoc(activeConflict.fileId, {
        content: activeConflict.externalContent,
        revision: activeConflict.externalRevision,
        source: activeConflict.sourceTemplate ?? document.source,
      })
      markSaved(activeConflict.fileId)
    }
    clearExternalConflict(activeConflict.fileId)
    emitAutosaveConflictResolution(activeConflict.fileId, "discard")
  }

  function mergeManually() {
    if (activeConflict.externalContent === null) return
    patchDoc(activeConflict.fileId, {
      content: `<<<<<<< Local Amby\n${document.content}\n=======\n${activeConflict.externalContent}\n>>>>>>> External file\n`,
      revision: activeConflict.externalRevision,
      source: activeConflict.sourceTemplate ?? document.source,
    })
    markUnsaved(activeConflict.fileId)
    clearExternalConflict(activeConflict.fileId)
    emitAutosaveConflictResolution(activeConflict.fileId, "resume")
  }

  async function saveLocalCopy() {
    setSaving(true)
    setError(null)
    try {
      const content =
        useDocStore.getState().openDocs[activeConflict.fileId]?.content ??
        activeConflict.localContent
      const savedPath = await saveConflictCopy(activeConflict.path, content)
      setCopyPath(savedPath)
    } catch (err) {
      logger.error("external_conflict.save_copy_failed", { errorType: errorType(err) })
      setError(t("conflict.copyFailed"))
    } finally {
      setSaving(false)
    }
  }

  const deleted = activeConflict.externalContent === null
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) closeConflictDialog()
      }}
    >
      <DialogContent
        showCloseButton={!saving}
        className="max-h-[calc(100vh-3rem)] overflow-y-auto sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>{deleted ? t("conflict.deletedTitle") : t("conflict.title")}</DialogTitle>
          <DialogDescription>
            {deleted ? t("conflict.deletedDescription") : t("conflict.description")}
          </DialogDescription>
        </DialogHeader>
        {!deleted && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <section className="flex min-w-0 flex-col rounded-md border">
              <h3 className="border-b px-3 py-2 text-sm font-medium">
                {t("conflict.localVersion")}
              </h3>
              <pre className="max-h-60 min-h-24 flex-1 overflow-auto whitespace-pre-wrap p-3 text-xs">
                {document.content}
              </pre>
              <div className="space-y-2 border-t p-3">
                <Button className="w-full" onClick={keepLocal} disabled={saving}>
                  {saving ? t("conflict.saving") : t("conflict.saveLocal")}
                </Button>
                <p className="text-xs text-muted-foreground">{t("conflict.saveLocalHint")}</p>
              </div>
            </section>
            <section className="flex min-w-0 flex-col rounded-md border">
              <h3 className="border-b px-3 py-2 text-sm font-medium">
                {t("conflict.externalVersion")}
              </h3>
              <pre className="max-h-60 min-h-24 flex-1 overflow-auto whitespace-pre-wrap p-3 text-xs">
                {activeConflict.externalContent}
              </pre>
              <div className="space-y-2 border-t p-3">
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={acceptExternal}
                  disabled={saving}
                >
                  {t("conflict.acceptExternal")}
                </Button>
                <p className="text-xs text-muted-foreground">{t("conflict.acceptExternalHint")}</p>
              </div>
            </section>
          </div>
        )}
        {!deleted && (
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              {t("conflict.otherOptions")}
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={saveLocalCopy}
                  disabled={saving}
                >
                  {t("conflict.saveCopy")}
                </Button>
                <p className="text-xs text-muted-foreground">{t("conflict.saveCopyHint")}</p>
              </div>
              <div className="space-y-2">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={mergeManually}
                  disabled={saving}
                >
                  {t("conflict.merge")}
                </Button>
                <p className="text-xs text-muted-foreground">{t("conflict.mergeHint")}</p>
              </div>
            </div>
          </details>
        )}
        {copyPath && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("conflict.localCopySaved", { path: copyPath })}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {deleted && (
          <DialogFooter>
            <Button variant="outline" onClick={acceptExternal} disabled={saving}>
              {t("conflict.keepOpen")}
            </Button>
            <Button onClick={keepLocal} disabled={saving}>
              {saving ? t("conflict.saving") : t("conflict.restoreLocal")}
            </Button>
          </DialogFooter>
        )}
        <p className="text-xs text-muted-foreground">{t("conflict.dismissHint")}</p>
      </DialogContent>
    </Dialog>
  )
}
