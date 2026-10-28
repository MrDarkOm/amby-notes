import * as React from "react"
import { useTranslation } from "react-i18next"
import { Laptop, LogOut, RefreshCw, UserRound, ShieldCheck } from "lucide-react"

import { isAmbyServer } from "@/lib/sync/amby-server"
import { Button } from "@/components/ui/button"
import { syncErrorMessage } from "@/lib/sync/sync-errors"
import {
  SyncPortError,
  resolveSyncPort,
  unavailableSyncPort,
  type DeviceView,
  type SyncPort,
  type SyncStatus,
} from "@/lib/sync/sync-port"
import { AccountStorage } from "./account-storage"
import { ConnectWizard } from "./connect-wizard"
import { useVaultStore } from "../use-vault-store"
import { SyncVaultPanel } from "./sync-vault-panel"

export interface SyncSettingsProps {
  /** The port to use; the application's own by default. */
  port?: SyncPort
  vault?: string | null
}

/** The "Synchronization" section of the settings (docs/sync-plan.md, Р12). */
export function SyncSettings({ port: given, vault: givenVault }: SyncSettingsProps) {
  const { t, i18n } = useTranslation()
  const storedVault = useVaultStore((state) => state.vault)
  const vault = givenVault === undefined ? storedVault : givenVault
  const port = React.useMemo(() => given ?? resolveSyncPort(), [given])
  const [status, setStatus] = React.useState<SyncStatus | null>(null)
  const [storageRevision, refreshStorage] = React.useReducer((value: number) => value + 1, 0)
  const [devices, setDevices] = React.useState<DeviceView[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [keychainLocked, setKeychainLocked] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const working = React.useRef(false)
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

  const load = React.useCallback(
    async (interactive = false): Promise<void> => {
      try {
        const next = interactive ? await port.status(true) : await port.status()
        setKeychainLocked(false)
        setStatus(next)
        if (next.connected) await loadDevices()
      } catch (caught) {
        setError(syncErrorMessage(caught, t))
        setKeychainLocked(caught instanceof SyncPortError && caught.code === "keychain_unavailable")
      }
    },
    [loadDevices, port, t],
  )

  React.useEffect(() => {
    if (!unavailable) void load()
  }, [load, unavailable])

  const act = async (action: () => Promise<void>) => {
    if (working.current) return
    working.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(syncErrorMessage(caught, t))
    } finally {
      working.current = false
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

  if (unavailable) {
    return (
      <div className="sync-settings-page">
        <p className="text-[13px]">{t("sync.errors.unavailable")}</p>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="sync-settings-page">
        {error ? (
          <div className="space-y-2">
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setError(null)
                void act(() => load(keychainLocked))
              }}
            >
              <RefreshCw />
              {t(keychainLocked ? "sync.connected.unlock" : "sync.connected.retry")}
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
      <div className="sync-settings-page">
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

  const renderAccountHeader = (syncControl: React.ReactNode) => (
    <section className="sync-account-strip">
      <div className="sync-account-avatar">
        <UserRound className="size-4" aria-hidden="true" />
      </div>
      <div className="sync-account-identity">
        <div className="sync-account-heading">
          <h2>{status.username}</h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="sync-account-signout"
          title={t("sync.connected.signOutHint")}
          aria-label={t("sync.connected.signOut")}
          disabled={busy}
          onClick={() => void signOut()}
        >
          <LogOut />
          {t("sync.layout.signOut")}
        </Button>
      </div>
      <div className="sync-account-connection">
        <p className="sync-account-server">
          {t(isAmbyServer(status.serverUrl) ? "sync.connected.toAmby" : "sync.connected.to", {
            host: status.host ?? status.serverUrl ?? "",
          })}
        </p>
        {syncControl}
      </div>
    </section>
  )

  return (
    <div className="sync-settings-page">
      {error && (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      )}

      <SyncVaultPanel
        port={port}
        vault={vault}
        renderAccountHeader={renderAccountHeader}
        onConnectionChange={refreshStorage}
      />

      <div className="sync-settings-sections">
        <AccountStorage port={port} revision={storageRevision} />

        <section className="sync-section sync-devices">
          <div className="sync-devices-heading">
            <h3 className="sync-section-title">
              <Laptop className="size-4" aria-hidden="true" />
              {t("sync.connected.devices")}
            </h3>
            <span className="sync-private-badge">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              {t("sync.layout.encrypted")}
            </span>
          </div>
          <ul className="sync-device-list">
            {(devices ?? []).map((device) => {
              const name = device.name ?? t("sync.connected.unknownDevice")
              return (
                <li key={device.deviceId} className="sync-device-row">
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
                    <span className="sync-device-current">{t("sync.connected.thisDevice")}</span>
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
      </div>
    </div>
  )
}
