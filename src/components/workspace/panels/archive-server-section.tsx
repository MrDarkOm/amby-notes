"use client"

import * as React from "react"
import { Cloud, Loader2, RotateCcw } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { logger, errorType } from "@/lib/logger"
import { MotionSpinner } from "@/lib/motion"
import type { DeletedFileView } from "@/lib/bindings"
import {
  resolveSyncPort,
  type DeletedOnServer,
  type RestoreDeletedOutcome,
} from "@/lib/sync/sync-port"

const DAY_MS = 24 * 60 * 60 * 1000
/** The server list is cut to the newest 500 (И13, `MAX_DELETED_ROWS`). */
const LIST_LIMIT = 500

/** `Заметки/Файл.md` → the name shown for it and the folder it was in. */
function serverFileLabel(path: string): { title: string; parent: string } {
  const parts = path.replace(/\\/g, "/").split("/")
  const name = parts.pop() ?? path
  return { title: name.replace(/\.md$/iu, ""), parent: parts.join("/") }
}

/** The one line under the button (docs/notices.md: the answer stays where the action was). */
function resultLine(
  outcome: RestoreDeletedOutcome,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const renamed = outcome.results.filter(
    (result) => result.status === "restoredRenamed" && result.finalPath,
  )
  const nameOf = (path: string) => path.replace(/\\/g, "/").split("/").pop() ?? path
  if (outcome.requested === 1 && renamed.length === 1) {
    return t("archivePanel.serverRestoredAs", { name: nameOf(renamed[0].finalPath ?? "") })
  }
  let line = t("archivePanel.serverRestoreResult", {
    restored: outcome.restored,
    total: outcome.requested,
  })
  if (outcome.damaged > 0) {
    line += t("archivePanel.serverRestoreDamaged", { count: outcome.damaged })
  }
  for (const result of renamed.slice(0, 3)) {
    line += `. ${t("archivePanel.serverRestoredAs", { name: nameOf(result.finalPath ?? "") })}`
  }
  return line
}

/**
 * "На сервере": files that were deleted but that the server still keeps (docs/sync-plan.md,
 * appendix И, И9–И17). Only when sync of the vault is on; the list is asked for once when the
 * section opens. A restore writes the files through the app and the answer stays under the button.
 */
export function ArchiveServerSection({
  onList,
}: {
  /** Told about every list that arrives: the local entries get their cloud from it (И11а). */
  onList?: (list: DeletedOnServer) => void
}) {
  const { t, i18n } = useTranslation()
  const port = React.useMemo(() => resolveSyncPort(), [])
  const [on, setOn] = React.useState(false)
  const [list, setList] = React.useState<DeletedOnServer | null>(null)
  const [ticked, setTicked] = React.useState<Set<string>>(new Set())
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<string | null>(null)
  const mounted = React.useRef(true)
  const request = React.useRef(0)
  const locale = i18n.resolvedLanguage ?? i18n.language

  const load = React.useCallback(async () => {
    const sequence = ++request.current
    let next: DeletedOnServer
    try {
      next = await port.deletedFiles()
    } catch (cause) {
      // Not an error for the person (И13): the same calm line as without a connection.
      logger.warn("archive.server_list_failed", { errorType: errorType(cause) })
      next = {
        available: false,
        reason: "offline",
        files: [],
        truncated: false,
        trashOnServer: [],
      }
    }
    if (mounted.current && sequence === request.current) {
      setList(next)
      onList?.(next)
    }
  }, [port, onList])

  React.useEffect(() => {
    mounted.current = true
    let cancelled = false
    port
      .vaultStatus()
      .then((status) => {
        if (!cancelled) setOn(status.enabled && status.linked)
      })
      .catch(() => {
        if (!cancelled) setOn(false)
      })
    const requests = request
    return () => {
      cancelled = true
      mounted.current = false
      requests.current++
    }
  }, [port])

  React.useEffect(() => {
    if (on) void load()
  }, [on, load])

  if (!on) return null

  const files = list?.files ?? []
  const now = Date.now()

  function toggle(file: DeletedFileView) {
    setTicked((current) => {
      const next = new Set(current)
      if (next.has(file.itemId)) next.delete(file.itemId)
      else next.add(file.itemId)
      return next
    })
  }

  async function restore() {
    if (busy || ticked.size === 0) return
    setBusy(true)
    setResult(null)
    try {
      const outcome = await port.restoreDeleted([...ticked])
      if (!mounted.current) return
      setResult(resultLine(outcome, t))
      setTicked(new Set())
      await load()
    } catch (cause) {
      logger.warn("archive.server_restore_failed", { errorType: errorType(cause) })
      if (mounted.current) setResult(t("archivePanel.restoreFailed"))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const ago = (deletedMs: number) => {
    const days = Math.max(0, Math.floor((now - deletedMs) / DAY_MS))
    return days === 0
      ? t("archivePanel.serverDeletedToday")
      : t("archivePanel.serverDeletedAgo", { count: days })
  }

  return (
    <section
      data-testid="archive-server-section"
      className="mb-3"
      aria-label={t("archivePanel.serverSection")}
    >
      <h3 className="flex items-center gap-1 px-2 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">
        <Cloud className="size-3" aria-hidden />
        {t("archivePanel.serverSection")}
      </h3>
      {list && !list.available ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">{t("archivePanel.serverOffline")}</p>
      ) : (
        <>
          <div className="space-y-0.5">
            {files.map((file) => {
              const { title, parent } = serverFileLabel(file.path)
              const until = file.keptUntilMs
                ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(file.keptUntilMs)
                : null
              return (
                <label
                  key={file.itemId}
                  data-testid="archive-server-row"
                  className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5 shrink-0 accent-primary"
                    checked={ticked.has(file.itemId)}
                    disabled={busy}
                    onChange={() => toggle(file)}
                    aria-label={title}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs leading-4" title={file.path}>
                      {title}
                    </span>
                    <span className="block truncate text-[10px] leading-4 text-muted-foreground">
                      {parent || t("archivePanel.vaultRoot")}
                    </span>
                    <span className="block text-[10px] leading-4 text-muted-foreground">
                      {ago(file.deletedMs)}
                      {until ? ` · ${t("archivePanel.serverKeptUntil", { until })}` : ""}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
          {list?.truncated && (
            <p className="px-2 py-1 text-[10px] text-muted-foreground">
              {t("archivePanel.serverTruncated", { count: LIST_LIMIT })}
            </p>
          )}
          {files.length > 0 && (
            <div className="flex flex-col items-start gap-1 px-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || ticked.size === 0}
                onClick={() => void restore()}
              >
                {busy ? (
                  <MotionSpinner>
                    <Loader2 />
                  </MotionSpinner>
                ) : (
                  <RotateCcw />
                )}
                {t("archivePanel.serverRestore")}
              </Button>
              {result && (
                <p
                  role="status"
                  data-testid="archive-server-result"
                  className="text-xs text-muted-foreground"
                >
                  {result}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
