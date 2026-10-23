"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Bug, CircleAlert } from "lucide-react"

import { cn } from "@/lib/utils"
import { useSettingsStore } from "./use-settings-store"
import { LogViewerDialog } from "./settings/log-viewer-dialog"
import { useDebugStore } from "./settings/use-debug-store"
import { SyncNoticesHost } from "./sync/sync-notices-host"

export interface WorkspaceShellProps {
  children: React.ReactNode
  className?: string
}

function DebugIndicator() {
  const { t } = useTranslation()
  const enabled = useSettingsStore((s) => s.prefs.debug?.enabled)
  const eventCount = useDebugStore((s) => s.events.length)
  const dropped = useDebugStore((s) => s.status.dropped + (s.status.backend?.dropped ?? 0))
  const [open, setOpen] = React.useState(false)

  if (!enabled) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("settings.debug.statusActive", { count: eventCount })}
        className="fixed bottom-2 right-2 z-50 flex items-center gap-1.5 rounded-full border border-purple-500/40 bg-purple-950/80 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-purple-300 shadow-lg backdrop-blur-sm hover:scale-105 hover:bg-purple-900"
      >
        {dropped > 0 ? (
          <CircleAlert className="size-3 text-amber-300" />
        ) : (
          <Bug className="size-3 text-purple-400" />
        )}
        <span>{t("settings.debug.badgeDebug")}</span>
        {eventCount > 0 && <span className="amby-debug-indicator-count">{eventCount}</span>}
      </button>
      <LogViewerDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

export function WorkspaceShell({ children, className }: WorkspaceShellProps) {
  return (
    <div
      className={cn(
        "relative flex h-screen w-screen select-none flex-col overflow-hidden bg-background text-foreground",
        className,
      )}
    >
      {children}
      <DebugIndicator />
      <SyncNoticesHost />
    </div>
  )
}
