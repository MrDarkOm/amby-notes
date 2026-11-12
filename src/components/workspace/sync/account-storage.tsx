import * as React from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw, Database, MoreHorizontal } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { confirm } from "@/lib/confirm"
import { cn } from "@/lib/utils"
import { formatSize } from "@/lib/sync/format-size"
import { syncErrorMessage } from "@/lib/sync/sync-errors"
import { resolveSyncPort, type AccountOverview, type SyncPort } from "@/lib/sync/sync-port"
import { NOTICE_LOOK } from "../notices/notice-look"
import { useVaultStore } from "../use-vault-store"
import { reportSyncListenFailed } from "./listen-failure"

export interface AccountStorageProps {
  /** The port to use; the application's own by default. */
  port?: SyncPort
  revision?: number
}

type Level = "ok" | "warn" | "full"

/** From 80% the colour warns, from 100% it is the colour of an error (У2). */
function levelOf(used: number, limit: number): Level {
  if (used >= limit) return "full"
  return used * 5 >= limit * 4 ? "warn" : "ok"
}

const LEVEL_CLASS: Record<Level, string> = {
  ok: "bg-primary",
  warn: NOTICE_LOOK.warning.dot,
  full: "bg-destructive",
}

/**
 * The section "Хранилища аккаунта" of the synchronisation settings (docs/sync-plan.md, appendix
 * Е, У1, У2, У4): the plan and its limits, the gauge of the used place, and one row per storage.
 * It reads on open, manual refresh, successful connection changes and a pass with a limit;
 * never on a timer. A row can delete the server copy (appendix Л); local files stay.
 */
export function AccountStorage({ port: given, revision = 0 }: AccountStorageProps) {
  const { t, i18n } = useTranslation()
  const port = React.useMemo(() => given ?? resolveSyncPort(), [given])
  const vaults = useVaultStore((state) => state.vaults)
  const [data, setData] = React.useState<AccountOverview | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const vaultPaths = React.useMemo(() => vaults.map((vault) => vault.path), [vaults])
  const paths = React.useRef(vaultPaths)
  paths.current = vaultPaths
  // The deletion of a server copy (Л10, Л11): one request at a time, one result line under the list.
  const [deleting, setDeleting] = React.useState(false)
  const [deleted, setDeleted] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  // Another account or revision: what was asked or answered for the old one is dropped.
  const generation = React.useRef(0)
  const askAbort = React.useRef<AbortController | null>(null)
  const reading = React.useRef(false)
  const pending = React.useRef(false)

  const load = React.useCallback(async (): Promise<void> => {
    if (reading.current) {
      pending.current = true
      return
    }
    reading.current = true
    setLoading(true)
    try {
      do {
        pending.current = false
        const next = await port.accountOverview(paths.current)
        setData(next)
        setError(null)
      } while (pending.current)
    } catch (caught) {
      setError(syncErrorMessage(caught, t))
    } finally {
      reading.current = false
      setLoading(false)
    }
  }, [port, t])

  React.useEffect(() => {
    generation.current += 1
    askAbort.current?.abort()
    askAbort.current = null
    setDeleting(false)
    setDeleted(false)
    setDeleteError(null)
    void load()
    return () => {
      generation.current += 1
      askAbort.current?.abort()
      askAbort.current = null
    }
  }, [load, revision])

  const deleteFromServer = async (space: AccountOverview["spaces"][number]) => {
    if (deleting) return
    const mine = generation.current
    const controller = new AbortController()
    askAbort.current = controller
    const named = space.name !== null && space.name !== ""
    const question = {
      title: named
        ? t("sync.account.deleteTitle", { name: space.name })
        : t("sync.account.deleteTitleUnnamed", { id: space.spaceId }),
      description: t("sync.account.deleteDescription", {
        live: formatSize(space.liveBytes, i18n.language),
        history: formatSize(space.historyBytes, i18n.language),
      }),
      confirmLabel: t("sync.account.deleteConfirm"),
      destructive: true,
      requiredText: {
        value: named ? (space.name as string) : space.spaceId,
        label: t(named ? "sync.account.deleteField" : "sync.account.deleteFieldId"),
      },
      signal: controller.signal,
    }
    const agreed = await confirm(question)
    if (askAbort.current === controller) askAbort.current = null
    if (!agreed || generation.current !== mine) return
    setDeleting(true)
    setDeleted(false)
    setDeleteError(null)
    try {
      await port.deleteSpace(space.spaceId)
      if (generation.current !== mine) return
      setDeleted(true)
      await load()
    } catch (caught) {
      if (generation.current !== mine) return
      setDeleteError(syncErrorMessage(caught, t))
    } finally {
      if (generation.current === mine) setDeleting(false)
    }
  }

  // A pass that ends with a limit announced, or that sent or removed something, asks the server again.
  React.useEffect(() => {
    let alive = true
    let unlisten: (() => void) | null = null
    // The pass after which the sizes were read last: a pass that sent or removed something moves
    // them (the confirmation of a deletion names them, appendix Л), once per pass.
    let readAfter: number | null = null
    port
      .onVaultStatus((status) => {
        if (!alive) return
        const limit = status.unsynced.some(
          (item) => item.reason === "tooLarge" || item.reason === "quotaFull",
        )
        const moved =
          status.last !== null &&
          status.last.uploaded + status.last.trashed > 0 &&
          status.lastSyncMs !== null &&
          status.lastSyncMs !== readAfter
        if (moved) readAfter = status.lastSyncMs
        if (limit || moved) void load()
      })
      .then((off) => {
        if (alive) unlisten = off
        else off()
      })
      .catch((error: unknown) => {
        // The numbers are not pushed to this screen; they are read when it opens and on refresh. Said in the centre.
        reportSyncListenFailed(error)
      })
    return () => {
      alive = false
      unlisten?.()
    }
  }, [port, load])

  const language = i18n.language
  const size = (bytes: number) => formatSize(bytes, language)
  const heading = (
    <div className="sync-storage-heading flex items-center justify-between gap-2">
      <h3 className="sync-section-title">{t("sync.account.title")}</h3>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        title={t("sync.account.refresh")}
        aria-label={t("sync.account.refresh")}
        disabled={loading}
        onClick={() => void load()}
      >
        <RefreshCw />
      </Button>
    </div>
  )
  const errorLine = error && (
    <p role="alert" className="text-[12px] text-destructive">
      {error}
    </p>
  )

  if (!data) {
    return (
      <section className="sync-section space-y-2">
        {heading}
        {errorLine}
      </section>
    )
  }

  const plan = data.limitsKnown ? data.plan : null
  const limits = data.limits
  const used = data.usage.liveBytes + data.usage.pendingBytes
  const quota = data.limitsKnown ? limits.maxTotalBytes : null
  const level = quota === null ? null : levelOf(used, quota)
  const sorted = [...data.spaces].sort(
    (a, b) => Number(b.thisVault) - Number(a.thisVault) || b.liveBytes - a.liveBytes,
  )

  return (
    <section data-testid="account-storage" className="sync-section space-y-3">
      {heading}
      {errorLine}
      <div className="sync-storage-plan space-y-2">
        <p className="text-[13px] font-medium">
          {plan
            ? t("sync.account.plan", { name: plan.title ?? plan.name })
            : t("sync.account.ownServerUnlimited")}
        </p>
        {quota !== null && level !== null ? (
          <div className="space-y-1">
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, (used / quota) * 100)}
              data-level={level}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn("h-full", LEVEL_CLASS[level])}
                style={{ width: `${Math.min(100, (used / quota) * 100)}%` }}
              />
            </div>
            <p className="text-[12px]">
              {t("sync.account.usedOf", { used: size(used), limit: size(quota) })}
            </p>
          </div>
        ) : (
          <p className="text-[12px]">{t("sync.account.used", { used: size(used) })}</p>
        )}
        {data.limitsKnown && (
          <ul className="space-y-0.5 text-[12px] text-muted-foreground">
            {limits.maxSpaces !== null && (
              <li>
                {t("sync.account.limitSpaces", {
                  count: data.usage.spaces,
                  max: limits.maxSpaces,
                })}
              </li>
            )}
            {limits.maxFileBytes !== null && (
              <li>{t("sync.account.limitFile", { size: size(limits.maxFileBytes) })}</li>
            )}
            {limits.historyDays !== null && (
              <li>
                {limits.maxHistoryBytes !== null
                  ? t("sync.account.limitHistory", {
                      days: t("sync.account.days", { count: limits.historyDays }),
                      size: size(limits.maxHistoryBytes),
                    })
                  : t("sync.account.limitHistoryDays", {
                      days: t("sync.account.days", { count: limits.historyDays }),
                    })}
              </li>
            )}
          </ul>
        )}
        {data.usage.historyBytes > 0 && (
          <p data-testid="account-history" className="text-[12px] text-muted-foreground">
            {t("sync.account.historyLine", { size: size(data.usage.historyBytes) })}
          </p>
        )}
        {plan && (
          <p className="text-[11px] text-muted-foreground">{t("sync.account.ownerChangesPlan")}</p>
        )}
      </div>
      <ul className="sync-storage-list">
        {sorted.map((space) => (
          <li
            key={space.spaceId}
            data-testid="storage-row"
            data-current={space.thisVault || undefined}
            className="sync-storage-row"
          >
            <Database className="sync-storage-icon size-4" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <p data-testid="storage-name" className="min-w-0 truncate text-[13px]">
                  {space.name ?? t("sync.account.nameUnavailable")}
                </p>
                <p className="shrink-0 text-[12px]">{size(space.liveBytes)}</p>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {space.thisVault
                  ? t("sync.account.thisVault")
                  : space.boundFolder !== null
                    ? t("sync.account.boundHere", { folder: space.boundFolder })
                    : t("sync.account.elsewhere")}
              </p>
              {space.historyBytes > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {t("sync.account.rowHistory", { size: size(space.historyBytes) })}
                </p>
              )}
            </div>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title={t("sync.account.rowActions")}
                  aria-label={t("sync.account.rowActions")}
                  disabled={deleting}
                  className="flex size-6 shrink-0 items-center justify-center rounded outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                >
                  <MoreHorizontal className="size-3.5 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="border-border bg-popover text-foreground"
                align="end"
                onCloseAutoFocus={(event) => event.preventDefault()}
              >
                <DropdownMenuItem
                  className="text-[13px] focus:bg-accent focus:text-white"
                  onSelect={() => void deleteFromServer(space)}
                >
                  {t("sync.account.deleteFromServer")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
      {deleted && (
        <p role="status" className="text-[12px] text-muted-foreground">
          {t("sync.account.deleteDone")}
        </p>
      )}
      {deleteError && (
        <p role="alert" className="text-[12px] text-destructive">
          {deleteError}
        </p>
      )}
    </section>
  )
}
