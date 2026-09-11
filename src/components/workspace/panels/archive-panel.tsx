"use client"

import * as React from "react"
import { Loader2, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { MotionSpinner } from "@/lib/motion"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { confirmAction, listTrash, purgeTrash, restoreTrash, type TrashEntry } from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"
import { PanelHeader, PanelSearch } from "./panel-header"

export function ArchivePanel(_props: PanelRenderProps) {
  const { t } = useTranslation()
  const [entries, setEntries] = React.useState<TrashEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState("")
  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      setEntries(await listTrash())
    } finally {
      setLoading(false)
    }
  }, [])
  React.useEffect(() => void refresh(), [refresh])
  React.useEffect(() => {
    const handleTrashChanged = () => void refresh()
    window.addEventListener("amby:trash-changed", handleTrashChanged)
    return () => window.removeEventListener("amby:trash-changed", handleTrashChanged)
  }, [refresh])
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleEntries = entries.filter((entry) =>
    `${entry.name} ${entry.originalPath}`.toLocaleLowerCase().includes(normalizedQuery),
  )
  async function restore(entry: TrashEntry) {
    setBusy(entry.id)
    try {
      await restoreTrash(entry.id)
      await refresh()
    } finally {
      setBusy(null)
    }
  }
  async function purge(entry: TrashEntry) {
    if (!(await confirmAction(t("historyPanel.deleteForeverConfirm", { name: entry.name })))) return
    setBusy(entry.id)
    try {
      await purgeTrash(entry.id)
      await refresh()
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <PanelHeader title={t("panels.archive")} />
      {entries.length > 0 && (
        <PanelSearch
          value={query}
          onChange={setQuery}
          ariaLabel={t("historyPanel.searchArchive")}
          placeholder={t("historyPanel.searchArchive")}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {loading ? (
          <p className="flex justify-center py-10 text-muted-foreground">
            <MotionSpinner>
              <Loader2 className="size-4" />
            </MotionSpinner>
          </p>
        ) : entries.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {t("historyPanel.archiveEmpty")}
          </p>
        ) : visibleEntries.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {t("historyPanel.noResults")}
          </p>
        ) : (
          visibleEntries.map((entry) => (
            <div key={entry.id} className="flex items-start gap-2 border-b py-3">
              <div className="min-w-0 flex-1">
                <p className="whitespace-normal break-words text-xs font-medium leading-4 [overflow-wrap:anywhere]">
                  {entry.name}
                </p>
                <p className="whitespace-normal break-words text-[10px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
                  {entry.originalPath}
                </p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy !== null}
                    title={t("historyPanel.actions")}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[12rem]">
                  <DropdownMenuItem className="text-[13px]" onSelect={() => void restore(entry)}>
                    <RotateCcw />
                    {t("historyPanel.return")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-[13px] text-destructive"
                    onSelect={() => void purge(entry)}
                  >
                    <Trash2 />
                    {t("historyPanel.deleteForever")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
