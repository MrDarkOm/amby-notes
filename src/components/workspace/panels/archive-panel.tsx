"use client"

import * as React from "react"
import { Archive, Loader2, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { confirmAction, listTrash, purgeTrash, restoreTrash, type TrashEntry } from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"

export function ArchivePanel(_props: PanelRenderProps) {
  const { t } = useTranslation()
  const [entries, setEntries] = React.useState<TrashEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string | null>(null)
  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      setEntries(await listTrash())
    } finally {
      setLoading(false)
    }
  }, [])
  React.useEffect(() => void refresh(), [refresh])
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
      <header className="flex items-center gap-2 border-b px-4 py-4 text-sm font-semibold">
        <Archive className="size-4 text-muted-foreground" />
        {t("panels.archive")}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {loading ? (
          <p className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </p>
        ) : entries.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {t("historyPanel.archiveEmpty")}
          </p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 border-b py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{entry.name}</p>
                <p className="truncate text-[10px] text-muted-foreground">{entry.originalPath}</p>
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
