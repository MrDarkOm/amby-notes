import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  acceptPropertyRenameHint,
  checkOldVersionPropertyEdits,
  dismissPropertyRenameHint,
  getPropertyPanel,
  previewPropertiesMigration,
  propertyStorageStatus,
  purgeDormantProperty,
  resolveOldVersionPropertyConflict,
  restoreDormantProperty,
  runPropertiesMigration,
  type MigrationReportView,
  type PropertyPanel,
  type PropertyStorageStatus,
} from "@/lib/properties/property-groups-port"

const buttonClass =
  "rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"

/**
 * What the new storage of note properties adds to the panel (docs/sync-plan.md, appendix З): the
 * offer to migrate, the warning about an old version, the records whose key is not in the header
 * (З3) and the hint about a rename outside Amby (З3а). Nothing is shown in the browser.
 */
export function PropertyGroupsNotices({ noteId }: { noteId: string }) {
  const { t } = useTranslation()
  const [status, setStatus] = React.useState<PropertyStorageStatus | null>(null)
  const [panel, setPanel] = React.useState<PropertyPanel | null>(null)
  const [report, setReport] = React.useState<MigrationReportView | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [conflicts, setConflicts] = React.useState<string[]>([])

  const load = React.useCallback(async () => {
    try {
      const nextStatus = await propertyStorageStatus()
      setStatus(nextStatus)
      setPanel(nextStatus?.mode === "groups" ? await getPropertyPanel(noteId) : null)
    } catch {
      setStatus(null)
      setPanel(null)
    }
  }, [noteId])

  React.useEffect(() => {
    void load()
  }, [load])

  // Edits of an old version are carried over by themselves when the panel opens (З22, З36).
  React.useEffect(() => {
    if (status?.mode !== "groups" || !status.oldVersionWarning) return
    let alive = true
    checkOldVersionPropertyEdits()
      .then((result) => {
        if (!alive || !result) return
        setConflicts(result.conflicts)
        if (result.hintText) setMessage(result.hintText)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [status?.mode, status?.oldVersionWarning])

  const act = React.useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await action()
        setMessage(null)
      } catch (error) {
        setMessage(
          t("infoPanel.groups.migrationFailed", {
            details: error instanceof Error ? error.message : String(error),
          }),
        )
      } finally {
        setBusy(false)
        await load()
      }
    },
    [load, t],
  )

  if (!status || status.mode === "legacy") {
    if (!status) return null
    return (
      <section className="space-y-2 rounded-md border border-border/60 p-3 text-xs">
        <h3 className="font-medium text-foreground">{t("infoPanel.groups.migrationTitle")}</h3>
        <p className="text-muted-foreground">{t("infoPanel.groups.migrationBody")}</p>
        {report && (
          <p role="status" className="text-muted-foreground">
            {t("infoPanel.groups.migrationReport", {
              notes: report.notes,
              properties: report.properties,
              same: report.same,
              mismatches: report.mismatches.length,
              missing: report.missingKeys.length,
              edits: report.headerEdits,
            })}
          </p>
        )}
        {report?.warnings.map((warning) => (
          <p key={warning} className="text-muted-foreground">
            {warning}
          </p>
        ))}
        {message && (
          <p role="alert" className="text-destructive">
            {message}
          </p>
        )}
        <div className="flex gap-2">
          {!report ? (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => void act(async () => setReport(await previewPropertiesMigration()))}
            >
              {t("infoPanel.groups.migrationReview")}
            </button>
          ) : (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await runPropertiesMigration()
                  setReport(null)
                })
              }
            >
              {t("infoPanel.groups.migrationRun")}
            </button>
          )}
        </div>
      </section>
    )
  }

  const hint = panel?.renameHint ?? null
  const warnings = panel?.warnings ?? []
  const dormant = panel?.dormant ?? []
  const oldVersionWarning = status.oldVersionWarning
  if (!oldVersionWarning && !hint && dormant.length === 0 && warnings.length === 0 && !message) {
    return null
  }
  return (
    <section className="space-y-3 text-xs">
      {status.mode === "newer" || warnings.some((w) => w.kind === "formatNewer") ? (
        <p role="status" className="text-muted-foreground">
          {t("infoPanel.groups.formatNewer")}
        </p>
      ) : null}
      {warnings.some((w) => w.kind === "badLineInGroup") && (
        <p role="alert" className="text-destructive">
          {t("infoPanel.groups.badLine")}
        </p>
      )}
      {oldVersionWarning && (
        <div className="space-y-1">
          <p role="status" className="text-muted-foreground">
            {oldVersionWarning}
          </p>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const result = await checkOldVersionPropertyEdits()
                setConflicts(result?.conflicts ?? [])
                setMessage(
                  result?.hintText ??
                    (result && result.conflicts.length > 0
                      ? t("infoPanel.groups.oldVersionConflicts", {
                          count: result.conflicts.length,
                        })
                      : t("infoPanel.groups.oldVersionNothing")),
                )
              })
            }
          >
            {t("infoPanel.groups.oldVersionCheck")}
          </button>
        </div>
      )}
      {conflicts.map((conflictId) => (
        <div key={conflictId} className="space-y-1 rounded-md border border-border/60 p-2">
          <p>{t("infoPanel.groups.oldVersionConflict")}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await resolveOldVersionPropertyConflict(conflictId, true)
                  setConflicts((all) => all.filter((id) => id !== conflictId))
                })
              }
            >
              {t("infoPanel.groups.keepHere")}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await resolveOldVersionPropertyConflict(conflictId, false)
                  setConflicts((all) => all.filter((id) => id !== conflictId))
                })
              }
            >
              {t("infoPanel.groups.takeOld")}
            </button>
          </div>
        </div>
      ))}
      {hint && (
        <div className="space-y-1 rounded-md border border-border/60 p-2">
          <p>
            {t("infoPanel.groups.renameHint", { oldName: hint.oldName, newName: hint.newName })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => void act(() => acceptPropertyRenameHint(noteId, hint))}
            >
              {t("infoPanel.groups.renameYes")}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => void act(() => dismissPropertyRenameHint(noteId, hint))}
            >
              {t("infoPanel.groups.renameNo")}
            </button>
          </div>
        </div>
      )}
      {dormant.length > 0 && (
        <div className="space-y-1 opacity-70">
          <h3 className="font-medium text-foreground">{t("infoPanel.groups.dormantTitle")}</h3>
          <p className="text-muted-foreground">{t("infoPanel.groups.dormantHint")}</p>
          <ul className="space-y-1">
            {dormant.map((item) => (
              <li key={item.name} className="flex items-center gap-2">
                <span aria-hidden>{item.icon}</span>
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => void act(() => restoreDormantProperty(noteId, item.name))}
                >
                  {t("infoPanel.groups.restore")}
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => void act(() => purgeDormantProperty(noteId, item.name))}
                >
                  {t("infoPanel.groups.purge")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {message && (
        <p role="status" className="text-muted-foreground">
          {message}
        </p>
      )}
    </section>
  )
}
