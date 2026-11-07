import * as React from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import type { JournalEntry } from "@/lib/notices/notice-journal"
import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import { formatSize } from "@/lib/sync/format-size"
import { syncErrorMessage } from "@/lib/sync/sync-errors"
import {
  resolveSyncPort,
  type ConflictChoice,
  type NotePick,
  type SyncPort,
} from "@/lib/sync/sync-port"
import { OPEN_SETTINGS_REQUEST_EVENT } from "../settings-navigation"
import { ConflictList } from "../sync/sync-vault-parts"
import { useSyncNoticesStore } from "../sync/use-sync-notices-store"
import type { CentreEntry } from "./centre-entries"
import { NoticeLevelIcon, NoticeShell } from "./notice-level"
import { requestOpenNote } from "./note-open-request"
import { stopTitle } from "./stop-words"
import { useNoticesCentre } from "./use-notices-centre"
import { useNoticesCentreStore } from "./use-notices-centre-store"

function openSyncSettings(): void {
  window.dispatchEvent(
    new CustomEvent(OPEN_SETTINGS_REQUEST_EVENT, { detail: { section: "sync" } }),
  )
}

/** The title, the one line under it and the main button of a record (docs/notices.md, section 10). */
function entryWords(
  entry: CentreEntry,
  t: (key: string, options?: Record<string, unknown>) => string,
  language: string,
): { title: string; line: string; button: string | null } {
  const name = entry.name ?? ""
  switch (entry.kind) {
    case "sync-stop": {
      const { key, params } = entry.stop
        ? stopTitle(entry.stop)
        : { key: "notices.centre.stopUnknown", params: { count: 0 } }
      return {
        title: t(key, params),
        line: t("notices.centre.stopLine"),
        button: t("notices.centre.openSyncSettings"),
      }
    }
    case "note-card":
      return {
        title: t(`notices.centre.note.${entry.card}.title`, { name }),
        line: t(`notices.centre.note.${entry.card}.line`),
        button: t("notices.centre.openNote"),
      }
    case "closed-save-failed":
      return {
        title: t("notices.centre.closedSaveFailed", { name }),
        line: t("notices.centre.closedSaveFailedLine"),
        button: t("notices.centre.open"),
      }
    case "limit-too-large":
      return {
        title: t("notices.centre.tooLarge", { count: entry.count ?? 0 }),
        line: t("notices.centre.tooLargeLine", {
          limit: formatSize(entry.maxBytes ?? 0, language),
        }),
        button: t("notices.centre.show"),
      }
    case "limit-quota-full":
      return {
        title: t("notices.centre.quotaFull"),
        line: t("notices.centre.quotaFullLine"),
        button: null,
      }
    case "item-errors":
      return {
        title: t("notices.centre.itemErrors", { count: entry.count ?? 0 }),
        line: t("notices.centre.itemErrorsLine"),
        button: t("notices.centre.show"),
      }
    default:
      return { title: "", line: "", button: null }
  }
}

function EntryRow({ entry }: { entry: CentreEntry }) {
  const { t, i18n } = useTranslation()
  const hide = useNoticesCentreStore((state) => state.hide)
  const { title, line, button } = entryWords(entry, t, i18n.language)
  const go = () => {
    if (entry.action.kind === "note") requestOpenNote({ id: entry.action.id })
    else openSyncSettings()
  }
  return (
    <NoticeShell
      level={entry.level}
      data-testid="notices-entry"
      data-entry-id={entry.id}
      data-kind={entry.kind}
      className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-foreground"
    >
      <NoticeLevelIcon level={entry.level} className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="text-[12px] text-muted-foreground">{line}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {button && (
            <Button type="button" size="sm" variant="outline" onClick={go}>
              {button}
            </Button>
          )}
          {entry.section === "warning" && (
            <Button type="button" size="sm" variant="ghost" onClick={() => hide(entry.id)}>
              {t("notices.centre.hide")}
            </Button>
          )}
        </div>
      </div>
    </NoticeShell>
  )
}

/** What an entry of the journal says, in the language of the person now. */
function journalWords(
  entry: JournalEntry,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const name = entry.params.name ?? ""
  switch (entry.kind) {
    case "restored":
      return t("sync.notices.restoredAfterDeletion", { name })
    case "conflictOutcome":
      return t(`sync.notices.outcome.${entry.params.choice ?? "keepBoth"}`, { name })
    case "merged":
      return t("notices.journal.merged", { name })
    case "backupReady":
      return t("notices.journal.backupReady")
    case "updateFailed":
      return t("notices.journal.updateFailed")
    default:
      return t("notices.journal.unknown")
  }
}

function formatWhen(at: number, language: string): string {
  const date = new Date(at)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return new Intl.DateTimeFormat(
    language,
    sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" },
  ).format(date)
}

function JournalRow({ entry }: { entry: JournalEntry }) {
  const { t, i18n } = useTranslation()
  return (
    <li
      data-testid="notices-journal-entry"
      data-level={entry.level}
      className="flex items-start gap-2 px-3 py-2"
    >
      <NoticeLevelIcon level={entry.level} className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-[12px] text-foreground">
          {journalWords(entry, t)}
          {entry.count > 1 && <span className="ml-1 text-muted-foreground">×{entry.count}</span>}
        </p>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <time dateTime={new Date(entry.at).toISOString()}>
            {formatWhen(entry.at, i18n.language)}
          </time>
          {entry.target && (
            <button
              type="button"
              className="underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => requestOpenNote({ path: entry.target as string })}
            >
              {t("notices.centre.open")}
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

/**
 * The notification centre (docs/notices.md, section 5): a side panel of three sections. "Needs a decision"
 * and "Attention" are derived from the live causes; the journal is read from the data of the application.
 * Deciding happens where it always did (the comparison, the settings of the sync, the note); the centre
 * leads there with one button.
 */
export function NoticesPanel({ port: given }: { port?: SyncPort }) {
  const { t } = useTranslation()
  const port = React.useMemo(() => given ?? resolveSyncPort(), [given])
  const centre = useNoticesCentre()
  const journal = useNoticeJournalStore((state) => state.entries)
  const clearJournal = useNoticeJournalStore((state) => state.clear)
  const openCompare = useSyncNoticesStore((state) => state.openCompare)
  const [resolving, setResolving] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const resolve = (id: string, choice: ConflictChoice) => {
    if (resolving !== null) return
    setResolving(id)
    setError(null)
    port
      .resolveConflict(id, choice)
      .catch((caught) => setError(syncErrorMessage(caught, t)))
      .finally(() => setResolving(null))
  }
  // З69: a conflict of a group of note properties is chosen by notes here as in the settings.
  const groupActions = React.useMemo(
    () => ({
      read: (id: string) => port.readGroupConflict(id),
      resolve: (id: string, picks: Record<string, NotePick>, stamp: string) => {
        setError(null)
        return port.resolveGroupConflict(id, picks, stamp)
      },
      onError: (caught: unknown) => setError(syncErrorMessage(caught, t)),
    }),
    [port, t],
  )

  const conflicts = centre.decision.flatMap((entry) => (entry.conflict ? [entry.conflict] : []))
  const others = centre.decision.filter((entry) => !entry.conflict)

  return (
    <div data-testid="notices-centre" className="flex h-full min-h-0 flex-col overflow-y-auto">
      <h2 className="px-3 pb-1 pt-3 text-[13px] font-semibold">{t("notices.centre.title")}</h2>
      {centre.decision.length > 0 && (
        <section data-testid="notices-section-decision" className="space-y-2 px-3 py-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("notices.centre.decision")}
          </h3>
          {error && (
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
          )}
          {others.map((entry) => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
          <ConflictList
            items={conflicts}
            busyId={resolving}
            onResolve={resolve}
            groups={groupActions}
            onCompare={openCompare}
          />
        </section>
      )}
      {centre.warning.length > 0 && (
        <section data-testid="notices-section-warning" className="space-y-2 px-3 py-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("notices.centre.warning")}
          </h3>
          {centre.warning.map((entry) => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
        </section>
      )}
      <section data-testid="notices-section-journal" className="space-y-2 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("notices.centre.journal")}
          </h3>
          {journal.length > 0 && (
            <Button type="button" size="sm" variant="ghost" onClick={clearJournal}>
              {t("notices.centre.clear")}
            </Button>
          )}
        </div>
        {journal.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">{t("notices.centre.journalEmpty")}</p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {journal.map((entry) => (
              <JournalRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
