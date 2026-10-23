import * as React from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { ApprovalKind, ConflictChoice, VaultSyncStatus } from "@/lib/sync/sync-port"

type Stop = NonNullable<VaultSyncStatus["stop"]>
type Conflict = VaultSyncStatus["conflicts"][number]
type Unsynced = VaultSyncStatus["unsynced"][number]

/** The reasons the interface has a text for; anything else is "not recognised" (a newer Amby). */
const UNSYNCED_REASONS = [
  "symlink",
  "notUtf8",
  "tooLarge",
  "tooBigForMemory",
  "excludedPath",
  "invalidName",
  "caseCollision",
  "nameCollision",
  "pathBusy",
  "noAccess",
] as const

const NAME_PROBLEMS = [
  "forbiddenChar",
  "trailingDot",
  "reservedName",
  "segmentTooLong",
  "pathTooLong",
] as const

function reasonText(item: Unsynced, t: ReturnType<typeof useTranslation>["t"]): string {
  if (!(UNSYNCED_REASONS as readonly string[]).includes(item.reason)) {
    return t("sync.vault.unsynced.unknown")
  }
  if (item.reason === "invalidName") {
    const problem = (NAME_PROBLEMS as readonly string[]).includes(item.detail ?? "")
      ? t(`sync.vault.unsynced.problems.${item.detail}`)
      : t("sync.vault.unsynced.problems.unknown")
    return t("sync.vault.unsynced.invalidName", { problem })
  }
  return t(`sync.vault.unsynced.${item.reason}`, { other: item.detail ?? "" })
}

/** The files that stay behind on this computer, with the reason of each (Р4, Р9). */
export function UnsyncedList({ items }: { items: Unsynced[] }) {
  const { t } = useTranslation()
  if (items.length === 0) return null
  return (
    <section data-testid="sync-unsynced" className="space-y-1.5">
      <h4 className="text-[12px] font-medium text-muted-foreground">
        {t("sync.vault.unsynced.title", { count: items.length })}
      </h4>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {items.map((item) => (
          <li key={`${item.path}\u0000${item.reason}`} className="px-3 py-2">
            <p className="break-all text-[12px]">{item.path}</p>
            <p className="text-[11px] text-muted-foreground">{reasonText(item, t)}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The conflicts waiting for the person (Р7): the file, its copy and three ways out. */
export function ConflictList({
  items,
  busyId,
  onResolve,
}: {
  items: Conflict[]
  busyId: string | null
  onResolve: (id: string, choice: ConflictChoice) => void
}) {
  const { t } = useTranslation()
  if (items.length === 0) return null
  return (
    <section data-testid="sync-conflicts" className="space-y-1.5">
      <h4 className="text-[12px] font-medium text-muted-foreground">
        {t("sync.vault.conflicts.title", { count: items.length })}
      </h4>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {items.map((item) => (
          <li key={item.id} className="space-y-2 px-3 py-2.5">
            <p className="text-[12px]">
              {t(
                item.kind === "bothCreated"
                  ? "sync.vault.conflicts.bothCreated"
                  : "sync.vault.conflicts.bothEdited",
                { original: item.originalPath, copy: item.copyPath },
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["keepOriginal", "sync.vault.conflicts.keepOriginal"],
                  ["keepCopy", "sync.vault.conflicts.keepCopy"],
                  ["keepBoth", "sync.vault.conflicts.keepBoth"],
                ] as const
              ).map(([choice, key]) => (
                <Button
                  key={choice}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busyId !== null}
                  onClick={() => onResolve(item.id, choice)}
                >
                  {t(key)}
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">{t("sync.vault.conflicts.hint")}</p>
    </section>
  )
}

/** Why synchronisation stopped and what the person can do about it (Р8, Д60). */
export function StopNotice({
  stop,
  busy,
  onApprove,
  onCheckAgain,
}: {
  stop: Stop
  busy: boolean
  onApprove: (kind: ApprovalKind) => void
  onCheckAgain: () => void
}) {
  const { t } = useTranslation()
  const [confirmingResync, setConfirmingResync] = React.useState(false)

  const resync = (
    <div className="flex flex-wrap gap-2">
      {confirmingResync ? (
        <>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => onApprove("resync")}
          >
            {t("sync.vault.stop.resyncConfirm")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setConfirmingResync(false)}
          >
            {t("sync.vault.cancel")}
          </Button>
        </>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingResync(true)}>
          {t("sync.vault.stop.resync")}
        </Button>
      )}
    </div>
  )

  let body: React.ReactNode
  switch (stop.kind) {
    case "massChange": {
      const incoming = stop.direction === "incoming"
      body = (
        <>
          <p className="text-[13px] font-medium">
            {t(
              incoming ? "sync.vault.stop.massIncomingTitle" : "sync.vault.stop.massOutgoingTitle",
              { count: stop.total },
            )}
          </p>
          <p className="text-[12px]">
            {t(incoming ? "sync.vault.stop.massIncomingText" : "sync.vault.stop.massOutgoingText")}
          </p>
          <ul className="max-h-48 overflow-auto rounded-md border border-border bg-background/60">
            {stop.files.map((file) => (
              <li
                key={`${file.action}\u0000${file.path}`}
                className="break-all px-2 py-1 text-[11px]"
              >
                {file.path}
              </li>
            ))}
          </ul>
          {stop.total > stop.files.length && (
            <p className="text-[11px] text-muted-foreground">
              {t("sync.vault.stop.more", { count: stop.total - stop.files.length })}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => onApprove("massChange")}
            >
              {t("sync.vault.stop.massContinue")}
            </Button>
          </div>
        </>
      )
      break
    }
    case "vaultMissing":
      body = (
        <>
          <p className="text-[13px] font-medium">{t("sync.vault.stop.missingTitle")}</p>
          <p className="text-[12px]">{t("sync.vault.stop.missingText")}</p>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCheckAgain}>
            {t("sync.vault.stop.checkAgain")}
          </Button>
        </>
      )
      break
    case "vaultEmpty":
      body = (
        <>
          <p className="text-[13px] font-medium">{t("sync.vault.stop.emptyTitle")}</p>
          <p className="text-[12px]">{t("sync.vault.stop.emptyText")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onApprove("emptyVault")}
          >
            {t("sync.vault.stop.emptyConfirm")}
          </Button>
        </>
      )
      break
    case "serverReset":
    case "serverBehind":
    case "rollback":
      body = (
        <>
          <p className="text-[13px] font-medium">{t(`sync.vault.stop.${stop.kind}Title`)}</p>
          <p className="text-[12px]">{t(`sync.vault.stop.${stop.kind}Text`)}</p>
          {resync}
        </>
      )
      break
    case "authRequired":
      body = (
        <>
          <p className="text-[13px] font-medium">{t("sync.vault.stop.authTitle")}</p>
          <p className="text-[12px]">{t("sync.vault.stop.authText")}</p>
        </>
      )
      break
    case "incompatibleServer":
      body = (
        <>
          <p className="text-[13px] font-medium">{t("sync.vault.stop.incompatibleTitle")}</p>
          <p className="text-[12px]">{t("sync.vault.stop.incompatibleText")}</p>
        </>
      )
      break
  }

  return (
    <div
      data-testid="sync-stop"
      role="alert"
      className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5"
    >
      <AlertTriangle className="size-4 text-destructive" aria-hidden="true" />
      {body}
    </div>
  )
}
