import * as React from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import {
  acceptPropertyRenameHint,
  checkOldVersionPropertyEdits,
  dismissPropertyRenameHint,
  getPropertyPanel,
  openVaultProperties,
  propertyStorageStatus,
  resolveOldVersionPropertyConflict,
  takePropertyFileValue,
  type PropertyPanel,
  type PropertyStorageStatus,
} from "@/lib/properties/property-groups-port"
import { errorType, logger } from "@/lib/logger"
import { getNoteProperties } from "@/lib/storage"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { Card, type Notice } from "./notice-card"
import { goneKey, usePropertyMigrationStore } from "./use-property-migration-store"
import { isNotFoundError, operationErrorCode } from "@/lib/operation-errors"

/**
 * The warnings of the properties of a note as cards of its stack (docs/sync-plan.md, К3, appendix
 * З): the offer of the new format, the hint about a rename, what an old version changed, the
 * choice after an edit made here and there, the warning about an old version, and the notes about
 * the file of the properties. Each is one or two lines. Nothing in the browser.
 */
/**
 * The note of the last session opens before the first opening of the vault has migrated its
 * properties, so its first reading has no look and no options. When the opening changed the
 * storage, every open note reads its properties again.
 */
async function rereadOpenNotes(vault: string) {
  const docs = useDocStore.getState().openDocs
  await Promise.all(
    Object.values(docs)
      .filter((doc) => doc.noteProperties)
      .map(async (doc) => {
        const noteProperties = await getNoteProperties(vault, doc.noteId ?? doc.id).catch(
          () => null,
        )
        if (noteProperties) useDocStore.getState().patchDoc(doc.id, { noteProperties })
      }),
  )
}

export function usePropertyNotices(noteId: string): Notice[] {
  const { t } = useTranslation()
  const [status, setStatus] = React.useState<PropertyStorageStatus | null>(null)
  const [panel, setPanel] = React.useState<PropertyPanel | null>(null)
  const [showReport, setShowReport] = React.useState(false)
  const vault = useVaultStore((state) => state.vault)
  const generation = useVaultStore((state) => state.generation)
  const migration = usePropertyMigrationStore((state) => state.outcome)
  const migrationDismissed = usePropertyMigrationStore((state) => state.dismissed)
  const goneItems = usePropertyMigrationStore((state) => state.gone)
  const renamedItems = usePropertyMigrationStore((state) => state.renamed)
  const [transferred, setTransferred] = React.useState<string | null>(null)
  const [conflicts, setConflicts] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const next = await propertyStorageStatus()
      setStatus(next)
      setPanel(next?.mode === "groups" ? await getPropertyPanel(noteId) : null)
    } catch {
      setStatus(null)
      setPanel(null)
    }
  }, [noteId])
  // The first opening of the vault migrates the properties by itself, with no question (З57).
  React.useEffect(() => {
    if (!vault) return
    const key = `${vault}:${generation}`
    const store = usePropertyMigrationStore.getState()
    if (!store.begin(key)) return
    openVaultProperties()
      .then((outcome) => {
        store.finish(key, outcome)
        const changed = outcome?.state === "migrated" || outcome?.state === "arrivedFromServer"
        return Promise.all([load(), changed ? rereadOpenNotes(vault) : undefined])
      })
      .catch(() => {})
  }, [vault, generation, load])
  React.useEffect(() => {
    void load()
  }, [load])

  // Edits of an old version are carried over by themselves (З22, З36).
  const oldVersion = status?.mode === "groups" ? status.oldVersionWarning : null
  React.useEffect(() => {
    if (!oldVersion) return
    let alive = true
    checkOldVersionPropertyEdits()
      .then((result) => {
        if (!alive || !result) return
        setConflicts(result.conflicts)
        if (result.hintText) setTransferred(result.hintText)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [oldVersion])

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      setError(null)
    } catch (caught) {
      // The person gets a sentence; the words of the backend go to the log.
      logger.error("property.notice_action_failed", {
        errorType: errorType(caught),
        failureCode: operationErrorCode(caught),
      })
      setError(t("noteNotices.properties.failedShort"))
    } finally {
      setBusy(false)
      await load()
    }
  }

  const takeFile = async (noteId: string, fileName: string, name: string) => {
    setBusy(true)
    try {
      await takePropertyFileValue(noteId, fileName, name)
      usePropertyMigrationStore.getState().settle(noteId, fileName)
      setError(null)
    } catch (caught) {
      logger.error("property.take_file_value_failed", {
        errorType: errorType(caught),
        failureCode: operationErrorCode(caught),
      })
      // The property was renamed away or deleted since: the card says so and offers nothing.
      if (isNotFoundError(caught)) {
        usePropertyMigrationStore.getState().markGone(noteId, fileName)
      } else {
        setError(t("noteNotices.properties.failedShort"))
      }
    } finally {
      setBusy(false)
      await load()
    }
  }

  const notices: Notice[] = []
  if (!status) return notices
  if (migration?.state === "readOnly" || (status.mode === "legacy" && migration === null)) {
    notices.push({
      id: "properties-read-only",
      card: (
        <Card
          key="properties-read-only"
          testId="note-notice-properties-read-only"
          level="decision"
          title={t(
            migration?.reason === "waitingForSync"
              ? "noteNotices.properties.waitingForSync"
              : "noteNotices.properties.readOnly",
          )}
        />
      ),
    })
  }
  if (migration?.state === "migrated" && !migrationDismissed) {
    const diverged = migration.diverged
    notices.push({
      id: "properties-migrated",
      card: (
        <Card
          key="properties-migrated"
          testId="note-notice-properties-migrated"
          level={diverged.length > 0 ? "warning" : "info"}
          title={t("noteNotices.properties.migrated")}
          lines={
            diverged.length > 0
              ? [t("noteNotices.properties.diverged", { count: diverged.length })]
              : []
          }
          error={error}
          actions={
            <>
              {diverged.length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setShowReport((value) => !value)}
                >
                  {t("noteNotices.properties.report")}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => usePropertyMigrationStore.getState().dismiss()}
              >
                {t("sync.notices.dismiss")}
              </Button>
            </>
          }
        />
      ),
    })
    if (showReport) {
      for (const item of diverged) {
        const missing = goneItems.includes(goneKey(item.noteId, item.name))
        notices.push({
          id: `properties-diverged:${item.noteId}:${item.name}`,
          card: (
            <Card
              key={`properties-diverged:${item.noteId}:${item.name}`}
              testId="note-notice-properties-diverged"
              level="warning"
              title={
                missing
                  ? t("noteNotices.properties.gone", { name: item.name, file: item.fileValue })
                  : t("noteNotices.properties.divergedItem", {
                      name: item.name,
                      file: item.fileValue,
                      header: item.headerValue,
                    })
              }
              actions={
                missing ? undefined : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void takeFile(
                        item.noteId,
                        item.name,
                        renamedItems[goneKey(item.noteId, item.name)] ?? item.name,
                      )
                    }
                  >
                    {t("noteNotices.properties.takeFile")}
                  </Button>
                )
              }
            />
          ),
        })
      }
    }
  }
  const warnings = panel?.warnings ?? []
  if (status.mode === "newer" || warnings.some((w) => w.kind === "formatNewer")) {
    notices.push({
      id: "properties-newer",
      card: (
        <Card
          key="properties-newer"
          testId="note-notice-properties-newer"
          level="warning"
          title={t("noteNotices.properties.formatNewer")}
        />
      ),
    })
  }
  if (warnings.some((w) => w.kind === "badLineInGroup")) {
    notices.push({
      id: "properties-bad-line",
      card: (
        <Card
          key="properties-bad-line"
          testId="note-notice-properties-bad-line"
          level="warning"
          title={t("noteNotices.properties.badLine")}
        />
      ),
    })
  }
  const hint = panel?.renameHint ?? null
  if (hint) {
    notices.push({
      id: `properties-rename:${hint.oldName}:${hint.newName}`,
      card: (
        <Card
          key="properties-rename"
          testId="note-notice-properties-rename"
          level="info"
          title={t("noteNotices.properties.renameHint", {
            oldName: hint.oldName,
            newName: hint.newName,
          })}
          error={error}
          actions={
            <>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void act(() => acceptPropertyRenameHint(noteId, hint))}
              >
                {t("noteNotices.properties.renameYes")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void act(() => dismissPropertyRenameHint(noteId, hint))}
              >
                {t("noteNotices.properties.renameNo")}
              </Button>
            </>
          }
        />
      ),
    })
  }
  if (conflicts.includes(noteId)) {
    notices.push({
      id: "properties-old-conflict",
      card: (
        <Card
          key="properties-old-conflict"
          testId="note-notice-properties-old-conflict"
          level="decision"
          title={t("noteNotices.properties.oldConflict")}
          error={error}
          actions={
            <>
              {[true, false].map((keepHere) => (
                <Button
                  key={String(keepHere)}
                  type="button"
                  size="sm"
                  variant={keepHere ? "default" : "outline"}
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await resolveOldVersionPropertyConflict(noteId, keepHere)
                      setConflicts((all) => all.filter((id) => id !== noteId))
                    })
                  }
                >
                  {t(
                    keepHere ? "noteNotices.properties.keepHere" : "noteNotices.properties.takeOld",
                  )}
                </Button>
              ))}
            </>
          }
        />
      ),
    })
  }
  if (transferred) {
    notices.push({
      id: "properties-transferred",
      card: (
        <Card
          key="properties-transferred"
          testId="note-notice-properties-transferred"
          level="info"
          title={transferred}
          actions={
            <Button type="button" size="sm" variant="outline" onClick={() => setTransferred(null)}>
              {t("sync.notices.dismiss")}
            </Button>
          }
        />
      ),
    })
  }
  if (oldVersion) {
    notices.push({
      id: "properties-old-version",
      card: (
        <Card
          key="properties-old-version"
          testId="note-notice-properties-old-version"
          level="info"
          title={oldVersion}
        />
      ),
    })
  }
  return notices
}
