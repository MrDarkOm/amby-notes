import * as React from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatWait, syncCodeMessage, syncErrorMessage } from "@/lib/sync/sync-errors"
import {
  SyncPortError,
  type ApprovalKind,
  type ConflictChoice,
  type SpaceView,
  type SyncPort,
  type VaultSyncStatus,
} from "@/lib/sync/sync-port"
import { ConflictList, StopNotice, UnsyncedList } from "./sync-vault-parts"

export interface SyncVaultPanelProps {
  /** The port to use. */
  port: SyncPort
}

type Mode = "new" | "existing"

/**
 * Sync of the open vault (docs/sync-plan.md, stage Э4): switching it on, the status, the answers to
 * the stops of Р8, the list of conflicts and the list of files that are not synchronised.
 *
 */
export function SyncVaultPanel({ port }: SyncVaultPanelProps) {
  const { t, i18n } = useTranslation()
  const [status, setStatus] = React.useState<VaultSyncStatus | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  // The code behind `error`: the answer "your plan has no room for another storage" offers a way on.
  const [errorCode, setErrorCode] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [resolving, setResolving] = React.useState<string | null>(null)
  const [mode, setMode] = React.useState<Mode>("new")
  const [name, setName] = React.useState("")
  const [spaces, setSpaces] = React.useState<SpaceView[] | null>(null)
  const [spaceId, setSpaceId] = React.useState<string | null>(null)
  const [confirmingOff, setConfirmingOff] = React.useState(false)
  // A guard that does not wait for a render: two clicks in one tick are one request.
  const working = React.useRef(false)

  React.useEffect(() => {
    let alive = true
    let unlisten: (() => void) | null = null
    port
      .vaultStatus()
      .then((next) => alive && setStatus((current) => current ?? next))
      .catch((caught) => alive && setError(syncErrorMessage(caught, t)))
    port
      .onVaultStatus((next) => alive && setStatus(next))
      .then((off) => {
        if (alive) unlisten = off
        else off()
      })
      .catch(() => {})
    return () => {
      alive = false
      unlisten?.()
    }
  }, [port, t])

  const act = async (action: () => Promise<void>): Promise<void> => {
    if (working.current) return
    working.current = true
    setBusy(true)
    setError(null)
    setErrorCode(null)
    try {
      await action()
    } catch (caught) {
      setError(syncErrorMessage(caught, t))
      setErrorCode(caught instanceof SyncPortError ? caught.code : null)
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  const chooseExisting = () => {
    setMode("existing")
    if (spaces !== null) return
    void act(async () => {
      const listed = await port.listSpaces()
      setSpaces(listed)
      // Nothing to connect to: the way on is to create the first space (owner's request).
      if (listed.length === 0) setMode("new")
    })
  }

  const backupPath = status?.backupPath ?? null
  const backupInfo = backupPath ? (
    <div className="space-y-1.5 rounded-lg border border-border bg-card/40 px-3 py-2 text-[12px] leading-5">
      <p>{t("sync.vault.backupReady")}</p>
      <code data-testid="sync-backup-path" className="block select-text break-all font-mono">
        {backupPath}
      </code>
      <p>{t("sync.vault.restoreInstructions")}</p>
    </div>
  ) : null
  const target = mode === "new" ? ({ kind: "new", name: name.trim() } as const) : null
  const canEnable = !busy && (mode === "new" || spaceId !== null)

  const enable = () =>
    act(async () => {
      const chosen = target ?? { kind: "existing" as const, spaceId: spaceId ?? "" }
      setStatus(await port.enableVault(chosen, false))
    })

  // Only a binding of this server and account is resumed, with its own space (the target is
  // ignored by the application).
  const resumeAfterOff = () =>
    act(async () => {
      setStatus(await port.enableVault({ kind: "new", name: "" }, false))
    })

  const disable = () =>
    act(async () => {
      setStatus(await port.disableVault())
      setConfirmingOff(false)
    })

  const approve = (kind: ApprovalKind) => act(() => port.approve(kind))

  const resolve = (id: string, choice: ConflictChoice) => {
    if (working.current) return
    working.current = true
    setResolving(id)
    setError(null)
    port
      .resolveConflict(id, choice)
      .catch((caught) => setError(syncErrorMessage(caught, t)))
      .finally(() => {
        working.current = false
        setResolving(null)
      })
  }

  const header = (
    <h3 className="text-[12px] font-medium text-muted-foreground">{t("sync.vault.title")}</h3>
  )
  const errorLine = error && (
    <div className="space-y-1.5">
      <p role="alert" className="text-[12px] text-destructive">
        {error}
      </p>
      {errorCode === "space_limit" && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            setError(null)
            setErrorCode(null)
            chooseExisting()
          }}
        >
          {t("sync.notices.chooseExisting")}
        </Button>
      )}
    </div>
  )

  if (!status) {
    return (
      <section data-testid="sync-vault" className="space-y-2">
        {header}
        {errorLine}
      </section>
    )
  }

  // ----- not switched on -----
  if (!status.enabled) {
    if (status.linked && status.resumable) {
      return (
        <section data-testid="sync-vault" className="space-y-2">
          {header}
          <p className="text-[13px]">{t("sync.vault.off")}</p>
          {status.errorCode && (
            <p role="alert" className="text-[12px] text-destructive">
              {t("sync.vault.cannotStart", {
                reason: syncCodeMessage(status.errorCode, t),
              })}
            </p>
          )}
          {backupInfo}
          {errorLine}
          <Button type="button" size="sm" disabled={busy} onClick={() => void resumeAfterOff()}>
            {t("sync.vault.resume")}
          </Button>
        </section>
      )
    }
    return (
      <section data-testid="sync-vault" className="space-y-3">
        {header}
        <p
          data-testid="sync-backup-before-enable"
          className="rounded-lg border border-border bg-card/40 px-3 py-2 text-[12px] leading-5 text-muted-foreground"
        >
          {t("sync.vault.backupBeforeEnable")}
        </p>
        {backupInfo}
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[12px] font-medium">{t("sync.vault.spaceLegend")}</legend>
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="radio"
              name="sync-space-mode"
              checked={mode === "new"}
              onChange={() => setMode("new")}
            />
            {t("sync.vault.createNew")}
          </label>
          {mode === "new" && (
            <div className="space-y-1 pl-6">
              <label htmlFor="sync-space-name" className="text-[12px] font-medium">
                {t("sync.vault.nameLabel")}
              </label>
              <Input
                id="sync-space-name"
                value={name}
                maxLength={64}
                placeholder={t("sync.vault.namePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          )}
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="radio"
              name="sync-space-mode"
              checked={mode === "existing"}
              onChange={chooseExisting}
            />
            {t("sync.vault.connectExisting")}
          </label>
          {spaces !== null && spaces.length === 0 && (
            <div className="space-y-1.5 pl-6">
              <p className="text-[12px] text-muted-foreground">{t("sync.vault.noSpaces")}</p>
              <p className="text-[12px] text-muted-foreground">{t("sync.vault.noSpacesHint")}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => setMode("new")}>
                {t("sync.vault.noSpacesCreate")}
              </Button>
            </div>
          )}
          {mode === "existing" && spaces !== null && (
            <div className="space-y-1 pl-6">
              {spaces.map((space) => (
                <label key={space.spaceId} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="radio"
                    name="sync-space-choice"
                    checked={spaceId === space.spaceId}
                    onChange={() => setSpaceId(space.spaceId)}
                  />
                  {space.name ?? t("sync.vault.unnamedSpace")}
                  <span className="text-[11px] text-muted-foreground">
                    {t("sync.vault.spaceChanges", { count: space.seq })}
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        {errorLine}
        <Button type="button" size="sm" disabled={!canEnable} onClick={() => void enable()}>
          {t("sync.vault.enable")}
        </Button>
      </section>
    )
  }

  // ----- switched on -----
  const lastSync = status.lastSyncMs === null ? null : new Date(status.lastSyncMs)
  let line: string
  switch (status.phase) {
    case "running":
      line = t("sync.vault.status.running")
      break
    case "waiting":
      line = t("sync.vault.status.waiting", {
        wait: formatWait(status.nextTrySecs ?? 1, t),
      })
      break
    case "stopped":
      line = t("sync.vault.status.stopped")
      break
    default:
      line = t("sync.vault.status.idle")
  }
  return (
    <section data-testid="sync-vault" className="space-y-3">
      {header}
      {backupInfo}
      <div className="rounded-lg border border-border bg-card/30 px-4 py-3">
        <p className="flex items-center gap-2 text-[13px] font-medium">
          {status.spaceName ?? t("sync.vault.unnamedSpace")}
        </p>
        <div data-testid="sync-status" role="status" className="mt-1 space-y-0.5">
          <p className="text-[12px]">{line}</p>
          {status.phase === "idle" && (
            <p className="text-[11px] text-muted-foreground">
              {lastSync
                ? t("sync.vault.status.lastSync", { date: lastSync.toLocaleString(i18n.language) })
                : t("sync.vault.status.never")}
            </p>
          )}
          {status.phase === "waiting" && status.errorCode && (
            <p data-testid="sync-status-detail" className="text-[11px] text-muted-foreground">
              {syncCodeMessage(status.errorCode, t)}
            </p>
          )}
        </div>
      </div>

      {status.stop && (
        <StopNotice
          stop={status.stop}
          busy={busy}
          onApprove={(kind) => void approve(kind)}
          onCheckAgain={() => void act(() => port.runNow())}
        />
      )}
      {status.outgoingPaused && (
        <p className="text-[12px] text-muted-foreground">{t("sync.vault.outgoingPaused")}</p>
      )}
      {status.itemErrors > 0 && (
        <p className="text-[12px] text-muted-foreground">
          {t("sync.vault.itemErrors", { count: status.itemErrors })}
        </p>
      )}
      {status.needsUpdate && (
        <p role="note" className="text-[12px] text-muted-foreground">
          {t("sync.vault.needsUpdate")}
        </p>
      )}
      {errorLine}

      <ConflictList items={status.conflicts} busyId={resolving} onResolve={resolve} />
      <UnsyncedList items={status.unsynced} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void act(() => port.runNow())}
        >
          <RefreshCw />
          {t("sync.vault.runNow")}
        </Button>
        {confirmingOff ? (
          <>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void disable()}
            >
              {t("sync.vault.disableConfirm")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmingOff(false)}>
              {t("sync.vault.cancel")}
            </Button>
          </>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmingOff(true)}>
            {t("sync.vault.disable")}
          </Button>
        )}
      </div>
    </section>
  )
}
