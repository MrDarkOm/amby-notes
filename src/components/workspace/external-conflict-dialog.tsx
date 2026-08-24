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
import { isTauri, saveConflictCopy, writeFile, writeNote } from "@/lib/storage"
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
  const conflict = useDocStore((s) => Object.values(s.externalConflicts)[0] ?? null)
  const vault = useVaultStore((s) => s.vault)
  const backendGeneration = useVaultStore((s) => s.backendGeneration)
  const [saving, setSaving] = React.useState(false)
  const [copyPath, setCopyPath] = React.useState<string | null>(null)

  if (!conflict) return null
  const document = useDocStore.getState().openDocs[conflict.fileId]
  if (!document) return null
  const { patchDoc, markSaved, markUnsaved, clearExternalConflict } = useDocStore.getState()
  const originWindow = isTauri() ? getCurrentWindow().label : "web"

  async function keepLocal() {
    setSaving(true)
    try {
      const content =
        useDocStore.getState().openDocs[conflict.fileId]?.content ?? conflict.localContent
      if (vault) {
        const outcome = await writeNote(
          vault,
          conflict.fileId,
          content,
          backendGeneration,
          conflict.externalRevision ?? document.revision ?? "",
          originWindow,
        )
        patchDoc(conflict.fileId, { revision: outcome.revision })
      } else await writeFile(conflict.path, content)
      markSaved(conflict.fileId)
      clearExternalConflict(conflict.fileId)
      emitAutosaveConflictResolution(conflict.fileId, "discard")
    } catch (err) {
      logger.error("external_conflict.keep_local_failed", { errorType: errorType(err) })
    } finally {
      setSaving(false)
    }
  }

  function acceptExternal() {
    if (conflict.externalContent !== null) {
      patchDoc(conflict.fileId, {
        content: conflict.externalContent,
        revision: conflict.externalRevision,
      })
      markSaved(conflict.fileId)
    }
    clearExternalConflict(conflict.fileId)
    emitAutosaveConflictResolution(conflict.fileId, "discard")
  }

  function mergeManually() {
    if (conflict.externalContent === null) return
    patchDoc(conflict.fileId, {
      content: `<<<<<<< Local Amby\n${conflict.localContent}\n=======\n${conflict.externalContent}\n>>>>>>> External file\n`,
    })
    markUnsaved(conflict.fileId)
    clearExternalConflict(conflict.fileId)
    emitAutosaveConflictResolution(conflict.fileId, "resume")
  }

  async function saveLocalCopy() {
    setSaving(true)
    try {
      const content =
        useDocStore.getState().openDocs[conflict.fileId]?.content ?? conflict.localContent
      const savedPath = await saveConflictCopy(conflict.path, content)
      setCopyPath(savedPath)
    } catch (err) {
      logger.error("external_conflict.save_copy_failed", { errorType: errorType(err) })
    } finally {
      setSaving(false)
    }
  }

  const deleted = conflict.externalContent === null
  return (
    <Dialog open>
      <DialogContent showCloseButton={false} className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{deleted ? t("conflict.deletedTitle") : t("conflict.title")}</DialogTitle>
          <DialogDescription>
            {deleted ? t("conflict.deletedDescription") : t("conflict.description")}
          </DialogDescription>
        </DialogHeader>
        {!deleted && (
          <div className="grid max-h-80 grid-cols-1 gap-3 overflow-hidden md:grid-cols-2">
            <section className="min-w-0 rounded-md border">
              <h3 className="border-b px-3 py-2 text-sm font-medium">
                {t("conflict.localVersion")}
              </h3>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap p-3 text-xs">
                {conflict.localContent}
              </pre>
            </section>
            <section className="min-w-0 rounded-md border">
              <h3 className="border-b px-3 py-2 text-sm font-medium">
                {t("conflict.externalVersion")}
              </h3>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap p-3 text-xs">
                {conflict.externalContent}
              </pre>
            </section>
          </div>
        )}
        {copyPath && (
          <p className="text-sm text-muted-foreground">
            {t("conflict.localCopySaved", { path: copyPath })}
          </p>
        )}
        <DialogFooter className="flex-wrap">
          {!deleted && (
            <Button variant="outline" onClick={mergeManually} disabled={saving}>
              {t("conflict.merge")}
            </Button>
          )}
          <Button variant="outline" onClick={acceptExternal} disabled={saving}>
            {deleted ? t("conflict.keepOpen") : t("conflict.acceptExternal")}
          </Button>
          {!deleted && (
            <Button variant="outline" onClick={saveLocalCopy} disabled={saving}>
              {t("conflict.saveCopy")}
            </Button>
          )}
          <Button onClick={keepLocal} disabled={saving}>
            {saving
              ? t("conflict.saving")
              : deleted
                ? t("conflict.restoreLocal")
                : t("conflict.saveLocal")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
