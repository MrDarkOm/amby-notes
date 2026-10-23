import * as React from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatWait, syncCodeMessage, syncErrorMessage } from "@/lib/sync/sync-errors"
import type {
  ApprovalKind,
  ConflictChoice,
  SpaceView,
  SyncPort,
  VaultSyncStatus,
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
 * While the gate of the plan is closed (real notes are not allowed yet) a vault can be switched on
 * only when the person marks it as a test vault, and the screen says why.
 */
export function SyncVaultPanel({ port }: SyncVaultPanelProps) {
  const { t, i18n } = useTranslation()
  const [status, setStatus] = React.useState<VaultSyncStatus | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [resolving, setResolving] = React.useState<string | null>(null)
  const [mode, setMode] = React.useState<Mode>("new")
  const [name, setName] = React.useState("")
  const [spaces, setSpaces] = React.useState<SpaceView[] | null>(null)
  const [spaceId, setSpaceId] = React.useState<string | null>(null)
  const [testVault, setTestVault] = React.useState(false)
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
    try {
      await action()
    } catch (caught) {
      setError(syncErrorMessage(caught, t))
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  const chooseExisting = () => {
    setMode("existing")
    if (spaces !== null) return
    void act(async () => setSpaces(await port.listSpaces()))
  }

  const gateClosed = status?.gateClosed ?? true
  const target = mode === "new" ? ({ kind: "new", name: name.trim() } as const) : null
  const canEnable = !busy && (!gateClosed || testVault) && (mode === "new" || spaceId !== null)

  const enable = () =>
    act(async () => {
      const chosen = target ?? { kind: "existing" as const, spaceId: spaceId ?? "" }
      setStatus(await port.enableVault(chosen, testVault))
    })

  const resumeAfterOff = () =>
    act(async () => {
      setStatus(await port.enableVault({ kind: "new", name: "" }, status?.testVault ?? false))
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
    <p role="alert" className="text-[12px] text-destructive">
      {error}
    </p>
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
    if (status.linked) {
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
        {gateClosed && (
          <p
            data-testid="sync-test-warning"
            role="note"
            className="rounded-lg border border-border bg-card/40 px-3 py-2 text-[12px] leading-5 text-muted-foreground"
          >
            {t("sync.vault.testWarning")}
          </p>
        )}
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
          {mode === "existing" && spaces !== null && (
            <div className="space-y-1 pl-6">
              {spaces.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">{t("sync.vault.noSpaces")}</p>
              ) : (
                spaces.map((space) => (
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
                ))
              )}
            </div>
          )}
        </fieldset>
        <label className="flex items-start gap-2 text-[12px] leading-5">
          <input
            type="checkbox"
            data-testid="sync-test-vault"
            className="mt-1"
            checked={testVault}
            onChange={(event) => setTestVault(event.target.checked)}
          />
          {t("sync.vault.testVault")}
        </label>
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
      <div className="rounded-lg border border-border bg-card/30 px-4 py-3">
        <p className="flex items-center gap-2 text-[13px] font-medium">
          {status.spaceName ?? t("sync.vault.unnamedSpace")}
          {status.testVault && (
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
              {t("sync.vault.testBadge")}
            </span>
          )}
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
