import * as React from "react"
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Cloud,
  FileText,
  FolderOpen,
  History,
  Loader2,
  Search,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { MotionSpinner } from "@/lib/motion"
import type { SnapshotEntry, TreeItem } from "@/lib/storage"
import type {
  NoteServerVersions,
  RestoreVersionStatus,
  ServerVersionView,
} from "@/lib/sync/sync-port"
import { Input } from "@/components/ui/input"
import { IconValue } from "../icon-value"
import { sortTreeItems, type TreeSortDirection, type TreeSortKey } from "../tree-sort"
import { SnapshotModeToggle, SnapshotPreview, type SnapshotMode } from "../common/snapshot-preview"
import { useVaultStore } from "../use-vault-store"
import { diffHistory } from "./history-model"
import { useHistory } from "./use-history"

export function HistoryPreview({
  history,
  name,
  path,
  treeItems,
  onRestored,
}: {
  history: ReturnType<typeof useHistory>
  name: string
  path: string | null | undefined
  treeItems: TreeItem[]
  onRestored?: (path?: string) => Promise<void>
}) {
  const [browsedNote, setBrowsedNote] = React.useState<TreeItem | null>(null)
  if (!history.selected && !history.selectedServer) return null
  const targetPath = browsedNote?.path ?? path
  const close = () => {
    setBrowsedNote(null)
    void history.select(null)
    void history.refresh()
  }
  return (
    <HistoryPreviewContents
      key={targetPath}
      path={targetPath}
      name={browsedNote?.name ?? name}
      initialSnapshotId={browsedNote ? undefined : history.selected?.id}
      initialServer={browsedNote ? undefined : history.selectedServer}
      treeItems={treeItems}
      onSelect={setBrowsedNote}
      onClose={close}
      onRestored={async () => {
        await onRestored?.(targetPath ?? undefined)
        close()
      }}
    />
  )
}

function HistoryPreviewContents({
  path,
  name,
  initialSnapshotId,
  initialServer,
  treeItems,
  onSelect,
  onClose,
  onRestored,
}: {
  path: string | null | undefined
  name: string
  initialSnapshotId?: string
  initialServer?: ServerVersionView | null
  treeItems: TreeItem[]
  onSelect: (item: TreeItem) => void
  onClose: () => void
  onRestored: () => Promise<void>
}) {
  const vault = useVaultStore((state) => state.vault)
  const assets = React.useMemo(
    () => (vault && path ? { vaultPath: vault, notePath: path } : undefined),
    [vault, path],
  )
  const history = useHistory(path, onRestored)
  const opened = React.useRef(false)
  const hadSelection = React.useRef(false)
  const hasSelection = Boolean(history.selected || history.selectedServer)
  React.useEffect(() => {
    if (hasSelection) hadSelection.current = true
    else if (hadSelection.current && !history.busy) onClose()
  }, [hasSelection, history.busy, onClose])
  React.useEffect(() => {
    if (history.loading || opened.current) return
    opened.current = true
    // A choice that is already made (the server version pressed in the list) is kept.
    if (history.selected || history.selectedServer) return
    if (initialServer) {
      void history.selectServer(initialServer)
      return
    }
    const entry =
      history.snapshots.find((entry) => entry.id === initialSnapshotId) ?? history.snapshots[0]
    if (entry) void history.select(entry)
  }, [history, initialSnapshotId, initialServer])
  const { t, i18n } = useTranslation()
  const diff = React.useMemo(
    () => (history.preview ? diffHistory(history.preview.previous, history.preview.current) : null),
    [history.preview],
  )
  const entry = history.selected
  const chosenServer = history.selectedServer
  const rows = React.useMemo(
    () => mergedRows(history.snapshots, history.server),
    [history.snapshots, history.server],
  )
  const serverMessage =
    history.serverPreview === "damaged"
      ? t("historyPanel.serverDamaged")
      : history.serverPreview === "tooLarge"
        ? t("historyPanel.serverTooLarge")
        : history.serverPreview === "offline"
          ? t("historyPanel.serverPreviewOffline")
          : null
  const restoreResult = restoreResultKey(history.serverRestoreStatus)
  const [previewMode, setPreviewMode] = React.useState<SnapshotMode>("read")
  const markdown = /\.md$/iu.test(path ?? name)
  const [browseOpen, setBrowseOpen] = React.useState(false)
  const [expandedFolders, setExpandedFolders] = React.useState<Set<string>>(new Set())
  const [browseQuery, setBrowseQuery] = React.useState("")
  const visibleTree = React.useCallback(
    (items: TreeItem[]): TreeItem[] => {
      const query = browseQuery.trim().toLocaleLowerCase()
      let sortKey: TreeSortKey = "name"
      let direction: TreeSortDirection = "asc"
      try {
        const saved = JSON.parse(localStorage.getItem("amby:tree-sort") ?? "{}") as {
          key?: string
          direction?: string
        }
        if (saved.key === "manual" || saved.key === "created" || saved.key === "modified") {
          sortKey = saved.key
        }
        if (saved.direction === "desc") direction = "desc"
      } catch {
        /* use defaults */
      }
      const sorted = sortTreeItems(items, sortKey, direction)
      if (!query) return sorted
      return sorted.flatMap((item) => {
        const children = item.children ? visibleTree(item.children) : []
        return item.name.toLocaleLowerCase().includes(query) || children.length
          ? [{ ...item, children }]
          : []
      })
    },
    [browseQuery],
  )
  const renderTree = (items: TreeItem[], depth = 0): React.ReactNode =>
    items.map((item) => {
      const folder = item.type === "folder" || Boolean(item.children?.length)
      const expanded = expandedFolders.has(item.id)
      return (
        <React.Fragment key={item.id}>
          <button
            type="button"
            className="amby-density-inline-padding-left flex w-full items-center gap-1 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
            style={
              {
                paddingLeft: `${8 + depth * 12}px`,
                "--amby-density-padding-left": `${8 + depth * 12}px`,
              } as React.CSSProperties
            }
            disabled={history.busy || (!folder && !item.path)}
            onClick={() =>
              folder
                ? setExpandedFolders((current) => {
                    const next = new Set(current)
                    if (expanded) next.delete(item.id)
                    else next.add(item.id)
                    return next
                  })
                : (onSelect(item), setBrowseOpen(false))
            }
          >
            {folder ? (
              <>
                {expanded ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                <IconValue
                  value={
                    item.icon && !["file", "folder", "canvas"].includes(item.icon)
                      ? item.icon
                      : undefined
                  }
                  fallback={<FolderOpen className="size-4 text-muted-foreground" />}
                  className="size-4"
                />
              </>
            ) : (
              <IconValue
                value={
                  item.icon && !["file", "folder", "canvas"].includes(item.icon)
                    ? item.icon
                    : undefined
                }
                fallback={<FileText className="size-4 text-muted-foreground" />}
                className="size-4"
              />
            )}
            <span className="truncate">{item.name}</span>
          </button>
          {folder && expanded && item.children ? renderTree(item.children, depth + 1) : null}
        </React.Fragment>
      )
    })
  const formatWhen = (ms: number) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(ms)
  const serverDeviceLabel = (version: ServerVersionView) =>
    version.deviceName ??
    t(
      version.device === "thisDevice"
        ? "historyPanel.serverThisDevice"
        : "historyPanel.serverOtherDevice",
    )
  const versionList = (
    <aside
      className="max-h-28 min-h-0 overflow-auto rounded-lg border bg-background p-2 sm:max-h-none"
      aria-label={t("historyPanel.versionHistory")}
    >
      <div className="mb-2 flex items-center justify-between px-2 text-xs font-medium text-muted-foreground">
        <span className="flex items-center gap-2">
          <FolderOpen className="size-3.5" />
          {t("historyPanel.versions")}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 text-muted-foreground"
          title={t("historyPanel.clearNoteHistory")}
          aria-label={t("historyPanel.clearNoteHistory")}
          onClick={() => void history.cleanup()}
          disabled={history.busy}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div className="space-y-1">
        {rows.map((row) =>
          row.source === "local" ? (
            <div key={row.snapshot.id} data-testid="history-row" data-source="local">
              <button
                type="button"
                disabled={history.busy}
                onClick={() => void history.select(row.snapshot)}
                className={cn(
                  "w-full rounded-md px-2 py-2 text-left text-xs hover:bg-muted",
                  row.snapshot.id === entry?.id && "bg-muted/80 font-medium shadow-none",
                )}
              >
                <span className="block tabular-nums">{formatWhen(row.at)}</span>
              </button>
            </div>
          ) : (
            <div
              key={`server-${row.version.itemId}-${row.version.version}`}
              data-testid="history-row"
              data-source="server"
            >
              <button
                type="button"
                disabled={history.busy}
                onClick={() => void history.selectServer(row.version)}
                className={cn(
                  "w-full rounded-md px-2 py-2 text-left text-xs hover:bg-muted",
                  chosenServer?.itemId === row.version.itemId &&
                    chosenServer.version === row.version.version &&
                    "bg-muted/80 font-medium shadow-none",
                )}
              >
                <span className="flex items-center gap-1 tabular-nums">
                  <Cloud
                    role="img"
                    aria-label={t("historyPanel.fromServer")}
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  {formatWhen(row.at)}
                </span>
                <span className="block truncate text-[11px] font-normal text-muted-foreground">
                  {serverDeviceLabel(row.version)}
                </span>
                {!sameNote(path, row.version.path) && (
                  <span className="block truncate text-[11px] font-normal text-muted-foreground">
                    {t("historyPanel.serverWasNamed", { path: row.version.path })}
                  </span>
                )}
              </button>
            </div>
          ),
        )}
        {history.server && !history.server.available && (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">
            {t(
              history.server.reason === "syncOff"
                ? "historyPanel.serverNeedsSync"
                : "historyPanel.serverOffline",
            )}
          </p>
        )}
      </div>
    </aside>
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !history.busy) onClose()
      }}
    >
      <DialogContent
        className="flex h-[min(76vh,720px)] min-h-0 max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-background p-0 shadow-2xl sm:max-w-4xl"
        onEscapeKeyDown={(event) => {
          if (history.busy) event.preventDefault()
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <div className="relative bg-background px-5 pb-4 pt-5 pr-12">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <History className="size-4" />
            <span>{t("historyPanel.versionHistory")}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7"
              title={t("historyPanel.selectNote")}
              aria-label={t("historyPanel.selectNote")}
              disabled={history.busy}
              onClick={() => setBrowseOpen((open) => !open)}
            >
              <ArrowLeftRight className="size-4" />
            </Button>
            <DialogTitle className="truncate text-xl tracking-tight">{name}</DialogTitle>
          </div>
        </div>
        {history.preview && markdown && (
          <div className="flex justify-end px-4 pb-2">
            <SnapshotModeToggle value={previewMode} onChange={setPreviewMode} />
          </div>
        )}
        {history.error && (
          <p role="alert" className="border-b px-5 py-3 text-xs text-destructive">
            {history.error}
          </p>
        )}
        {history.loading || history.previewLoading ? (
          <div
            role="status"
            className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <MotionSpinner>
              <Loader2 className="size-4" />
            </MotionSpinner>
            {t("historyPanel.loadingVersion")}
          </div>
        ) : diff && history.preview ? (
          <>
            <div className="mx-3 mt-2 grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:grid-rows-1">
              {versionList}
              <div className="grid min-h-0 min-w-0 grid-cols-1 grid-rows-2 divide-y overflow-hidden rounded-lg border bg-background md:grid-cols-2 md:grid-rows-1 md:divide-x md:divide-y-0">
                <section className="flex min-h-0 flex-col overflow-hidden">
                  <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2 text-xs font-medium">
                    {t("historyPanel.versionFromHistory")}
                  </div>
                  <div className="amby-snapshot-pane min-h-0 flex-1 overflow-auto">
                    <SnapshotPreview
                      content={history.preview.previous}
                      mode={previewMode}
                      markdown={markdown}
                      assets={assets}
                    />
                  </div>
                </section>
                <section className="flex min-h-0 flex-col overflow-hidden">
                  <div className="border-b bg-muted/30 px-4 py-2 text-xs font-medium">
                    {t("historyPanel.currentVersion")}
                  </div>
                  <div className="amby-snapshot-pane min-h-0 flex-1 overflow-auto">
                    <SnapshotPreview
                      content={history.preview.current}
                      mode={previewMode}
                      markdown={markdown}
                      assets={assets}
                    />
                  </div>
                </section>
              </div>
            </div>
            {diff.simplified && (
              <p className="px-5 py-2 text-xs text-muted-foreground">
                {t("historyPanel.simplifiedDiff")}
              </p>
            )}
            {!diff.identical && (
              <p className="flex gap-3 px-5 py-2 text-xs text-muted-foreground">
                {diff.added > 0 && (
                  <span>
                    {t(
                      diff.added === 1 ? "historyPanel.addedLines_one" : "historyPanel.addedLines",
                      { count: diff.added },
                    )}
                  </span>
                )}
                {diff.removed > 0 && (
                  <span>
                    {t(
                      diff.removed === 1
                        ? "historyPanel.removedLines_one"
                        : "historyPanel.removedLines",
                      { count: diff.removed },
                    )}
                  </span>
                )}
              </p>
            )}
          </>
        ) : serverMessage ? (
          <div className="mx-3 mt-2 grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:grid-rows-1">
            {versionList}
            <div className="flex min-h-0 items-center justify-center rounded-lg border bg-background p-4">
              <p className="text-sm text-muted-foreground">{serverMessage}</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            {history.error ? (
              <Button
                variant="outline"
                onClick={() =>
                  entry
                    ? void history.select(entry)
                    : ((opened.current = false), void history.refresh())
                }
              >
                {t("historyPanel.retry")}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">{t("historyPanel.empty")}</p>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-background px-6 py-3">
          <p className="flex min-w-0 flex-1 items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0" />
            {t("historyPanel.restoreHint")}
          </p>
          <Button
            variant="outline"
            size="icon"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            title={t("historyPanel.deleteVersion")}
            aria-label={t("historyPanel.deleteVersion")}
            disabled={
              history.busy || !history.preview || history.previewLoading || Boolean(chosenServer)
            }
            onClick={() => entry && void history.removeSnapshot(entry)}
          >
            <Trash2 />
          </Button>
          <div className="flex flex-col items-end gap-1">
            <Button
              disabled={history.busy || !history.preview || history.previewLoading}
              onClick={() =>
                chosenServer
                  ? void history.restoreServer(chosenServer)
                  : entry && void history.restore(entry)
              }
            >
              {history.busy ? (
                <MotionSpinner>
                  <Loader2 />
                </MotionSpinner>
              ) : (
                <RotateCcw />
              )}
              {t(history.busy ? "historyPanel.restoring" : "historyPanel.restoreVersion")}
            </Button>
            {restoreResult && (
              <p
                role="status"
                data-testid="history-restore-result"
                className="max-w-72 text-right text-xs text-muted-foreground"
              >
                {t(restoreResult)}
              </p>
            )}
          </div>
        </div>
      </DialogContent>
      <Dialog open={browseOpen} onOpenChange={setBrowseOpen}>
        <DialogContent
          showCloseButton={false}
          className="w-[min(30rem,calc(100%-2rem))] overflow-hidden rounded-xl bg-background p-0"
        >
          <div className="overflow-hidden">
            <div className="flex items-center gap-1 border-b px-4 py-3">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1.5 size-4 text-muted-foreground" />
                <Input
                  autoFocus
                  value={browseQuery}
                  onChange={(event) => setBrowseQuery(event.target.value)}
                  placeholder={t("historyPanel.searchNotes")}
                  className="amby-inset-icon-input h-7 rounded-none border-0 bg-transparent pl-8 text-xs shadow-none focus-visible:ring-0"
                />
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 shrink-0"
                title={t("common.close")}
                aria-label={t("common.close")}
                onClick={() => setBrowseOpen(false)}
              >
                <span className="text-lg leading-none">×</span>
              </Button>
            </div>
            <div className="max-h-[65vh] overflow-auto px-4 py-3">
              {renderTree(visibleTree(treeItems))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  )
}

type ListRow =
  | { source: "local"; at: number; snapshot: SnapshotEntry }
  | { source: "server"; at: number; version: ServerVersionView }

/** One list by time, newest first: local snapshots and versions from the server (И1). */
function mergedRows(snapshots: SnapshotEntry[], server: NoteServerVersions | null): ListRow[] {
  const rows: ListRow[] = [
    ...snapshots.map((snapshot) => ({
      source: "local" as const,
      at: snapshot.createdAtMs,
      snapshot,
    })),
    ...(server?.available
      ? server.versions.map((version) => ({
          source: "server" as const,
          at: version.committedMs,
          version,
        }))
      : []),
  ]
  return rows.sort((a, b) => b.at - a.at)
}

/** Is the version saved under the path the note has now? A renamed note has older names (И2-г). */
function sameNote(notePath: string | null | undefined, versionPath: string): boolean {
  if (!notePath) return true
  const note = notePath.replace(/\\/g, "/")
  return note === versionPath || note.endsWith(`/${versionPath}`)
}

function restoreResultKey(status: RestoreVersionStatus | null): string | null {
  switch (status) {
    case "noteChanged":
      return "historyPanel.serverNoteChanged"
    case "offline":
      return "historyPanel.serverRestoreOffline"
    case "damaged":
      return "historyPanel.serverDamaged"
    case "tooLarge":
      return "historyPanel.serverTooLarge"
    case "syncOff":
      return "historyPanel.serverRestoreSyncOff"
    default:
      return null
  }
}
