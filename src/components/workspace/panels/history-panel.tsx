"use client"

import * as React from "react"
import { ChevronRight, Clock3, History, Loader2, RefreshCw, Search, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { PanelRenderProps } from "../panel-registry"
import { formatHistorySize, groupHistoryByDay, historyReasonKey } from "../history/history-model"
import { HistoryPreview } from "../history/history-preview"
import { useHistory } from "../history/use-history"
import { findTreeItem } from "../workspace-tree-utils"

const PAGE_SIZE = 40

export function HistoryPanel(props: PanelRenderProps) {
  // A document/vault change discards selection and invalidates in-flight reads.
  return <HistoryContents key={`${props.vault}:${props.currentDocPath}`} {...props} />
}

function HistoryContents({
  currentDocPath,
  currentDocId,
  treeItems,
  onSelect,
  onHistoryRestored,
}: PanelRenderProps) {
  const { t, i18n } = useTranslation()
  const history = useHistory(currentDocPath, onHistoryRestored)
  React.useEffect(() => {
    const handler = () => void history.clearAll()
    window.addEventListener("amby:history-clear-all", handler)
    return () => window.removeEventListener("amby:history-clear-all", handler)
  }, [history.clearAll])
  const [query, setQuery] = React.useState("")
  const [limit, setLimit] = React.useState(PAGE_SIZE)
  const locale = i18n.language
  const dateFormat = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  })
  const timeFormat = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
  const name =
    (currentDocId ? findTreeItem(treeItems, currentDocId)?.name : undefined) ??
    currentDocPath?.replace(/\\/g, "/").split("/").pop()?.replace(/\.md$/i, "") ??
    t("historyPanel.noNote")
  const search = query.trim().toLocaleLowerCase(locale)
  const versions = history.snapshots.filter((entry) =>
    `${t(historyReasonKey(entry.reason))} ${dateFormat.format(entry.createdAtMs)} ${timeFormat.format(entry.createdAtMs)}`
      .toLocaleLowerCase(locale)
      .includes(search),
  )
  const groups = groupHistoryByDay(versions.slice(0, limit))
  const count = versions.length
  function dayLabel(date: Date) {
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    if (date.toDateString() === today.toDateString()) return t("historyPanel.today")
    if (date.toDateString() === yesterday.toDateString()) return t("historyPanel.yesterday")
    return dateFormat.format(date)
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between gap-2 px-4 pb-3 pt-4">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          {t("panels.history")}
        </h2>
        <div className="flex shrink-0 items-center gap-0.5">
          {history.snapshots.length > 0 && (
            <Button
              variant="ghost"
              size="icon-sm"
              title={t("historyPanel.openFullHistory")}
              aria-label={t("historyPanel.openFullHistory")}
              disabled={history.loading || history.busy}
              onClick={history.openLatest}
            >
              <Clock3 className="size-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={history.loading || history.busy}
            title={t("historyPanel.refresh")}
            aria-label={t("historyPanel.refresh")}
            onClick={() => void history.refresh()}
          >
            <RefreshCw className={cn("size-3.5", history.loading && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={history.loading || !history.stats.snapshotCount || history.busy}
            title={t("historyPanel.deleteHistory")}
            aria-label={t("historyPanel.deleteHistory")}
            onClick={() => void history.cleanup()}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </header>
      <div className="space-y-3 border-b px-4 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setLimit(PAGE_SIZE)
            }}
            aria-label={t("historyPanel.searchVersions")}
            placeholder={t("historyPanel.searchVersions")}
            className="h-8 min-w-0 bg-transparent pl-8 text-xs"
          />
        </div>
      </div>
      {history.error && !history.selected && (
        <p role="alert" className="shrink-0 border-b px-4 py-3 text-xs text-destructive">
          {history.error}
        </p>
      )}
      {history.notice && (
        <p role="status" className="shrink-0 border-b px-4 py-3 text-xs text-muted-foreground">
          {history.notice}
        </p>
      )}
      <div
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3"
        aria-busy={history.loading}
      >
        {history.error && !count ? (
          <div className="flex justify-center py-8">
            <Button variant="outline" size="sm" onClick={() => void history.refresh()}>
              {t("historyPanel.retry")}
            </Button>
          </div>
        ) : history.loading && !count ? (
          <p
            role="status"
            className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" />
            {t("historyPanel.loading")}
          </p>
        ) : !count ? (
          <div className="flex flex-col items-center gap-3 px-3 py-10 text-center">
            <History className="size-8 text-muted-foreground/50" />
            <p className="text-xs font-medium">
              {t(
                search
                  ? "historyPanel.noResults"
                  : currentDocPath
                    ? "historyPanel.empty"
                    : "historyPanel.openNote",
              )}
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t(search ? "historyPanel.searchHint" : "historyPanel.emptyHint")}
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.date.toDateString()}>
              <h3 className="flex items-center justify-between px-1 pb-2 pt-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <span>{dayLabel(group.date)}</span>
                <span className="tabular-nums">{group.entries.length}</span>
              </h3>
              <div className="ml-2 border-l border-border">
                {group.entries.map((entry) => (
                  <button
                    key={entry.id}
                    disabled={history.busy}
                    onClick={() => void history.select(entry)}
                    aria-label={t("historyPanel.viewVersion", {
                      date: `${dateFormat.format(entry.createdAtMs)}, ${timeFormat.format(entry.createdAtMs)}`,
                    })}
                    className="group relative ml-2 flex w-[calc(100%-0.5rem)] min-w-0 items-center gap-2 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="absolute -left-[13px] top-[19px] size-2 rounded-full border-2 border-border bg-[var(--note-surface)]" />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
                        <span className="font-medium tabular-nums">
                          {timeFormat.format(entry.createdAtMs)}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {formatHistorySize(entry.sizeBytes, locale)}
                        </span>
                      </p>
                      <p className="mt-1 truncate text-[11px] text-muted-foreground">
                        {t(historyReasonKey(entry.reason))}
                      </p>
                    </div>
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50 group-hover:text-foreground" />
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
        {count > limit && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 w-full text-xs"
            onClick={() => setLimit((value) => value + PAGE_SIZE)}
          >
            {t("historyPanel.showMore", { count: count - limit })}
          </Button>
        )}
      </div>
      <footer className="flex shrink-0 items-center gap-1 border-t bg-muted/20 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
        <p className="min-w-0 flex-1 break-words">
          {t("historyPanel.storageVersions", { count: history.stats.snapshotCount })} ·{" "}
          {t("historyPanel.storageNotes", { count: history.stats.noteCount })}
          <br />
          {t("historyPanel.storageSize", {
            size: formatHistorySize(history.stats.sizeBytes, locale),
          })}
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
          title={t("historyPanel.clearAllHistory")}
          aria-label={t("historyPanel.clearAllHistory")}
          disabled={history.busy || !history.stats.snapshotCount}
          onClick={() => void history.clearAll()}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </footer>
      <HistoryPreview history={history} name={name} treeItems={treeItems} onSelect={onSelect} />
    </div>
  )
}
