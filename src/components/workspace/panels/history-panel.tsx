"use client"

import * as React from "react"
import { History, RefreshCw } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  confirmAction,
  cleanupHistory,
  getHistoryStats,
  listSnapshots,
  listTrash,
  previewHistoryCleanup,
  readFile,
  readSnapshotText,
  restoreSnapshot,
  restoreTrash,
  type SnapshotEntry,
  type TrashEntry,
  type HistoryStats,
} from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"

const DEFAULT_SNAPSHOTS_PER_NOTE = 20

export function HistoryPanel({ currentDocPath, onHistoryRestored }: PanelRenderProps) {
  const { t } = useTranslation()
  const [snapshots, setSnapshots] = React.useState<SnapshotEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [cleaning, setCleaning] = React.useState(false)
  const [restoringId, setRestoringId] = React.useState<string | null>(null)
  const [trash, setTrash] = React.useState<TrashEntry[]>([])
  const [historyStats, setHistoryStats] = React.useState<HistoryStats>({
    snapshotCount: 0,
    noteCount: 0,
    sizeBytes: 0,
  })
  const [comparison, setComparison] = React.useState<{
    id: string
    previous: string
    current: string
  } | null>(null)

  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      const [nextSnapshots, nextTrash, nextStats] = await Promise.all([
        currentDocPath ? listSnapshots(currentDocPath) : Promise.resolve([]),
        listTrash(),
        getHistoryStats(),
      ])
      setSnapshots(nextSnapshots)
      setTrash(nextTrash)
      setHistoryStats(nextStats)
    } finally {
      setLoading(false)
    }
  }, [currentDocPath])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  async function restore(entry: SnapshotEntry) {
    if (!(await confirmAction(t("historyPanel.restoreConfirm")))) return
    setRestoringId(entry.id)
    try {
      await restoreSnapshot(entry.id)
      await onHistoryRestored?.()
      await refresh()
    } finally {
      setRestoringId(null)
    }
  }

  async function compare(entry: SnapshotEntry) {
    if (!currentDocPath) return
    const [snapshot, current] = await Promise.all([
      readSnapshotText(entry.id),
      readFile(currentDocPath),
    ])
    setComparison({ id: entry.id, previous: snapshot.content, current })
  }

  async function restoreTrashEntry(entry: TrashEntry) {
    if (!(await confirmAction(t("historyPanel.restoreTrashConfirm", { name: entry.name })))) return
    setRestoringId(entry.id)
    try {
      await restoreTrash(entry.id)
      await onHistoryRestored?.()
      await refresh()
    } finally {
      setRestoringId(null)
    }
  }

  async function cleanup() {
    const retention = { maxSnapshotsPerNote: DEFAULT_SNAPSHOTS_PER_NOTE, maxAgeDays: null }
    const preview = await previewHistoryCleanup(retention)
    if (preview.removedCount === 0) return
    if (
      !(await confirmAction(
        t("historyPanel.cleanupConfirm", {
          keep: DEFAULT_SNAPSHOTS_PER_NOTE,
          count: preview.removedCount,
          size: formatSize(preview.freedBytes),
        }),
      ))
    ) {
      return
    }
    setCleaning(true)
    try {
      await cleanupHistory(retention)
      await refresh()
    } finally {
      setCleaning(false)
    }
  }

  const currentSizeBytes = snapshots.reduce((total, entry) => total + entry.sizeBytes, 0)
  const formatSize = (sizeBytes: number) =>
    t("historyPanel.kilobytes", { count: Math.max(1, Math.ceil(sizeBytes / 1024)) })

  if (!currentDocPath && trash.length === 0 && historyStats.snapshotCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
        <History className="size-8 text-muted-foreground" />
        <p className="text-[12px] text-muted-foreground">{t("historyPanel.openNote")}</p>
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="min-w-0">
          <span className="text-sm font-medium">{t("panels.history")}</span>
          <p className="truncate text-[10px] text-muted-foreground">
            {t("historyPanel.vaultSummary", {
              snapshots: historyStats.snapshotCount,
              notes: historyStats.noteCount,
              size: formatSize(historyStats.sizeBytes),
            })}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void cleanup()}
            disabled={cleaning || historyStats.snapshotCount === 0}
          >
            {cleaning ? t("historyPanel.cleaning") : t("historyPanel.cleanup")}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void refresh()}
            disabled={loading || cleaning}
            title={t("historyPanel.refresh")}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {currentDocPath && snapshots.length > 0 && (
          <p className="border-b px-3 py-2 text-[11px] text-muted-foreground">
            {t("historyPanel.noteSummary", {
              snapshots: snapshots.length,
              size: formatSize(currentSizeBytes),
            })}
          </p>
        )}
        {snapshots.length === 0 && !loading ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            {t("historyPanel.empty")}
          </p>
        ) : (
          <div className="divide-y">
            {snapshots.map((entry) => (
              <div key={entry.id} className="space-y-1.5 px-3 py-3">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span>{new Date(entry.createdAtMs).toLocaleString()}</span>
                  <span className="text-muted-foreground">
                    {t("historyPanel.kilobytes", {
                      count: Math.max(1, Math.ceil(entry.sizeBytes / 1024)),
                    })}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] text-muted-foreground">{entry.reason}</span>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => void compare(entry)}>
                      {t("historyPanel.compare")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void restore(entry)}
                      disabled={restoringId !== null}
                    >
                      {restoringId === entry.id
                        ? t("historyPanel.restoring")
                        : t("historyPanel.restore")}
                    </Button>
                  </div>
                </div>
                {comparison?.id === entry.id && (
                  <div className="grid max-h-72 grid-cols-2 gap-2 overflow-auto rounded border bg-muted/30 p-2 text-[10px] leading-relaxed">
                    <div>
                      <p className="mb-1 font-medium text-muted-foreground">
                        {t("historyPanel.version")}
                      </p>
                      <pre className="whitespace-pre-wrap break-words">{comparison.previous}</pre>
                    </div>
                    <div>
                      <p className="mb-1 font-medium text-muted-foreground">
                        {t("historyPanel.current")}
                      </p>
                      <pre className="whitespace-pre-wrap break-words">{comparison.current}</pre>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {trash.length > 0 && (
          <div className="border-t">
            <p className="px-3 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("historyPanel.trash")}
            </p>
            {trash.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between gap-2 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-xs">{entry.name}</p>
                  <p className="truncate text-[10px] text-muted-foreground">{entry.originalPath}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void restoreTrashEntry(entry)}
                  disabled={restoringId !== null}
                >
                  {restoringId === entry.id
                    ? t("historyPanel.restoring")
                    : t("historyPanel.return")}
                </Button>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
