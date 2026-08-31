"use client"

import * as React from "react"
import {
  ChevronRight,
  Clock3,
  FileClock,
  History,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  onHistoryRestored,
}: PanelRenderProps) {
  const { t, i18n } = useTranslation()
  const history = useHistory(currentDocPath, onHistoryRestored)
  const [section, setSection] = React.useState<"versions" | "trash">("versions")
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
  const deleted = history.trash.filter((entry) =>
    `${entry.name} ${entry.originalPath}`.toLocaleLowerCase(locale).includes(search),
  )
  const groups = groupHistoryByDay(versions.slice(0, limit))
  const count = section === "versions" ? versions.length : deleted.length
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
          <History className="size-4 text-muted-foreground" />
          {t("panels.history")}
        </h2>
        <div className="flex shrink-0 items-center gap-0.5">
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                title={t("historyPanel.manage")}
                aria-label={t("historyPanel.manage")}
                disabled={history.busy}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={history.loading || !history.stats.snapshotCount}
                onSelect={() => void history.cleanup()}
              >
                <Trash2 className="mr-2 size-4" />
                {t("historyPanel.cleanupOld")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <div
        className="mx-3 mb-3 flex shrink-0 gap-1 rounded-lg bg-muted/60 p-1"
        role="group"
        aria-label={t("historyPanel.sections")}
      >
        {(["versions", "trash"] as const).map((value) => (
          <button
            key={value}
            aria-pressed={section === value}
            onClick={() => {
              setSection(value)
              setQuery("")
              setLimit(PAGE_SIZE)
            }}
            className={cn(
              "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              section === value
                ? "bg-[var(--note-surface)] font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`historyPanel.${value}`)}
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {value === "versions" ? history.snapshots.length : history.trash.length}
            </span>
          </button>
        ))}
      </div>
      <div className="space-y-3 border-b px-4 pb-3">
        <div className="flex min-w-0 items-start gap-2.5">
          {section === "versions" ? (
            <FileClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Trash2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <p
              className="truncate text-xs font-medium"
              title={section === "versions" ? (currentDocPath ?? undefined) : undefined}
            >
              {section === "versions" ? name : t("historyPanel.deletedFiles")}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {section === "versions"
                ? t("historyPanel.versionsHint")
                : t("historyPanel.trashHint")}
            </p>
          </div>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setLimit(PAGE_SIZE)
            }}
            aria-label={t(
              section === "versions" ? "historyPanel.searchVersions" : "historyPanel.searchTrash",
            )}
            placeholder={t(
              section === "versions" ? "historyPanel.searchVersions" : "historyPanel.searchTrash",
            )}
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
                  : section === "trash"
                    ? "historyPanel.trashEmpty"
                    : currentDocPath
                      ? "historyPanel.empty"
                      : "historyPanel.openNote",
              )}
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t(
                search
                  ? "historyPanel.searchHint"
                  : section === "trash"
                    ? "historyPanel.trashEmptyHint"
                    : "historyPanel.emptyHint",
              )}
            </p>
          </div>
        ) : section === "versions" ? (
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
        ) : (
          <div className="divide-y divide-border/60">
            {deleted.slice(0, limit).map((entry) => (
              <div key={entry.id} className="flex min-w-0 items-center gap-2 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium" title={entry.name}>
                    {entry.name}
                  </p>
                  <p
                    className="mt-1 truncate text-[10px] text-muted-foreground"
                    title={entry.originalPath}
                  >
                    {entry.originalPath}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {dateFormat.format(entry.deletedAtMs)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title={t("historyPanel.return")}
                  aria-label={t("historyPanel.returnNamed", { name: entry.name })}
                  disabled={history.busy}
                  onClick={() => void history.returnTrash(entry)}
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
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
      <footer className="flex shrink-0 items-start gap-2 border-t bg-muted/20 px-4 py-3 text-[10px] leading-relaxed text-muted-foreground">
        <Clock3 className="mt-0.5 size-3.5 shrink-0" />
        <p className="min-w-0 break-words">
          {t("historyPanel.storageUsage", {
            size: formatHistorySize(history.stats.sizeBytes, locale),
          })}
          <br />
          {t("historyPanel.storageCount", {
            snapshots: history.stats.snapshotCount,
            notes: history.stats.noteCount,
          })}
        </p>
      </footer>
      <HistoryPreview history={history} name={name} />
    </div>
  )
}
