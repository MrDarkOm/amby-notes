import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  cleanupHistory,
  confirmAction,
  getHistoryStats,
  listSnapshots,
  listTrash,
  previewHistoryCleanup,
  readFile,
  readSnapshotText,
  restoreSnapshot,
  restoreTrash,
  type HistoryStats,
  type SnapshotEntry,
  type TrashEntry,
} from "@/lib/storage"
import { errorType, logger } from "@/lib/logger"
import { flushAutosaveGeneration } from "../autosave/autosave-lifecycle"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { formatHistorySize } from "./history-model"

const RETENTION = { maxSnapshotsPerNote: 20, maxAgeDays: null }

export function useHistory(path: string | null | undefined, onRestored?: () => Promise<void>) {
  const { t, i18n } = useTranslation()
  const [snapshots, setSnapshots] = React.useState<SnapshotEntry[]>([])
  const [trash, setTrash] = React.useState<TrashEntry[]>([])
  const [stats, setStats] = React.useState<HistoryStats>({
    snapshotCount: 0,
    noteCount: 0,
    sizeBytes: 0,
  })
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [selected, setSelected] = React.useState<SnapshotEntry | null>(null)
  const [preview, setPreview] = React.useState<{ previous: string; current: string } | null>(null)
  const [previewLoading, setPreviewLoading] = React.useState(false)
  const mounted = React.useRef(false)
  const refreshId = React.useRef(0)
  const previewId = React.useRef(0)
  const actionLock = React.useRef(false)

  React.useEffect(() => {
    mounted.current = true
    refreshId.current++
    previewId.current++
    return () => {
      mounted.current = false
    }
  }, [])

  const report = React.useCallback(
    (cause: unknown, key: string) => {
      logger.warn("history.operation_failed", { errorType: errorType(cause) })
      if (mounted.current) setError(t(key))
    },
    [t],
  )

  const refresh = React.useCallback(async () => {
    const request = ++refreshId.current
    setLoading(true)
    setError("")
    try {
      const [versions, deleted, usage] = await Promise.all([
        path ? listSnapshots(path) : Promise.resolve([]),
        listTrash(),
        getHistoryStats(),
      ])
      if (!mounted.current || request !== refreshId.current) return
      setSnapshots([...versions].sort((a, b) => b.createdAtMs - a.createdAtMs))
      setTrash([...deleted].sort((a, b) => b.deletedAtMs - a.deletedAtMs))
      setStats(usage)
    } catch (cause) {
      if (request === refreshId.current) report(cause, "historyPanel.loadFailed")
    } finally {
      if (mounted.current && request === refreshId.current) setLoading(false)
    }
  }, [path, report])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  async function select(entry: SnapshotEntry | null) {
    const request = ++previewId.current
    setSelected(entry)
    setPreview(null)
    setPreviewLoading(Boolean(entry))
    setError("")
    if (!entry || !path) return
    try {
      const [version, current] = await Promise.all([readSnapshotText(entry.id), readFile(path)])
      if (mounted.current && request === previewId.current) {
        setPreview({ previous: version.content, current })
      }
    } catch (cause) {
      if (request === previewId.current) report(cause, "historyPanel.previewFailed")
    } finally {
      if (mounted.current && request === previewId.current) setPreviewLoading(false)
    }
  }

  async function action(run: (isCurrent: () => boolean) => Promise<void>) {
    if (actionLock.current) return
    actionLock.current = true
    setBusy(true)
    setError("")
    setNotice("")
    const generation = useVaultStore.getState().generation
    const isCurrent = () => mounted.current && useVaultStore.getState().generation === generation
    try {
      await run(isCurrent)
    } catch (cause) {
      if (isCurrent()) report(cause, "historyPanel.actionFailed")
    } finally {
      actionLock.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function restore(entry: SnapshotEntry) {
    return action(async (isCurrent) => {
      if (!(await confirmAction(t("historyPanel.restoreConfirm"))) || !isCurrent()) return
      const result = await flushAutosaveGeneration(useVaultStore.getState().generation)
      if (!isCurrent()) return
      const state = useDocStore.getState()
      const document = Object.values(state.openDocs).find((doc) => doc.path === path)
      if (
        !result.flushed ||
        (document &&
          (state.unsavedFileIds.has(document.id) || state.externalConflicts[document.id]))
      ) {
        setError(t("historyPanel.saveFirst"))
        return
      }
      await restoreSnapshot(entry.id)
      if (!isCurrent()) return
      await onRestored?.()
      if (!isCurrent()) return
      void select(null)
      await refresh()
      if (isCurrent()) setNotice(t("historyPanel.restored"))
    })
  }

  function returnTrash(entry: TrashEntry) {
    return action(async (isCurrent) => {
      if (
        !(await confirmAction(t("historyPanel.restoreTrashConfirm", { name: entry.name }))) ||
        !isCurrent()
      )
        return
      await restoreTrash(entry.id)
      if (!isCurrent()) return
      await onRestored?.()
      if (!isCurrent()) return
      await refresh()
      if (isCurrent()) setNotice(t("historyPanel.trashRestored", { name: entry.name }))
    })
  }

  function cleanup() {
    return action(async (isCurrent) => {
      const preview = await previewHistoryCleanup(RETENTION)
      if (!isCurrent()) return
      if (!preview.removedCount) {
        setNotice(t("historyPanel.nothingToClean"))
        return
      }
      if (
        !(await confirmAction(
          t("historyPanel.cleanupConfirm", {
            keep: RETENTION.maxSnapshotsPerNote,
            count: preview.removedCount,
            size: formatHistorySize(preview.freedBytes, i18n.language),
          }),
        )) ||
        !isCurrent()
      )
        return
      const result = await cleanupHistory(RETENTION)
      if (!isCurrent()) return
      void select(null)
      await refresh()
      if (isCurrent())
        setNotice(
          t("historyPanel.cleaned", {
            count: result.removedCount,
            size: formatHistorySize(result.freedBytes, i18n.language),
          }),
        )
    })
  }

  return {
    snapshots,
    trash,
    stats,
    loading,
    busy,
    error,
    notice,
    selected,
    preview,
    previewLoading,
    refresh,
    select,
    restore,
    returnTrash,
    cleanup,
  }
}
