import * as React from "react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
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
import { appDataConflictKind } from "../sync/app-data-conflict"
import { AppDataConflictBody } from "../sync/sync-vault-parts"
import { useSyncNoticesStore } from "../sync/use-sync-notices-store"
import type { CentreEntry } from "./centre-entries"
import { NoticeLevelIcon, NoticeShell } from "./notice-level"
import { noticeCalmClass } from "./notice-look"
import { requestOpenNote } from "./note-open-request"
import { stopTitle } from "./stop-words"
import { useAppNoticesStore } from "./use-app-notices-store"
import { useNoticesCentre } from "./use-notices-centre"
import { useBellAnchor } from "./use-bell-anchor"
import { useNoticesCentreStore } from "./use-notices-centre-store"
import { useNoticesStackStore } from "./use-notices-stack-store"

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
    case "sync-conflict":
      return {
        title: t(
          entry.conflict?.kind === "bothCreated"
            ? "sync.vault.conflicts.createdTitle"
            : "sync.vault.conflicts.editedTitle",
          { name },
        ),
        line: t("sync.vault.conflicts.bothSafe"),
        button: t("sync.notices.compare"),
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
    case "app-notice":
      return {
        title: entry.appNotice ? t(entry.appNotice.titleKey, entry.appNotice.params) : "",
        line: entry.appNotice ? t(entry.appNotice.lineKey) : "",
        button: null,
      }
    default:
      return { title: "", line: "", button: null }
  }
}

interface RowContext {
  busy: boolean
  resolve: (id: string, choice: ConflictChoice) => void
  groups: {
    read: (id: string) => ReturnType<SyncPort["readGroupConflict"]>
    resolve: (id: string, picks: Record<string, NotePick>, stamp: string) => Promise<void>
    onError: (caught: unknown) => void
  }
}

/** One card of "Needs a decision" or "Attention": a title, one line, one main button (docs/notices.md, section 10). */
function EntryCard({ entry, context }: { entry: CentreEntry; context: RowContext }) {
  const { t, i18n } = useTranslation()
  const hide = useNoticesCentreStore((state) => state.hide)
  const dismissAppNotice = useAppNoticesStore((state) => state.dismiss)
  const openCompare = useSyncNoticesStore((state) => state.openCompare)
  const conflict = entry.conflict
  const appData = conflict ? appDataConflictKind(conflict.originalPath) : null
  const { title, line, button } = entryWords(entry, t, i18n.language)
  const go = () => {
    if (entry.action.kind === "note") requestOpenNote({ id: entry.action.id })
    else if (entry.action.kind === "compare") openCompare(entry.action.conflictId)
    else openSyncSettings()
  }
  const primary = button && (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left"
      onClick={go}
    >
      {button}
    </Button>
  )
  return (
    <NoticeShell
      level={entry.level}
      variant="calm"
      data-testid="notices-entry"
      data-entry-id={entry.id}
      data-kind={entry.kind}
      className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-foreground"
    >
      <NoticeLevelIcon level={entry.level} className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        {conflict && appData ? (
          <AppDataConflictBody
            item={conflict}
            busy={context.busy}
            onResolve={context.resolve}
            groups={context.groups}
          />
        ) : (
          <>
            <p className="text-[13px] font-medium">{title}</p>
            <p className="text-[12px] text-muted-foreground">{line}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              {primary}
              {entry.kind === "app-notice" && entry.appNotice ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => dismissAppNotice(entry.appNotice!.id)}
                >
                  {t("notices.centre.close")}
                </Button>
              ) : (
                entry.section === "warning" && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => hide(entry.id)}>
                    {t("notices.centre.hide")}
                  </Button>
                )
              )}
            </div>
          </>
        )}
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
      className={cn(
        noticeCalmClass(entry.level),
        "flex items-start gap-2 rounded-md px-2.5 py-1.5",
      )}
    >
      <NoticeLevelIcon level={entry.level} className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
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

/** The lines of the journal that are seen before "Show all". */
const JOURNAL_PREVIEW = 3

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  )
}

function StackBody({ port }: { port: SyncPort }) {
  const { t } = useTranslation()
  const centre = useNoticesCentre()
  const journal = useNoticeJournalStore((state) => state.entries)
  const clearJournal = useNoticeJournalStore((state) => state.clear)
  const close = useNoticesStackStore((state) => state.close)
  const anchor = useBellAnchor(true)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [resolving, setResolving] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [showAll, setShowAll] = React.useState(false)

  // The focus goes into the stack when it opens and back to the bell when it closes by Escape or a click away.
  React.useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])
  React.useEffect(() => {
    const bell = () => document.querySelector<HTMLElement>('[data-activity-button="notices"]')
    const closeAndReturn = () => {
      const root = rootRef.current
      const focusWasInside = Boolean(root && root.contains(document.activeElement))
      close()
      if (focusWasInside) bell()?.focus()
    }
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null
      if (!target) return
      if (rootRef.current?.contains(target)) return
      // The bell toggles by itself on its click.
      if (bell()?.contains(target)) return
      closeAndReturn()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      close()
      bell()?.focus()
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [close])

  const context: RowContext = {
    busy: resolving !== null,
    resolve: (id, choice) => {
      if (resolving !== null) return
      setResolving(id)
      setError(null)
      port
        .resolveConflict(id, choice)
        .catch((caught) => setError(syncErrorMessage(caught, t)))
        .finally(() => setResolving(null))
    },
    // З69: a conflict of a group of note properties is chosen by notes here as in the settings.
    groups: {
      read: (id) => port.readGroupConflict(id),
      resolve: (id, picks, stamp) => {
        setError(null)
        return port.resolveGroupConflict(id, picks, stamp)
      },
      onError: (caught) => setError(syncErrorMessage(caught, t)),
    },
  }

  const nothing =
    centre.decision.length === 0 && centre.warning.length === 0 && journal.length === 0
  const shownJournal = showAll ? journal : journal.slice(0, JOURNAL_PREVIEW)
  return (
    <div
      ref={rootRef}
      data-testid="notices-centre"
      role="region"
      aria-label={t("notices.centre.title")}
      tabIndex={-1}
      style={anchor}
      className="fixed z-50 flex w-[min(22rem,calc(100vw-5rem))] flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-popover p-2.5 text-popover-foreground shadow-lg outline-none"
    >
      {centre.decision.length > 0 && (
        <section data-testid="notices-section-decision" className="space-y-2">
          <Heading>{t("notices.centre.decision")}</Heading>
          {error && (
            <p role="alert" className="px-1 text-[12px] text-destructive">
              {error}
            </p>
          )}
          {centre.decision.map((entry) => (
            <EntryCard key={entry.id} entry={entry} context={context} />
          ))}
        </section>
      )}
      {centre.warning.length > 0 && (
        <section data-testid="notices-section-warning" className="space-y-2">
          <Heading>{t("notices.centre.warning")}</Heading>
          {centre.warning.map((entry) => (
            <EntryCard key={entry.id} entry={entry} context={context} />
          ))}
        </section>
      )}
      {journal.length > 0 && (
        <section data-testid="notices-section-journal" className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Heading>{t("notices.centre.earlier")}</Heading>
            <Button type="button" size="sm" variant="ghost" onClick={clearJournal}>
              {t("notices.centre.clear")}
            </Button>
          </div>
          <ul className="space-y-1">
            {shownJournal.map((entry) => (
              <JournalRow key={entry.id} entry={entry} />
            ))}
          </ul>
          {journal.length > JOURNAL_PREVIEW && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll
                ? t("notices.centre.collapse")
                : t("notices.centre.showAll", { count: journal.length })}
            </Button>
          )}
        </section>
      )}
      {nothing && (
        <p data-testid="notices-empty" className="px-1 py-1 text-[12px] text-muted-foreground">
          {t("notices.centre.journalEmpty")}
        </p>
      )}
    </div>
  )
}

/**
 * The notification centre (docs/notices.md, section 5): a floating stack of cards beside the bell of the dock,
 * growing upwards from it. "Needs a decision" and "Attention" are derived from the live causes; the journal
 * ("Earlier") is read from the data of the application. Deciding happens where it always did (the
 * comparison, the settings of the sync, the note); a card leads there with one button.
 */
export function NoticesStack({ port: given }: { port?: SyncPort }) {
  const isOpen = useNoticesStackStore((state) => state.isOpen)
  const port = React.useMemo(() => given ?? resolveSyncPort(), [given])
  if (!isOpen) return null
  return <StackBody port={port} />
}
