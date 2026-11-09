"use client"

import * as React from "react"
import { Archive, Eye, Loader2, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { MotionSpinner } from "@/lib/motion"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { confirm } from "@/lib/confirm"
import { confirmations } from "@/lib/confirmations"
import { listTrash, purgeTrash, restoreTrash, type TrashEntry } from "@/lib/storage"
import { dispatchArchiveChanged } from "../use-archive-tree-refresh"
import { mutationPaths } from "../workspace-mutations"
import type { PanelRenderProps } from "../panel-registry"
import { TreeIcon } from "../tree/tree-icons"
import { ArchivePreview } from "./archive-preview"
import { ArchiveServerSection } from "./archive-server-section"
import { archiveEntryLabel, groupArchiveEntries } from "./archive-model"
import { PanelHeader, PanelSearch } from "./panel-header"

export function ArchivePanel({ vault }: PanelRenderProps) {
  return <ArchiveContents key={vault ?? ""} />
}

function ArchiveContents() {
  const { t, i18n } = useTranslation()
  const [entries, setEntries] = React.useState<TrashEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState("")
  const [previewEntry, setPreviewEntry] = React.useState<TrashEntry | null>(null)
  const previewOpening = React.useRef(false)
  const [openMenuId, setOpenMenuId] = React.useState<string | null>(null)
  // Close autofocus runs after a menu unmounts; it must see the newest target.
  const menuTarget = React.useRef<string | null>(null)
  function changeMenu(id: string, open: boolean) {
    if (open) {
      menuTarget.current = id
      setOpenMenuId(id)
    } else if (menuTarget.current === id) {
      menuTarget.current = null
      setOpenMenuId(null)
    }
  }
  function showPreview(entry: TrashEntry) {
    setError(null)
    previewOpening.current = true
    menuTarget.current = null
    setOpenMenuId(null)
    setPreviewEntry(entry)
  }
  function closePreview() {
    previewOpening.current = false
    setPreviewEntry(null)
  }
  const [error, setError] = React.useState<string | null>(null)
  const [now, setNow] = React.useState(() => new Date())
  const request = React.useRef({ sequence: 0 })
  const actionInFlight = React.useRef(false)
  const refresh = React.useCallback(async () => {
    const sequence = ++request.current.sequence
    try {
      const next = await listTrash()
      if (sequence === request.current.sequence) {
        setEntries(next)
        setError(null)
      }
    } catch {
      if (sequence === request.current.sequence) setError(t("archivePanel.loadFailed"))
    } finally {
      if (sequence === request.current.sequence) setLoading(false)
    }
  }, [t])
  React.useEffect(() => {
    const tracker = request.current
    void refresh()
    const handleTrashChanged = () => void refresh()
    window.addEventListener("amby:archive-changed", handleTrashChanged)
    return () => {
      tracker.sequence++
      window.removeEventListener("amby:archive-changed", handleTrashChanged)
    }
  }, [refresh])
  React.useEffect(() => {
    const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const timer = window.setTimeout(
      () => setNow(new Date()),
      Math.max(0, nextDay.getTime() - Date.now()) + 100,
    )
    return () => window.clearTimeout(timer)
  }, [now])
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleEntries = entries.filter((entry) =>
    `${entry.name} ${entry.originalPath}`.toLocaleLowerCase().includes(normalizedQuery),
  )
  const groups = groupArchiveEntries(visibleEntries, now)
  const locale = i18n.resolvedLanguage ?? i18n.language
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" })
  const dateFormat = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" })
  const fullDateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" })
  async function runAction(entry: TrashEntry, action: "restore" | "purge") {
    if (actionInFlight.current) return
    actionInFlight.current = true
    menuTarget.current = null
    setOpenMenuId(null)
    setBusy(entry.id)
    setError(null)
    try {
      if (
        action === "purge" &&
        !(await confirm(confirmations.deleteArchived({ name: archiveEntryLabel(entry).title })))
      )
        return
      if (action === "restore") {
        const restored = await restoreTrash(entry.id)
        // The note is back: the tree shows it without reloading the vault.
        dispatchArchiveChanged({ paths: mutationPaths(restored) })
      } else await purgeTrash(entry.id)
      closePreview()
      await refresh()
    } catch {
      setError(t(action === "restore" ? "archivePanel.restoreFailed" : "archivePanel.deleteFailed"))
    } finally {
      actionInFlight.current = false
      setBusy(null)
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <PanelHeader
        title={t("panels.archive")}
        actions={
          !loading && (
            <span className="text-[10px] font-normal text-muted-foreground">{entries.length}</span>
          )
        }
      />
      {entries.length > 0 && (
        <PanelSearch
          value={query}
          onChange={setQuery}
          ariaLabel={t("historyPanel.searchArchive")}
          placeholder={t("historyPanel.searchArchive")}
        />
      )}
      {error && (
        <div role="alert" className="px-4 pb-3 text-xs text-destructive">
          <p>{error}</p>
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void refresh()}>
            {t("historyPanel.refresh")}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {loading ? (
          <p className="flex justify-center py-10 text-muted-foreground">
            <MotionSpinner>
              <Loader2 className="size-4" />
            </MotionSpinner>
          </p>
        ) : entries.length === 0 ? (
          !error && (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
              <Archive className="size-7" />
              <p className="text-xs">{t("historyPanel.archiveEmpty")}</p>
            </div>
          )
        ) : visibleEntries.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {t("historyPanel.noResults")}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="mb-3" aria-label={t(`archivePanel.${group.key}`)}>
              <h3 className="px-2 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">
                {t(`archivePanel.${group.key}`)}
              </h3>
              <div className="space-y-0.5">
                {group.entries.map((entry) => {
                  const { title, parent, icon } = archiveEntryLabel(entry)
                  const date = new Date(entry.deletedAtMs)
                  const validDate = Number.isFinite(date.getTime())
                  const fullDate = validDate
                    ? fullDateFormat.format(date)
                    : t("archivePanel.unknownDate")
                  const shortDate = !validDate
                    ? t("archivePanel.unknownDate")
                    : group.key !== "earlier"
                      ? timeFormat.format(date)
                      : date.getFullYear() === now.getFullYear()
                        ? dateFormat.format(date)
                        : new Intl.DateTimeFormat(locale, {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          }).format(date)
                  return (
                    <div
                      key={entry.id}
                      className="group relative flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-accent/40"
                    >
                      {icon ? (
                        <TreeIcon
                          icon={icon}
                          className="mr-1 self-start mt-0.5 text-muted-foreground"
                        />
                      ) : (
                        <Archive className="mr-1 mt-0.5 size-4 shrink-0 self-start text-muted-foreground" />
                      )}
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => showPreview(entry)}
                        disabled={busy !== null}
                        aria-label={t("archivePanel.previewEntry", { name: title })}
                      >
                        <p className="truncate text-xs leading-4" title={entry.name}>
                          {title}
                        </p>
                        <div className="flex min-w-0 items-center gap-2 text-[10px] leading-4 text-muted-foreground">
                          <span className="min-w-0 flex-1 truncate" title={entry.originalPath}>
                            {parent || t("archivePanel.vaultRoot")}
                          </span>
                          <time
                            className="min-w-0 truncate"
                            dateTime={validDate ? date.toISOString() : undefined}
                            title={t("archivePanel.archivedAt", { date: fullDate })}
                          >
                            {shortDate}
                          </time>
                        </div>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="absolute inset-y-0 right-10 my-auto bg-background opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 disabled:opacity-50"
                        disabled={busy !== null}
                        title={t("archivePanel.restoreEntry", { name: title })}
                        aria-label={t("archivePanel.restoreEntry", { name: title })}
                        onClick={() => void runAction(entry, "restore")}
                      >
                        {busy === entry.id ? (
                          <MotionSpinner>
                            <Loader2 className="size-3.5" />
                          </MotionSpinner>
                        ) : (
                          <RotateCcw className="size-3.5" />
                        )}
                      </Button>
                      <DropdownMenu
                        modal={false}
                        open={openMenuId === entry.id}
                        onOpenChange={(open) => changeMenu(entry.id, open)}
                      >
                        <DropdownMenuTrigger asChild>
                          <Button
                            // Radix handles Enter; Motion's synthetic press would toggle it again.
                            whileTap={undefined}
                            variant="ghost"
                            size="icon-sm"
                            disabled={busy !== null}
                            title={t("historyPanel.actions")}
                            aria-label={t("archivePanel.entryActions", { name: title })}
                          >
                            <MoreHorizontal className="size-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="min-w-[12rem]"
                          onCloseAutoFocus={(event) => {
                            if (
                              previewOpening.current ||
                              (menuTarget.current !== null && menuTarget.current !== entry.id)
                            ) {
                              event.preventDefault()
                            }
                          }}
                        >
                          <DropdownMenuItem onSelect={() => showPreview(entry)}>
                            <Eye />
                            {t("archivePanel.preview")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void runAction(entry, "restore")}>
                            <RotateCcw />
                            {t("historyPanel.return")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => void runAction(entry, "purge")}
                          >
                            <Trash2 />
                            {t("historyPanel.deleteForever")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )
                })}
              </div>
            </section>
          ))
        )}
        <ArchiveServerSection />
      </div>
      {previewEntry && (
        <ArchivePreview
          key={previewEntry.id}
          entry={previewEntry}
          busy={busy !== null}
          actionError={error}
          onClose={closePreview}
          onRestore={() => void runAction(previewEntry, "restore")}
        />
      )}
    </div>
  )
}
