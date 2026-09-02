import * as React from "react"
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
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
import type { TreeItem } from "@/lib/storage"
import { Input } from "@/components/ui/input"
import { IconValue } from "../icon-value"
import { diffHistory } from "./history-model"
import type { useHistory } from "./use-history"

export function HistoryPreview({
  history,
  name,
  treeItems,
  onSelect,
}: {
  history: ReturnType<typeof useHistory>
  name: string
  treeItems: TreeItem[]
  onSelect: (id: string) => void
}) {
  const { t, i18n } = useTranslation()
  const diff = React.useMemo(
    () => (history.preview ? diffHistory(history.preview.previous, history.preview.current) : null),
    [history.preview],
  )
  const entry = history.selected
  const [browseOpen, setBrowseOpen] = React.useState(false)
  const [expandedFolders, setExpandedFolders] = React.useState<Set<string>>(new Set())
  const [browseQuery, setBrowseQuery] = React.useState("")
  const visibleTree = React.useCallback(
    (items: TreeItem[]): TreeItem[] => {
      const query = browseQuery.trim().toLocaleLowerCase()
      let sortKey: "name" | "created" | "modified" = "name"
      let direction: "asc" | "desc" = "asc"
      try {
        const saved = JSON.parse(localStorage.getItem("amby:tree-sort") ?? "{}") as {
          key?: string
          direction?: string
        }
        if (saved.key === "created" || saved.key === "modified") sortKey = saved.key
        if (saved.direction === "desc") direction = "desc"
      } catch {
        /* use defaults */
      }
      const multiplier = direction === "asc" ? 1 : -1
      const sorted = [...items].sort((a, b) => {
        const rank = (item: TreeItem) =>
          item.type === "folder" || (item.type === "file" && Boolean(item.children?.length)) ? 0 : 1
        const kind = rank(a) - rank(b)
        if (kind) return kind
        const result =
          sortKey === "name"
            ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
            : (a[sortKey] ?? 0) - (b[sortKey] ?? 0)
        return (
          result * multiplier || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        )
      })
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
            className="flex w-full items-center gap-1 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            onClick={() =>
              folder
                ? setExpandedFolders((current) => {
                    const next = new Set(current)
                    if (expanded) next.delete(item.id)
                    else next.add(item.id)
                    return next
                  })
                : (onSelect(item.id), setBrowseOpen(false), void history.select(null))
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
  return (
    <Dialog
      open={Boolean(entry)}
      onOpenChange={(open) => {
        if (!open && !history.busy) void history.select(null)
      }}
    >
      <DialogContent
        className="flex h-[min(76vh,720px)] min-h-0 max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-white p-0 shadow-2xl sm:max-w-4xl"
        onEscapeKeyDown={(event) => {
          if (history.busy) event.preventDefault()
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <div className="relative bg-white px-5 pb-4 pt-5 pr-12">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <History className="size-4" />
            <span>{t("historyPanel.versionHistory")}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7"
              title={t("historyPanel.openNote")}
              aria-label={t("historyPanel.openNote")}
              onClick={() => setBrowseOpen((open) => !open)}
            >
              <ArrowLeftRight className="size-4" />
            </Button>
            <DialogTitle className="truncate text-xl tracking-tight">{name}</DialogTitle>
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
            <div className="mx-3 mt-2 grid min-h-0 flex-1 grid-cols-[12rem_minmax(0,1fr)] gap-2">
              <aside
                className="min-h-0 overflow-auto rounded-lg border bg-white p-2"
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
                  {history.snapshots.map((snapshot) => (
                    <button
                      key={snapshot.id}
                      type="button"
                      disabled={history.busy}
                      onClick={() => void history.select(snapshot)}
                      className={cn(
                        "w-full rounded-md px-2 py-2 text-left text-xs transition-colors hover:bg-muted",
                        snapshot.id === entry?.id && "bg-muted/80 font-medium shadow-none",
                      )}
                    >
                      <span className="block tabular-nums">
                        {new Intl.DateTimeFormat(i18n.language, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(snapshot.createdAtMs)}
                      </span>
                    </button>
                  ))}
                </div>
              </aside>
              <div className="grid min-h-0 min-w-0 grid-cols-2 divide-x overflow-hidden rounded-lg border bg-white">
                <section className="flex min-h-0 flex-col overflow-hidden">
                  <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2 text-xs font-medium">
                    {t("historyPanel.versionFromHistory")}
                  </div>
                  <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 [overflow-wrap:anywhere]">
                    {history.preview.previous}
                  </pre>
                </section>
                <section className="flex min-h-0 flex-col overflow-hidden">
                  <div className="border-b bg-muted/30 px-4 py-2 text-xs font-medium">
                    {t("historyPanel.currentVersion")}
                  </div>
                  <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 [overflow-wrap:anywhere]">
                    {history.preview.current}
                  </pre>
                </section>
              </div>
            </div>
            {diff.simplified && (
              <p className="px-5 py-2 text-xs text-muted-foreground">
                {t("historyPanel.simplifiedDiff")}
              </p>
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Button variant="outline" onClick={() => entry && void history.select(entry)}>
              {t("historyPanel.retry")}
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-white px-6 py-3">
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
            disabled={history.busy || !history.preview || history.previewLoading}
            onClick={() => entry && void history.removeSnapshot(entry)}
          >
            <Trash2 />
          </Button>
          <Button
            disabled={history.busy || !history.preview || history.previewLoading}
            onClick={() => entry && void history.restore(entry)}
          >
            {history.busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            {t(history.busy ? "historyPanel.restoring" : "historyPanel.restoreVersion")}
          </Button>
        </div>
      </DialogContent>
      <Dialog open={browseOpen} onOpenChange={setBrowseOpen}>
        <DialogContent
          showCloseButton={false}
          className="w-[min(30rem,calc(100%-2rem))] overflow-hidden rounded-xl bg-white p-0"
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
                  className="h-7 rounded-none border-0 bg-transparent pl-8 text-xs shadow-none focus-visible:ring-0"
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
