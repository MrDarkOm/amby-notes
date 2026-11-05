import * as React from "react"
import { useTranslation } from "react-i18next"
import { FileWarning, History, Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  acceptPropertyRenameHint,
  checkOldVersionPropertyEdits,
  dismissPropertyRenameHint,
  getPropertyPanel,
  previewPropertiesMigration,
  propertyStorageStatus,
  resolveOldVersionPropertyConflict,
  runPropertiesMigration,
  type MigrationReportView,
  type PropertyPanel,
  type PropertyStorageStatus,
} from "@/lib/properties/property-groups-port"
import { Card, type Notice } from "./notice-card"

/**
 * The warnings of the properties of a note as cards of its stack (docs/sync-plan.md, К3, appendix
 * З): the offer of the new format, the hint about a rename, what an old version changed, the
 * choice after an edit made here and there, the warning about an old version, and the notes about
 * the file of the properties. Each is one or two lines. Nothing in the browser.
 */
export function usePropertyNotices(noteId: string): Notice[] {
  const { t } = useTranslation()
  const [status, setStatus] = React.useState<PropertyStorageStatus | null>(null)
  const [panel, setPanel] = React.useState<PropertyPanel | null>(null)
  const [report, setReport] = React.useState<MigrationReportView | null>(null)
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
      setError(
        t("noteNotices.properties.failed", {
          details: caught instanceof Error ? caught.message : String(caught),
        }),
      )
    } finally {
      setBusy(false)
      await load()
    }
  }

  const notices: Notice[] = []
  if (!status) return notices
  if (status.mode === "legacy") {
    notices.push({
      id: "properties-migration",
      urgent: false,
      card: (
        <Card
          key="properties-migration"
          testId="note-notice-properties-migration"
          urgent={false}
          icon={<Sparkles className="size-4" />}
          title={t("noteNotices.properties.migrationTitle")}
          lines={[
            report
              ? t("noteNotices.properties.migrationReport", {
                  notes: report.notes,
                  edits: report.headerEdits,
                })
              : t("noteNotices.properties.migrationBody"),
          ]}
          error={error}
          actions={
            report ? (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await runPropertiesMigration()
                    setReport(null)
                  })
                }
              >
                {t("noteNotices.properties.migrationRun")}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void act(async () => setReport(await previewPropertiesMigration()))}
              >
                {t("noteNotices.properties.migrationReview")}
              </Button>
            )
          }
        />
      ),
    })
    return notices
  }
  const warnings = panel?.warnings ?? []
  if (status.mode === "newer" || warnings.some((w) => w.kind === "formatNewer")) {
    notices.push({
      id: "properties-newer",
      urgent: false,
      card: (
        <Card
          key="properties-newer"
          testId="note-notice-properties-newer"
          urgent={false}
          icon={<FileWarning className="size-4" />}
          title={t("noteNotices.properties.formatNewer")}
        />
      ),
    })
  }
  if (warnings.some((w) => w.kind === "badLineInGroup")) {
    notices.push({
      id: "properties-bad-line",
      urgent: false,
      card: (
        <Card
          key="properties-bad-line"
          testId="note-notice-properties-bad-line"
          urgent={false}
          icon={<FileWarning className="size-4" />}
          title={t("noteNotices.properties.badLine")}
        />
      ),
    })
  }
  const hint = panel?.renameHint ?? null
  if (hint) {
    notices.push({
      id: `properties-rename:${hint.oldName}:${hint.newName}`,
      urgent: false,
      card: (
        <Card
          key="properties-rename"
          testId="note-notice-properties-rename"
          urgent={false}
          icon={<Sparkles className="size-4" />}
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
      urgent: true,
      card: (
        <Card
          key="properties-old-conflict"
          testId="note-notice-properties-old-conflict"
          urgent
          icon={<History className="size-4" />}
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
      urgent: false,
      card: (
        <Card
          key="properties-transferred"
          testId="note-notice-properties-transferred"
          urgent={false}
          icon={<History className="size-4" />}
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
      urgent: false,
      card: (
        <Card
          key="properties-old-version"
          testId="note-notice-properties-old-version"
          urgent={false}
          icon={<History className="size-4" />}
          title={oldVersion}
        />
      ),
    })
  }
  return notices
}
