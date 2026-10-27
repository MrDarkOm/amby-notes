import * as React from "react"
import { useTranslation } from "react-i18next"
import { Laptop, LogOut, RefreshCw } from "lucide-react"

import { isAmbyServer } from "@/lib/sync/amby-server"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { syncErrorMessage } from "@/lib/sync/sync-errors"
import {
  SyncPortError,
  resolveSyncPort,
  unavailableSyncPort,
  type DeviceView,
  type SyncPort,
  type SyncStatus,
} from "@/lib/sync/sync-port"
import { SettingsIntro } from "../settings/settings-common"
import { AccountStorage } from "./account-storage"
import { ConnectWizard } from "./connect-wizard"
import { SyncVaultPanel } from "./sync-vault-panel"

export interface SyncSettingsProps {
  /** The port to use; the application's own by default. */
  port?: SyncPort
}

/** The "Synchronization" section of the settings (docs/sync-plan.md, Р12). */
export function SyncSettings({ port: given }: SyncSettingsProps) {
  const { t, i18n } = useTranslation()
  const port = React.useMemo(() => given ?? resolveSyncPort(), [given])
  const [status, setStatus] = React.useState<SyncStatus | null>(null)
  const [devices, setDevices] = React.useState<DeviceView[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const unavailable = port === unavailableSyncPort

  const loadDevices = React.useCallback(async (): Promise<void> => {
    try {
      setDevices(await port.listDevices())
    } catch (caught) {
      setError(syncErrorMessage(caught, t))
      setDevices(null)
      // The server may have disconnected this device: the application forgot it as well.
      if (
        caught instanceof SyncPortError &&
        ["token_revoked", "unauthorized"].includes(caught.code)
      ) {
        setStatus(await port.status().catch(() => null))
      }
    }
  }, [port, t])

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const next = await port.status()
      setStatus(next)
      if (next.connected) await loadDevices()
    } catch (caught) {
      setError(syncErrorMessage(caught, t))
    }
  }, [loadDevices, port, t])

  React.useEffect(() => {
    if (!unavailable) void load()
  }, [load, unavailable])

  const act = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(syncErrorMessage(caught, t))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = (deviceId: string) =>
    act(async () => {
      await port.disconnectDevice(deviceId)
      setConfirming(null)
      await loadDevices()
    })

  const signOut = () =>
    act(async () => {
      const result = await port.signOut()
      setNotice(result.serverNotified ? null : t("sync.connected.serverNotNotified"))
      setDevices(null)
      setStatus(await port.status())
    })

  const onConnected = (next: SyncStatus) => {
    setStatus(next)
    setError(null)
    setNotice(null)
    void loadDevices()
  }

  const header = <SettingsIntro title={t("sync.title")} description={t("sync.intro")} />

  if (unavailable) {
    return (
      <div className="space-y-4">
        {header}
        <p className="text-[13px]">{t("sync.errors.unavailable")}</p>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="space-y-4">
        {header}
        {error ? (
          <div className="space-y-2">
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setError(null)
                void load()
              }}
            >
              <RefreshCw />
              {t("sync.connected.retry")}
            </Button>
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">{t("sync.loading")}</p>
        )}
      </div>
    )
  }

  if (!status.connected) {
    return (
      <div className="space-y-4">
        {header}
        {status.keysMissing && (
          <p role="status" className="rounded-lg border border-border px-3 py-2 text-[12px]">
            {t("sync.connected.keysMissing")}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded-lg border border-border px-3 py-2 text-[12px]">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="text-[12px] text-destructive">
            {error}
          </p>
        )}
        <ConnectWizard
          port={port}
          onConnected={onConnected}
          initial={{
            url: status.serverUrl ?? undefined,
            allowHttp: status.allowHttp,
            username: status.username ?? undefined,
          }}
          defaultDeviceName={t("sync.wizard.defaultDeviceName", {
            platform: typeof navigator === "undefined" ? "" : navigator.platform,
          })}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {header}
      <div className="rounded-lg border border-border bg-card/30 px-4 py-3">
        <p className="text-[13px] font-medium">
          {t(isAmbyServer(status.serverUrl) ? "sync.connected.toAmby" : "sync.connected.to", {
            host: status.host ?? status.serverUrl ?? "",
          })}
        </p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {t("sync.connected.user", { name: status.username ?? "" })}
        </p>
      </div>

      {error && (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      )}

      <SyncVaultPanel port={port} />

      <AccountStorage port={port} />

      <section>
        <h3 className="mb-2 text-[12px] font-medium text-muted-foreground">
          {t("sync.connected.devices")}
        </h3>
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {(devices ?? []).map((device) => {
            const name = device.name ?? t("sync.connected.unknownDevice")
            return (
              <li key={device.deviceId} className="flex items-center gap-3 px-4 py-2.5">
                <Laptop className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px]">{name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {t("sync.connected.lastSeen", {
                      date: new Date(device.lastSeenMs).toLocaleString(i18n.language),
                    })}
                  </p>
                </div>
                {device.current ? (
                  <span
                    className={cn(
                      "rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground",
                    )}
                  >
                    {t("sync.connected.thisDevice")}
                  </span>
                ) : confirming === device.deviceId ? (
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => void disconnect(device.deviceId)}
                    >
                      {t("sync.connected.confirmDisconnect")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirming(null)}
                    >
                      {t("sync.connected.cancel")}
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t("sync.connected.disconnectLabel", { name })}
                    onClick={() => setConfirming(device.deviceId)}
                  >
                    {t("sync.connected.disconnect")}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <div className="space-y-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void signOut()}
        >
          <LogOut />
          {t("sync.connected.signOut")}
        </Button>
        <p className="text-[11px] text-muted-foreground">{t("sync.connected.signOutHint")}</p>
      </div>
    </div>
  )
}
