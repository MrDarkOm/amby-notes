import * as React from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw, Database } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatSize } from "@/lib/sync/format-size"
import { syncErrorMessage } from "@/lib/sync/sync-errors"
import { resolveSyncPort, type AccountOverview, type SyncPort } from "@/lib/sync/sync-port"
import { useVaultStore } from "../use-vault-store"

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
  warn: "bg-amber-500",
  full: "bg-destructive",
}

/**
 * The section "Хранилища аккаунта" of the synchronisation settings (docs/sync-plan.md, appendix
 * Е, У1, У2, У4): the plan and its limits, the gauge of the used place, and one row per storage.
 * It reads on open, manual refresh, successful connection changes and a pass with a limit;
 * never on a timer. There is no way to delete a storage yet (Э5).
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
    void load()
  }, [load, revision])

  // A pass that ends with a limit announced asks the server again (the numbers moved).
  React.useEffect(() => {
    let alive = true
    let unlisten: (() => void) | null = null
    port
      .onVaultStatus((status) => {
        if (
          alive &&
          status.unsynced.some((item) => item.reason === "tooLarge" || item.reason === "quotaFull")
        ) {
          void load()
        }
      })
      .then((off) => {
        if (alive) unlisten = off
        else off()
      })
      .catch(() => {})
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
          </li>
        ))}
      </ul>
    </section>
  )
}
