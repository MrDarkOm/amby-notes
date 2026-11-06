import { useTranslation } from "react-i18next"
import { CloudOff, FolderSync, Play, RefreshCw, Settings2, TriangleAlert } from "lucide-react"

import type * as React from "react"
import { ContextMenuTrigger } from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { syncErrorMessage } from "@/lib/sync/sync-errors"
import type { RefreshSync } from "./use-refresh-sync"
import { syncInactiveText, type SyncFixAction, type SyncInactiveReason } from "./sync-inactive"

export interface SyncInactiveMenuContentProps {
  reason: SyncInactiveReason
  /** An action of the menu is running. */
  busy: boolean
  /** The failure of the last action, shown under the reason. */
  error: unknown
  /** Runs an action that is not `settings`. */
  onFix: (action: Exclude<SyncFixAction, "settings">) => void
  /** Reloads the files of the vault (the ordinary refresh of the button). */
  onRefresh: () => void
  onOpenSettings: () => void
  side?: "left" | "right"
}

const ACTION_ICONS = {
  resume: Play,
  reconnect: RefreshCw,
  runNow: RefreshCw,
  refresh: RefreshCw,
  settings: Settings2,
} as const

/** The content of the menu of the sync button while sync does not work. */
export function SyncInactiveMenuContent({
  reason,
  busy,
  error,
  onFix,
  onRefresh,
  onOpenSettings,
  side = "right",
}: SyncInactiveMenuContentProps) {
  const { t } = useTranslation()
  const action = reason.action
  const ActionIcon = action ? ACTION_ICONS[action] : null
  return (
    <DropdownMenuContent side={side} align="start" className="sync-inactive-menu">
      <div className="sync-inactive-title">
        {reason.id === "unavailable" ? (
          <CloudOff aria-hidden="true" />
        ) : (
          <TriangleAlert aria-hidden="true" />
        )}
        {t("sync.inactive.title")}
      </div>
      <p data-testid="sync-inactive-reason" className="sync-inactive-reason">
        {syncInactiveText(reason, t)}
      </p>
      {error !== null && error !== undefined && (
        <p role="alert" className="sync-inactive-error">
          {syncErrorMessage(error, t)}
        </p>
      )}
      <DropdownMenuSeparator className="bg-border" />
      {action && ActionIcon && (
        <DropdownMenuItem
          data-primary=""
          disabled={busy}
          className="sync-inactive-item"
          onSelect={(event) => {
            if (action === "settings") {
              onOpenSettings()
              return
            }
            // The menu stays open while the action runs, so its outcome is seen in place.
            event.preventDefault()
            onFix(action)
          }}
        >
          <ActionIcon aria-hidden="true" />
          {t(`sync.inactive.action.${reason.id}`)}
        </DropdownMenuItem>
      )}
      {action !== "refresh" && (
        <DropdownMenuItem disabled={busy} className="sync-inactive-item" onSelect={onRefresh}>
          <FolderSync aria-hidden="true" />
          {t("sync.inactive.refreshFiles")}
        </DropdownMenuItem>
      )}
      {action !== null && action !== "settings" && (
        <DropdownMenuItem className="sync-inactive-item" onSelect={onOpenSettings}>
          <Settings2 aria-hidden="true" />
          {t("sync.inactive.openSettings")}
        </DropdownMenuItem>
      )}
    </DropdownMenuContent>
  )
}

/**
 * The sync button of the dock while sync does not work: a click opens the menu of the reason; the
 * right click keeps the menu of the button (the trigger sits inside the `ContextMenu` of the dock).
 */
export function SyncInactiveMenu({
  sync,
  reason,
  side,
  onOpenSettings,
  children,
}: {
  sync: RefreshSync
  reason: SyncInactiveReason
  side: "left" | "right"
  onOpenSettings: () => void
  children: React.ReactElement
}) {
  return (
    <DropdownMenu>
      <ContextMenuTrigger asChild>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      </ContextMenuTrigger>
      <SyncInactiveMenuContent
        reason={reason}
        busy={sync.busy || sync.fixBusy}
        error={sync.fixError}
        side={side}
        onFix={(action) => void sync.fix(action)}
        onRefresh={() => void sync.refresh()}
        onOpenSettings={onOpenSettings}
      />
    </DropdownMenu>
  )
}
