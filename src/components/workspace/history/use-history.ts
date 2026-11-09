import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  cleanupHistory,
  deleteSnapshot,
  getHistoryStats,
  isTauri,
  listSnapshots,
  previewHistoryCleanup,
  readFile,
  readSnapshotText,
  restoreSnapshot,
  type HistoryStats,
  type SnapshotEntry,
} from "@/lib/storage"
import {
  resolveSyncPort,
  type NoteServerVersions,
  type RestoreVersionStatus,
  type ServerVersionState,
  type ServerVersionView,
} from "@/lib/sync/sync-port"
import { listen } from "@tauri-apps/api/event"
import { adoptAsyncDisposer } from "@/lib/async-disposable"
import { confirm } from "@/lib/confirm"
import { confirmations } from "@/lib/confirmations"
import { errorType, logger } from "@/lib/logger"
import { flushAutosaveGeneration } from "../autosave/autosave-lifecycle"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { formatHistorySize } from "./history-model"

const RETENTION = { maxSnapshotsPerNote: 0, maxAgeDays: null }

export function useHistory(path: string | null | undefined, onRestored?: () => Promise<void>) {
  const { t, i18n } = useTranslation()
  const [snapshots, setSnapshots] = React.useState<SnapshotEntry[]>([])
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
  // The server part of the list (appendix И): asked for when the panel opens and after a restore,
  // never by itself (И4).
  const port = React.useMemo(() => resolveSyncPort(), [])
  const [server, setServer] = React.useState<NoteServerVersions | null>(null)
  const [selectedServer, setSelectedServer] = React.useState<ServerVersionView | null>(null)
  const [serverPreview, setServerPreview] = React.useState<ServerVersionState | null>(null)
  const [serverRestoreStatus, setServerRestoreStatus] = React.useState<RestoreVersionStatus | null>(
    null,
  )
  const serverRequest = React.useRef(0)
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
      const [versions, usage] = await Promise.all([
        path ? listSnapshots(path) : Promise.resolve([]),
        getHistoryStats(),
      ])
      if (!mounted.current || request !== refreshId.current) return
      setSnapshots([...versions].sort((a, b) => b.createdAtMs - a.createdAtMs))
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

  React.useEffect(() => {
    if (!isTauri()) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refresh(), 250)
    }
    const disposers = [
      listen("amby:note-written", schedule),
      listen("amby:files-changed", schedule),
      listen("amby:database-written", schedule),
      listen("vault-file-changed", schedule),
    ].map((registration) =>
      adoptAsyncDisposer(registration, (error) =>
        logger.warn("history.change_listen_failed", { errorType: errorType(error) }),
      ),
    )
    return () => {
      if (timer) clearTimeout(timer)
      for (const dispose of disposers) dispose()
    }
  }, [refresh])

  const loadServer = React.useCallback(async () => {
    const request = ++serverRequest.current
    if (!path) {
      setServer(null)
      return
    }
    let next: NoteServerVersions
    try {
      next = await port.noteVersions(path)
    } catch (cause) {
      // Not an error for the person (И4): the same calm line as for a lost connection.
      logger.warn("history.server_versions_failed", { errorType: errorType(cause) })
      next = { available: false, reason: "offline", versions: [] }
    }
    if (mounted.current && request === serverRequest.current) setServer(next)
  }, [path, port])

  React.useEffect(() => {
    void loadServer()
  }, [loadServer])

  async function select(entry: SnapshotEntry | null) {
    const request = ++previewId.current
    setSelectedServer(null)
    setServerPreview(null)
    setServerRestoreStatus(null)
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

  function cleanup() {
    return action(async (isCurrent) => {
      if (!path) return
      const preview = await previewHistoryCleanup(RETENTION, path)
      if (!isCurrent()) return
      if (!preview.removedCount) {
        setNotice(t("historyPanel.nothingToClean"))
        return
      }
      if (
        !(await confirm(
          confirmations.cleanHistory({
            count: preview.removedCount,
            size: formatHistorySize(preview.freedBytes, i18n.language),
          }),
        )) ||
        !isCurrent()
      )
        return
      const result = await cleanupHistory(RETENTION, path)
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

  function removeSnapshot(entry: SnapshotEntry) {
    return action(async (isCurrent) => {
      if (!(await confirm(confirmations.deleteVersion())) || !isCurrent()) return
      await deleteSnapshot(entry.id)
      if (!isCurrent()) return
      void select(null)
      await refresh()
      if (isCurrent()) setNotice(t("historyPanel.versionDeleted"))
    })
  }

  function openLatest() {
    const latest = snapshots[0]
    const latestServer = server?.available ? server.versions[0] : undefined
    if (latestServer && (!latest || latestServer.committedMs > latest.createdAtMs)) {
      void selectServer(latestServer)
    } else if (latest) void select(latest)
    else {
      setError("")
      setNotice(t("historyPanel.empty"))
    }
  }

  function clearAll() {
    return action(async (isCurrent) => {
      const preview = await previewHistoryCleanup({ maxSnapshotsPerNote: 0, maxAgeDays: null })
      if (!isCurrent() || !preview.removedCount) return
      if (
        !(await confirm(
          confirmations.clearHistory({
            count: preview.removedCount,
            size: formatHistorySize(preview.freedBytes, i18n.language),
          }),
        )) ||
        !isCurrent()
      )
        return
      await cleanupHistory({ maxSnapshotsPerNote: 0, maxAgeDays: null })
      if (!isCurrent()) return
      await refresh()
      setNotice(t("historyPanel.historyCleared"))
    })
  }

  /** Selects a version from the server for the preview (И5); `null` clears the choice. */
  async function selectServer(version: ServerVersionView | null) {
    const request = ++previewId.current
    setSelected(null)
    setSelectedServer(version)
    setServerPreview(null)
    setServerRestoreStatus(null)
    setPreview(null)
    setPreviewLoading(Boolean(version))
    setError("")
    if (!version || !path) return
    try {
      const [text, current] = await Promise.all([
        port.readServerVersion(path, version.itemId, version.version),
        readFile(path),
      ])
      if (!mounted.current || request !== previewId.current) return
      if (text.state === "ok" && text.content !== null) {
        setPreview({ previous: text.content, current })
        setServerPreview("ok")
      } else {
        // Damaged, too large, no connection — or bytes that are not text: nothing to show.
        setServerPreview(text.state === "ok" ? "damaged" : text.state)
      }
    } catch (cause) {
      if (request === previewId.current) report(cause, "historyPanel.previewFailed")
    } finally {
      if (mounted.current && request === previewId.current) setPreviewLoading(false)
    }
  }

  /** "Вернуть" for a version from the server (И6). */
  function restoreServer(version: ServerVersionView) {
    return action(async (isCurrent) => {
      setServerRestoreStatus(null)
      const before = useDocStore.getState()
      const open = Object.values(before.openDocs).find((doc) => doc.path === path)
      const hadUnsaved = Boolean(open && before.unsavedFileIds.has(open.id))
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
      // The hash of the file when the list was shown (И6). Text of the person's own that the
      // save above has just written changed the file on purpose, so the hash is read again then.
      const shown = hadUnsaved && path ? await port.noteVersions(path) : server
      if (!isCurrent()) return
      const expected = shown?.currentHash ?? ""
      const outcome = await port.restoreServerVersion(
        path ?? "",
        version.itemId,
        version.version,
        expected,
      )
      if (!isCurrent()) return
      if (outcome.status === "restored") {
        await onRestored?.()
        if (!isCurrent()) return
        void select(null)
        await refresh()
        await loadServer()
        if (isCurrent()) setNotice(t("historyPanel.restored"))
        return
      }
      setServerRestoreStatus(outcome.status)
      if (outcome.status === "noteChanged") {
        await refresh()
        await loadServer()
      }
    })
  }

  return {
    server,
    selectedServer,
    serverPreview,
    serverRestoreStatus,
    selectServer,
    restoreServer,
    snapshots,
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
    cleanup,
    removeSnapshot,
    clearAll,
    openLatest,
  }
}
