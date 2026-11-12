import * as React from "react"
import { useTranslation } from "react-i18next"
import { KeyRound, Laptop, LogOut, Pencil, RefreshCw, UserRound, ShieldCheck } from "lucide-react"

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
import { ChangePasswordForm } from "./change-password"
import { RenameIdentityForm } from "./rename-identity"
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
  const [changing, setChanging] = React.useState(false)
  const [passwordChanged, setPasswordChanged] = React.useState(false)
  const [identityEditor, setIdentityEditor] = React.useState<
    | { mode: "account"; username: string }
    | { mode: "device"; deviceId: string; name: string }
    | null
  >(null)
  const working = React.useRef(false)
  const unavailable = port === unavailableSyncPort

  const loadDevices = React.useCallback(async (): Promise<void> => {
    try {
      setDevices(await port.listDevices())
      setStatus(await port.status())
    } catch (caught) {
      setError(syncErrorMessage(caught, t))
      setDevices(null)
      // The server may have disconnected this device: the application forgot it as well.
      if (
        caught instanceof SyncPortError &&
        ["token_revoked", "unauthorized"].includes(caught.code)
      ) {
        // The error above is already shown; an unreadable status stays unknown (`null`) until the
        // next load.
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
    setIdentityEditor(null)
    setChanging(false)
    setConfirming(null)
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

  const onIdentityConnectionLost = (caught: SyncPortError) => {
    setIdentityEditor(null)
    setChanging(false)
    setConfirming(null)
    setError(syncErrorMessage(caught, t))
    void load(false)
  }

  const accountHeader = (
    <>
      <section className="sync-account-strip">
        {identityEditor?.mode === "account" ? (
          <RenameIdentityForm
            port={port}
            mode="account"
            onConnectionLost={onIdentityConnectionLost}
            username={identityEditor.username}
            onClose={(changed) => {
              setIdentityEditor(null)
              if (changed) void load(false)
            }}
          />
        ) : (
          <>
            <div className="sync-account-avatar">
              <UserRound className="size-4" aria-hidden="true" />
            </div>
            <div className="sync-account-identity">
              <div className="sync-identity-name">
                <h3>{status.username}</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="sync-inline-rename"
                  aria-label={t("sync.identity.renameAccount")}
                  title={t("sync.identity.renameAccount")}
                  disabled={busy || changing || identityEditor !== null}
                  onClick={() => {
                    setChanging(false)
                    setIdentityEditor({ mode: "account", username: status.username ?? "" })
                  }}
                >
                  <Pencil />
                </Button>
              </div>
              <p className="sync-account-server">
                {t(isAmbyServer(status.serverUrl) ? "sync.connected.toAmby" : "sync.connected.to", {
                  host: status.host ?? status.serverUrl ?? "",
                })}
              </p>
            </div>
            <div className="sync-account-actions">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || identityEditor !== null}
                aria-expanded={changing}
                onClick={() => {
                  setPasswordChanged(false)
                  setIdentityEditor(null)
                  setChanging(true)
                }}
              >
                <KeyRound />
                {t("sync.changePassword.open")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="sync-account-signout"
                title={t("sync.connected.signOutHint")}
                aria-label={t("sync.connected.signOut")}
                disabled={busy || identityEditor !== null}
                onClick={() => void signOut()}
              >
                <LogOut />
                {t("sync.layout.signOut")}
              </Button>
            </div>
          </>
        )}
      </section>
      {passwordChanged && (
        <p role="status" className="text-[12px] text-muted-foreground">
          {t("sync.changePassword.done")}
        </p>
      )}
      {changing && (
        <ChangePasswordForm
          port={port}
          username={status.username ?? ""}
          onClose={(changed) => {
            setChanging(false)
            setPasswordChanged(changed)
          }}
        />
      )}
    </>
  )

  return (
    <div className="sync-settings-page">
      {error && (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      )}

      <SyncVaultPanel port={port} vault={vault} onConnectionChange={refreshStorage} />

      <section className="sync-zone" aria-labelledby="sync-zone-account">
        <h2 id="sync-zone-account" className="sync-zone-title">
          {t("sync.layout.zoneAccount")}
        </h2>
        <div className="sync-account-grid">
          <div className="sync-account-column">
            {accountHeader}
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
                      {identityEditor?.mode === "device" &&
                      identityEditor.deviceId === device.deviceId ? (
                        <RenameIdentityForm
                          port={port}
                          mode="device"
                          onConnectionLost={onIdentityConnectionLost}
                          deviceId={device.deviceId}
                          name={identityEditor.name}
                          onClose={(changed) => {
                            setIdentityEditor(null)
                            if (changed) void loadDevices()
                          }}
                        />
                      ) : (
                        <>
                          <Laptop className="size-4 shrink-0 text-muted-foreground" />
                          <div className="sync-device-name sync-identity-name">
                            <p className="truncate text-[13px]">{name}</p>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="sync-inline-rename"
                              title={t("sync.identity.renameDevice", { name })}
                              aria-label={t("sync.identity.renameDevice", { name })}
                              disabled={busy || changing || identityEditor !== null}
                              onClick={() =>
                                setIdentityEditor({
                                  mode: "device",
                                  deviceId: device.deviceId,
                                  name,
                                })
                              }
                            >
                              <Pencil />
                            </Button>
                          </div>
                          <div
                            className="sync-device-actions"
                            data-confirming={confirming === device.deviceId || undefined}
                          >
                            {device.current && (
                              <span className="sync-device-current">
                                {t("sync.connected.thisDevice")}
                              </span>
                            )}
                            {!device.current && confirming === device.deviceId ? (
                              <div className="flex gap-2">
                                <Button
                                  type="button"
                                  variant="destructive"
                                  size="sm"
                                  disabled={busy || identityEditor !== null}
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
                            ) : !device.current ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-label={t("sync.connected.disconnectLabel", { name })}
                                disabled={busy || identityEditor !== null}
                                onClick={() => setConfirming(device.deviceId)}
                              >
                                {t("sync.connected.disconnect")}
                              </Button>
                            ) : null}
                          </div>
                          <p className="sync-device-last-seen">
                            {t("sync.connected.lastSeen", {
                              date: new Date(device.lastSeenMs).toLocaleString(i18n.language),
                            })}
                          </p>
                        </>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          </div>
          <AccountStorage port={port} revision={storageRevision} />
        </div>
      </section>
    </div>
  )
}
