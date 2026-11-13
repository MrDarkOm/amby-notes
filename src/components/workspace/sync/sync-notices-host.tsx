import { reportSyncListenFailed } from "./listen-failure"
import * as React from "react"

import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import { resolveSyncPort, type SyncPort } from "@/lib/sync/sync-port"
import { relativeToVault } from "../editor/document-breadcrumbs-utils"
import { stopTitle } from "../notices/stop-words"
import { useNoticeToastStore } from "../notices/use-notice-toasts-store"
import { useNoticesCentreStore } from "../notices/use-notices-centre-store"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { SyncCompareDialog } from "./sync-compare-dialog"
import { conflictName } from "./conflict-outcome"
import { limitNoticesOf } from "./limit-notices"
import {
  rereadOpenNoteProperties,
  touchesNoteProperties,
} from "../orchestration/reread-note-properties"
import { useSyncNoticesStore, type SyncConflict } from "./use-sync-notices-store"

function noteName(path: string): string {
  const file = path.split("/").pop() ?? path
  return file.replace(/\.md$/iu, "")
}

/** Whether a note of the vault is open now, by its path in the vault. */
function isOpen(path: string): boolean {
  const root = useVaultStore.getState().vault
  if (!root) return false
  return Object.values(useDocStore.getState().openDocs).some(
    (doc) => relativeToVault(doc.path, root).normalize("NFC") === path.normalize("NFC"),
  )
}

/**
 * Announces new conflicts of notes that are not open (docs/notices.md, sections 4 and 6): one toast for one
 * cause, and one toast with a number for several that came together. A note that is open says it in its
 * own strip; the conflicts of the service data have no note to be open, so they are announced.
 */
function announceConflicts(fresh: SyncConflict[], serial: number): void {
  const unseen = fresh.filter((item) => !isOpen(item.originalPath))
  if (unseen.length === 0) return
  const toasts = useNoticeToastStore.getState()
  const only = unseen[0]
  if (unseen.length === 1 && only && !only.originalPath.startsWith(".amby/")) {
    toasts.announce({
      id: `sync-conflict:${only.id}`,
      level: "decision",
      titleKey:
        only.kind === "bothCreated"
          ? "sync.vault.conflicts.createdTitle"
          : "sync.vault.conflicts.editedTitle",
      params: { name: conflictName(only.originalPath) },
      target: { kind: "centre" },
    })
    return
  }
  toasts.announce({
    id: `sync-conflicts:${serial}`,
    level: "decision",
    titleKey: "notices.toast.newConflicts",
    target: { kind: "centre" },
    count: unseen.length,
  })
}

/**
 * Keeps the rest of the application informed about the sync of the open vault (Р7, Р8): the causes the
 * notification centre derives its sections from (conflicts, a stop, the limits, the files that failed), the
 * announcements of what is new (docs/notices.md, section 6), the events that go to the journal, the
 * comparison of a conflict, and the mark for a note that another computer deleted while it was open. The
 * cards in the notes are [`NoteNotices`](../note-notices/note-notices.tsx); both read the same store.
 */
export function SyncNoticesHost({ port: given }: { port?: SyncPort }) {
  const port = React.useMemo(() => given ?? resolveSyncPort(), [given])
  const vault = useVaultStore((state) => state.vault)
  const conflicts = useSyncNoticesStore((state) => state.conflicts)
  const compareId = useSyncNoticesStore((state) => state.compareId)
  const closeCompare = useSyncNoticesStore((state) => state.closeCompare)
  const seen = React.useRef<Set<string> | null>(null)
  const seenStop = React.useRef<string | null | undefined>(undefined)
  const seenBackup = React.useRef<string | null | undefined>(undefined)
  const counter = React.useRef(0)

  React.useEffect(() => {
    // A new vault (or window) starts from its own status: what is there is the starting point, not news.
    seen.current = null
    seenStop.current = undefined
    seenBackup.current = undefined
    useSyncNoticesStore.setState({
      conflicts: [],
      remoteDeleted: [],
      compareId: null,
      limits: [],
      stop: null,
      itemErrors: 0,
      outcomes: [],
    })
    useNoteNoticesStore.setState({ restored: [], merged: [] })
    useNoticesCentreStore.getState().reset()
    useNoticeToastStore.getState().clear()
    let alive = true
    const unlisten: Array<() => void> = []
    const takeConflicts = (next: SyncConflict[]) => {
      useSyncNoticesStore.getState().setConflicts(next)
      const known = seen.current
      seen.current = new Set(next.map((item) => item.id))
      // The first status is the baseline: a conflict that was already there is not news.
      if (known === null) return
      // A toast goes with its cause.
      for (const id of known) {
        if (!seen.current.has(id)) useNoticeToastStore.getState().dismiss(`sync-conflict:${id}`)
      }
      const fresh = next.filter((item) => !known.has(item.id))
      if (fresh.length > 0) {
        counter.current += 1
        announceConflicts(fresh, counter.current)
      }
    }
    const takeStop = (status: Parameters<typeof limitNoticesOf>[0]) => {
      const kind = status.stop?.kind ?? null
      const known = seenStop.current
      seenStop.current = kind
      if (known === undefined || known === kind) return
      if (known !== null) useNoticeToastStore.getState().dismiss(`sync-stop:${known}`)
      if (status.stop) {
        const { key, params } = stopTitle(status.stop)
        useNoticeToastStore.getState().announce({
          id: `sync-stop:${status.stop.kind}`,
          level: "decision",
          titleKey: key,
          params,
          target: { kind: "centre" },
        })
      }
    }
    // The copy of the vault that is made before the first pass is a long action of the person (switching sync
    // on): its end is a success for the journal. A copy that was there at the start is not news.
    const takeBackup = (status: Parameters<typeof limitNoticesOf>[0]) => {
      const path = status.backupPath ?? null
      const known = seenBackup.current
      seenBackup.current = path
      if (known === undefined || path === null || path === known) return
      useNoticeJournalStore
        .getState()
        .record({ kind: "backupReady", level: "success", subject: "sync-backup", params: {} })
    }
    const takeStatus = (status: Parameters<typeof limitNoticesOf>[0]) => {
      useSyncNoticesStore.getState().setStatusSummary({
        limits: limitNoticesOf(status),
        stop: status.stop,
        itemErrors: status.itemErrors,
      })
      takeStop(status)
      takeBackup(status)
      takeConflicts(status.conflicts)
    }
    port
      .vaultStatus()
      .then((status) => {
        if (!alive) return
        // A status that came by an event while this was asked is newer: the first one is the baseline.
        if (seen.current === null) takeStatus(status)
      })
      .catch(() => {
        // No status (the browser build, a failed start): the centre has nothing to say yet, and the next event will.
      })
    port
      .onVaultStatus((status) => {
        if (!alive) return
        takeStatus(status)
      })
      .then((off) => (alive ? unlisten.push(off) : off()))
      .catch((error: unknown) => {
        // The browser build answers with a listener that never fires, so a refusal is a real failure: the
        // stops, limits and conflicts of the centre would not be updated. Said once, in the centre.
        if (alive) reportSyncListenFailed(error)
      })
    port
      .onRemoteDeleted((event) => {
        if (!alive) return
        const root = useVaultStore.getState().vault
        // A report about another vault is late news about the one that was open before: it must not
        // mark a note of this vault that only happens to have the same path.
        if (!root || event.vault !== root) return
        for (const path of event.paths) {
          // Only a note that was open gets a message (Р8): an unopened one just goes to the archive.
          if (isOpen(path)) useSyncNoticesStore.getState().markRemoteDeleted(path.normalize("NFC"))
        }
      })
      .then((off) => (alive ? unlisten.push(off) : off()))
      .catch(() => {
        // Nothing to listen to without the desktop application.
      })
    port
      .onRestoredAfterDeletion((paths) => {
        // Said whether or not the note is open: a note that comes back unannounced looks like a bug. It is
        // information: the journal keeps it, and an open note says it in its own strip. No toast.
        if (!alive) return
        for (const path of paths) {
          const normalized = path.normalize("NFC")
          useNoticeJournalStore.getState().record({
            kind: "restored",
            level: "info",
            subject: normalized,
            params: { name: noteName(normalized) },
            target: normalized,
          })
          if (isOpen(normalized)) useNoteNoticesStore.getState().markRestored(normalized)
        }
      })
      .then((off) => (alive ? unlisten.push(off) : off()))
      .catch(() => {
        // Nothing to listen to without the desktop application.
      })
    port
      .onMerged((paths) => {
        // The program changed the text of a person by itself: it says so (docs/notices.md, section 12). The
        // earlier version was put into the history before the merge.
        if (!alive) return
        for (const path of paths) {
          const normalized = path.normalize("NFC")
          useNoticeJournalStore.getState().record({
            kind: "merged",
            level: "info",
            subject: normalized,
            params: { name: noteName(normalized) },
            target: normalized,
          })
          if (isOpen(normalized)) useNoteNoticesStore.getState().markMerged(normalized)
        }
      })
      .then((off) => (alive ? unlisten.push(off) : off()))
      .catch(() => {
        // Nothing to listen to without the desktop application.
      })
    port
      .onAmbyWritten((paths) => {
        // A pass wrote the groups of properties: the panels of the open notes read them again (З65).
        if (!alive || !touchesNoteProperties(paths)) return
        const state = useVaultStore.getState()
        if (state.vault) void rereadOpenNoteProperties(state.vault, state.generation)
      })
      .then((off) => (alive ? unlisten.push(off) : off()))
      .catch(() => {
        // Nothing to listen to without the desktop application.
      })
    return () => {
      alive = false
      for (const off of unlisten) off()
    }
  }, [port, vault])

  // A mark goes stale when the note is back (the file reappeared) or its document was closed.
  React.useEffect(
    () =>
      useDocStore.subscribe((state) => {
        const root = useVaultStore.getState().vault
        const { remoteDeleted, clearRemoteDeleted } = useSyncNoticesStore.getState()
        if (!root) return
        const stillOpen = (path: string) =>
          Object.values(state.openDocs).some(
            (item) => relativeToVault(item.path, root).normalize("NFC") === path,
          )
        // The card that says what a choice did goes with the note it was about.
        for (const outcome of useSyncNoticesStore.getState().outcomes) {
          if (!stillOpen(outcome.path))
            useSyncNoticesStore.getState().dismissOutcome(outcome.conflictId)
        }
        for (const path of useNoteNoticesStore.getState().restored) {
          if (!stillOpen(path)) useNoteNoticesStore.getState().clearRestored(path)
        }
        for (const path of useNoteNoticesStore.getState().merged) {
          if (!stillOpen(path)) useNoteNoticesStore.getState().clearMerged(path)
        }
        for (const path of remoteDeleted) {
          const doc = Object.values(state.openDocs).find(
            (item) => relativeToVault(item.path, root).normalize("NFC") === path,
          )
          if (!doc || doc.externallyDeleted === false) clearRemoteDeleted(path)
        }
      }),
    [],
  )

  const comparing = conflicts.find((item) => item.id === compareId)

  return comparing && vault ? (
    <SyncCompareDialog port={port} conflict={comparing} onClose={closeCompare} />
  ) : null
}
