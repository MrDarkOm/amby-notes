import * as React from "react"
import { ChevronLeft, ChevronRight, Loader2, RotateCcw, ShieldCheck } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { compactHistoryDiff, diffHistory, historyReasonKey } from "./history-model"
import type { useHistory } from "./use-history"

export function HistoryPreview({
  history,
  name,
}: {
  history: ReturnType<typeof useHistory>
  name: string
}) {
  const { t, i18n } = useTranslation()
  const [mode, setMode] = React.useState<"changes" | "version" | "current">("changes")
  const diff = React.useMemo(
    () => (history.preview ? diffHistory(history.preview.previous, history.preview.current) : null),
    [history.preview],
  )
  const entry = history.selected
  const rows = React.useMemo(() => (diff ? compactHistoryDiff(diff.lines) : []), [diff])
  const index = history.snapshots.findIndex((version) => version.id === entry?.id)
  const date = entry
    ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "long", timeStyle: "short" }).format(
        entry.createdAtMs,
      )
    : ""
  return (
    <Dialog
      open={Boolean(entry)}
      onOpenChange={(open) => {
        if (!open && !history.busy) void history.select(null)
      }}
    >
      <DialogContent
        className="flex h-[min(82vh,800px)] min-h-0 max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden bg-[var(--note-surface)] p-0 sm:max-w-5xl"
        onEscapeKeyDown={(event) => {
          if (history.busy) event.preventDefault()
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <div className="border-b px-5 pb-4 pt-5 pr-12">
          <p className="mb-1 text-xs text-muted-foreground">{t("historyPanel.versionHistory")}</p>
          <DialogTitle className="truncate text-lg">{name}</DialogTitle>
          <DialogDescription className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span>{date}</span>
            <span aria-hidden="true">·</span>
            <span>{entry && t(historyReasonKey(entry.reason))}</span>
          </DialogDescription>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label={t("historyPanel.previewMode")}
          >
            {(["changes", "version", "current"] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={mode === value ? "secondary" : "ghost"}
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                className="text-xs"
              >
                {t(`historyPanel.${value}`)}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Button
              variant="ghost"
              size="icon-sm"
              title={t("historyPanel.newer")}
              aria-label={t("historyPanel.newer")}
              disabled={index <= 0 || history.busy}
              onClick={() => void history.select(history.snapshots[index - 1])}
            >
              <ChevronLeft />
            </Button>
            <span className="tabular-nums">
              {index + 1} / {history.snapshots.length}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              title={t("historyPanel.older")}
              aria-label={t("historyPanel.older")}
              disabled={index < 0 || index >= history.snapshots.length - 1 || history.busy}
              onClick={() => void history.select(history.snapshots[index + 1])}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
        {history.error && (
          <p role="alert" className="border-b px-5 py-3 text-xs text-destructive">
            {history.error}
          </p>
        )}
        {history.previewLoading ? (
          <div
            role="status"
            className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" />
            {t("historyPanel.loadingVersion")}
          </div>
        ) : diff && history.preview ? (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-muted/30 px-5 py-2 text-xs text-muted-foreground">
              <span>
                {t(
                  mode === "changes"
                    ? "historyPanel.changesSince"
                    : mode === "current"
                      ? "historyPanel.savedOnDisk"
                      : "historyPanel.snapshotContent",
                )}
              </span>
              {mode === "changes" && (
                <span className="ml-auto flex gap-3 tabular-nums">
                  <span>{t("historyPanel.addedLines", { count: diff.added })}</span>
                  <span>{t("historyPanel.removedLines", { count: diff.removed })}</span>
                </span>
              )}
            </div>
            {diff.simplified && mode === "changes" && (
              <p className="px-5 py-2 text-xs text-muted-foreground">
                {t("historyPanel.simplifiedDiff")}
              </p>
            )}
            <div
              className="min-h-0 flex-1 overflow-auto"
              tabIndex={0}
              aria-label={t("historyPanel.previewContent")}
            >
              {mode === "changes" ? (
                diff.identical ? (
                  <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-6 text-center">
                    <ShieldCheck className="size-8 text-muted-foreground" />
                    <p className="text-sm">{t("historyPanel.identical")}</p>
                  </div>
                ) : (
                  <div className="py-3 font-mono text-xs leading-6">
                    {rows.slice(0, 1500).map((line, i) =>
                      line.kind === "gap" ? (
                        <p key={i} className="my-2 bg-muted/40 px-5 py-1 text-muted-foreground">
                          {t("historyPanel.unchangedLines", { count: line.count })}
                        </p>
                      ) : (
                        <div
                          key={i}
                          className={cn("history-diff-line flex", `history-diff-${line.kind}`)}
                        >
                          <span
                            aria-hidden="true"
                            className="w-12 shrink-0 select-none pr-2 text-right text-muted-foreground"
                          >
                            {line.previousLine}
                          </span>
                          <span
                            aria-hidden="true"
                            className="w-12 shrink-0 select-none pr-2 text-right text-muted-foreground"
                          >
                            {line.currentLine}
                          </span>
                          <span className="w-6 shrink-0 select-none text-center">
                            {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
                          </span>
                          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-4 [overflow-wrap:anywhere]">
                            {line.text.replace(/\r?\n$/, "") || " "}
                          </pre>
                        </div>
                      ),
                    )}
                    {rows.length > 1500 && (
                      <p className="px-5 py-3 text-muted-foreground">
                        {t("historyPanel.diffTruncated")}
                      </p>
                    )}
                  </div>
                )
              ) : (
                <pre className="whitespace-pre-wrap break-words p-5 font-mono text-xs leading-6 [overflow-wrap:anywhere]">
                  {mode === "version" ? history.preview.previous : history.preview.current}
                </pre>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Button variant="outline" onClick={() => entry && void history.select(entry)}>
              {t("historyPanel.retry")}
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/20 px-5 py-4">
          <p className="flex min-w-0 flex-1 items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0" />
            {t("historyPanel.restoreHint")}
          </p>
          <Button
            disabled={history.busy || !history.preview || history.previewLoading}
            onClick={() => entry && void history.restore(entry)}
          >
            {history.busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            {t(history.busy ? "historyPanel.restoring" : "historyPanel.restoreVersion")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
