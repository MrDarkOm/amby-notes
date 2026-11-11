"use client"

import * as React from "react"
import { Loader2, RotateCcw } from "lucide-react"
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
import { isServicePath } from "./archive-model"

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
 * The server list that the cloud button of the header switches the archive panel to: files that
 * were deleted but that the server still keeps (docs/sync-plan.md, appendix И, И9а–И17). Service
 * files are never listed (И10а). The panel search filters it. A restore writes the files through the
 * app and the answer stays under the button.
 */
export function ArchiveServerSection({
  list,
  query,
  reload,
}: {
  list: DeletedOnServer | null
  /** The text of the panel search, already trimmed and lower-cased. */
  query: string
  reload: () => Promise<void>
}) {
  const { t, i18n } = useTranslation()
  const port = React.useMemo(() => resolveSyncPort(), [])
  const [ticked, setTicked] = React.useState<Set<string>>(new Set())
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<string | null>(null)
  const mounted = React.useRef(true)
  const locale = i18n.resolvedLanguage ?? i18n.language

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const all = (list?.files ?? []).filter((file) => !isServicePath(file.path))
  const files = all.filter((file) => file.path.toLocaleLowerCase().includes(query))
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
      // И10в: a row of a super note stands for all its files, which come back together.
      const itemIds = all
        .filter((file) => ticked.has(file.itemId))
        .flatMap((file) => (file.itemIds?.length ? file.itemIds : [file.itemId]))
      const outcome = await port.restoreDeleted(itemIds)
      if (!mounted.current) return
      setResult(resultLine(outcome, t))
      setTicked(new Set())
      await reload()
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
    <section data-testid="archive-server-section" aria-label={t("archivePanel.serverSection")}>
      {list && !list.available ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">{t("archivePanel.serverOffline")}</p>
      ) : !list ? (
        <p className="flex justify-center py-10 text-muted-foreground">
          <MotionSpinner>
            <Loader2 className="size-4" />
          </MotionSpinner>
        </p>
      ) : all.length === 0 ? (
        <p className="py-10 text-center text-xs text-muted-foreground">
          {t("archivePanel.serverEmpty")}
        </p>
      ) : files.length === 0 ? (
        <p className="py-10 text-center text-xs text-muted-foreground">
          {t("historyPanel.noResults")}
        </p>
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
            </div>
          )}
        </>
      )}
      {result && (
        <p
          role="status"
          data-testid="archive-server-result"
          className="px-2 pt-1 text-xs text-muted-foreground"
        >
          {result}
        </p>
      )}
    </section>
  )
}
