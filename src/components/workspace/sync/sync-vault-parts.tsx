import * as React from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { formatSize } from "@/lib/sync/format-size"
import type { ApprovalKind, ConflictChoice, VaultSyncStatus } from "@/lib/sync/sync-port"
import { appDataConflictKind, isPropertyGroupPath } from "./app-data-conflict"
import { conflictName } from "./conflict-outcome"
import { GroupConflictChooser, type GroupConflictActions } from "./sync-group-conflict"

type Stop = NonNullable<VaultSyncStatus["stop"]>
type Conflict = VaultSyncStatus["conflicts"][number]
type Unsynced = VaultSyncStatus["unsynced"][number]

/** The reasons the interface has a text for; anything else is "not recognised" (a newer Amby). */
const UNSYNCED_REASONS = [
  "symlink",
  "notUtf8",
  "tooLarge",
  "quotaFull",
  "subscriptionRequired",
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

function reasonText(
  item: Unsynced,
  t: ReturnType<typeof useTranslation>["t"],
  language: string,
): string {
  if (!(UNSYNCED_REASONS as readonly string[]).includes(item.reason)) {
    return t("sync.vault.unsynced.unknown")
  }
  if (item.reason === "tooLarge" && typeof item.maxBytes === "number") {
    return t(
      item.limitSource === "server"
        ? "sync.vault.unsynced.tooLargeServer"
        : "sync.vault.unsynced.tooLargePlan",
      {
        size: formatSize(item.maxBytes, language),
      },
    )
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
  const { t, i18n } = useTranslation()
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
            <p className="text-[11px] text-muted-foreground">
              {reasonText(item, t, i18n.language)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * What a conflict of the data Amby keeps for itself says and offers: a sentence and its two choices, or, for a
 * group of note properties that has a base, the choice by notes (З69). Worn by the list of the settings and by
 * the card of the notification centre.
 */
export function AppDataConflictBody({
  item,
  busy,
  onResolve,
  groups,
}: {
  item: Conflict
  busy: boolean
  onResolve: (id: string, choice: ConflictChoice) => void
  groups?: GroupConflictActions
}) {
  const { t } = useTranslation()
  const appData = appDataConflictKind(item.originalPath)
  if (!appData) return null
  // З69: the set is synchronised. On the computer that did not make it, the version in the file came
  // from the other computer and the second version is this one's, so the names of the sides swap.
  const swapped = item.createdHere === false
  const byNotes =
    groups !== undefined && item.hasBase === true && isPropertyGroupPath(item.originalPath)
  const choices = (
    <div className="flex flex-wrap gap-2">
      {(
        [
          [
            "keepOriginal",
            swapped
              ? "sync.vault.conflicts.appData.keepOther"
              : "sync.vault.conflicts.appData.keepThis",
          ],
          [
            "keepCopy",
            swapped
              ? "sync.vault.conflicts.appData.keepThis"
              : "sync.vault.conflicts.appData.keepOther",
          ],
        ] as const
      ).map(([choice, key]) => (
        <Button
          key={choice}
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onResolve(item.id, choice)}
        >
          {t(key)}
        </Button>
      ))}
    </div>
  )
  if (byNotes) {
    return (
      <GroupConflictChooser
        id={item.id}
        actions={groups}
        disabled={busy}
        swapped={swapped}
        fallback={
          <>
            <p className="text-[12px]">{t("sync.vault.conflicts.appData.properties")}</p>
            {choices}
            <p className="text-[11px] text-muted-foreground">
              {t("sync.vault.conflicts.appData.hint")}
            </p>
          </>
        }
      />
    )
  }
  return (
    <>
      <p className="text-[12px]">{t(`sync.vault.conflicts.appData.${appData}`)}</p>
      {choices}
    </>
  )
}

/**
 * The conflicts waiting for the person (Р7), in the settings of the sync. A conflict of a note is a title, one
 * line that both versions are safe and one button: the choice is made in the comparison, where both versions
 * are seen (docs/notices.md, section 10). The notification centre shows the same conflicts as cards.
 */
export function ConflictList({
  items,
  busyId,
  onResolve,
  onCompare,
  groups,
}: {
  items: Conflict[]
  busyId: string | null
  onResolve: (id: string, choice: ConflictChoice) => void
  /** Opens the two versions of a note side by side. */
  onCompare: (id: string) => void
  /** The choice by notes for a group of note properties that has a base (З69). */
  groups?: GroupConflictActions
}) {
  const { t } = useTranslation()
  if (items.length === 0) return null
  return (
    <section data-testid="sync-conflicts" className="space-y-1.5">
      <h4 className="text-[12px] font-medium text-muted-foreground">
        {t("sync.vault.conflicts.title", { count: items.length })}
      </h4>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {items.map((item) =>
          appDataConflictKind(item.originalPath) ? (
            <li key={item.id} className="space-y-2 px-3 py-2.5">
              <AppDataConflictBody
                item={item}
                busy={busyId !== null}
                onResolve={onResolve}
                groups={groups}
              />
            </li>
          ) : (
            <li key={item.id} className="space-y-2 px-3 py-2.5">
              <p className="text-[13px] font-medium">
                {t(
                  item.kind === "bothCreated"
                    ? "sync.vault.conflicts.createdTitle"
                    : "sync.vault.conflicts.editedTitle",
                  { name: conflictName(item.originalPath) },
                )}
              </p>
              <p className="text-[12px] text-muted-foreground">
                {t("sync.vault.conflicts.bothSafe")}
              </p>
              <Button type="button" size="sm" onClick={() => onCompare(item.id)}>
                {t("sync.notices.compare")}
              </Button>
            </li>
          ),
        )}
      </ul>
      {items.some(
        (item) =>
          appDataConflictKind(item.originalPath) &&
          !(
            groups !== undefined &&
            item.hasBase === true &&
            isPropertyGroupPath(item.originalPath)
          ),
      ) && (
        <p className="text-[11px] text-muted-foreground">
          {t("sync.vault.conflicts.appData.hint")}
        </p>
      )}
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
