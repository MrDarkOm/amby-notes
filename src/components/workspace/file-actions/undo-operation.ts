import { logger } from "@/lib/logger"
import type { JournalEntry, JournalKind } from "@/lib/notices/notice-journal"
import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import type { FsMutationResult, UndoRecord } from "@/lib/storage"
import { useTreeMessageStore } from "../tree/use-tree-message-store"

// «Вернуть» for a rename or a move that rewrote links and for a merge (docs/notices.md, sections 9 and 10).
// These are not asked about: after the action a line under the tree and a journal entry say what happened,
// with a button that undoes it exactly. The record that undoes it comes from the backend with the result and
// is kept in the entry; the undo itself runs in the document mutations hook, which registers it here.

/** How an undo ended; `key` is the text to show when it did not happen. */
export type UndoOutcome = { outcome: "restored" } | { outcome: "refused"; key: string }

type UndoApplier = (record: UndoRecord) => Promise<UndoOutcome>

let applier: UndoApplier | null = null

/** The workspace sets who runs the undo; the returned function takes it away again. */
export function registerUndoApplier(next: UndoApplier): () => void {
  applier = next
  return () => {
    if (applier === next) applier = null
  }
}

export type UndoableKind = Extract<
  JournalKind,
  "renamedWithLinks" | "movedWithLinks" | "notesMerged"
>

let counter = 0

/** Whether a journal entry still offers «Вернуть». */
export function canUndo(entry: JournalEntry): boolean {
  return Boolean(entry.params.undo && !entry.params.restored)
}

function readRecord(raw: string | undefined): UndoRecord | null {
  if (!raw) return null
  try {
    const record = JSON.parse(raw) as UndoRecord
    return typeof record === "object" && record !== null && "kind" in record ? record : null
  } catch {
    // A damaged entry offers nothing; the journal keeps the line itself.
    return null
  }
}

/** Runs the undo of an entry and marks it done. */
export async function undoFromJournal(entry: JournalEntry): Promise<UndoOutcome> {
  const record = readRecord(entry.params.undo)
  if (!record || !applier) return { outcome: "refused", key: "notices.journal.undoFailed" }
  const result = await applier(record)
  if (result.outcome === "restored") {
    useNoticeJournalStore.getState().amend(entry.kind, entry.subject, { restored: "1" })
  }
  return result
}

/**
 * The notes whose links the operation rewrote, other than the item itself and a database description.
 * This is the number the line and the entry name.
 */
export function rewrittenNoteCount(record: UndoRecord): number {
  if (record.kind === "merge") return 1
  return record.rewritten.filter(
    (note) => note.path !== record.primaryPath && /\.md$/iu.test(note.path),
  ).length
}

interface Announcement {
  kind: UndoableKind
  /** Words of the journal entry and of the line. */
  params: Record<string, string>
  /** The title of the line under the tree, a key of `notices.tree`. */
  titleKey: string
  /** The second line, a key of `notices.tree`. */
  lineKey: string
  /** The note the entry is about, as a path in the vault. */
  target?: string
}

/**
 * Says that an operation which changed other notes is done: a journal entry and a line under the tree, each
 * with «Вернуть». Does nothing when the result carries no record (nothing else was changed).
 */
export function announceUndoable(result: FsMutationResult, announcement: Announcement): void {
  const record = result.undo
  if (!record) return
  counter += 1
  const subject = `${Date.now().toString(36)}-${counter.toString(36)}`
  const count = String(rewrittenNoteCount(record))
  const params = { ...announcement.params, count, undo: JSON.stringify(record) }
  useNoticeJournalStore.getState().record({
    kind: announcement.kind,
    level: "info",
    subject,
    params,
    ...(announcement.target ? { target: announcement.target } : {}),
  })
  const entryOf = () =>
    useNoticeJournalStore
      .getState()
      .entries.find((entry) => entry.kind === announcement.kind && entry.subject === subject)
  useTreeMessageStore.getState().show({
    id: `undo:${subject}`,
    level: "info",
    titleKey: announcement.titleKey,
    params: { ...announcement.params, count: Number(count) },
    lineKey: announcement.lineKey,
    action: {
      labelKey: "notices.journal.restore",
      run: async () => {
        const entry = entryOf()
        const outcome = entry
          ? await undoFromJournal(entry)
          : ({ outcome: "refused", key: "notices.journal.undoFailed" } as const)
        if (outcome.outcome === "restored") return
        logger.info("file.undo_refused", { kind: record.kind, key: outcome.key })
        useTreeMessageStore.getState().show({
          id: `undo-failed:${subject}`,
          level: "warning",
          titleKey: "notices.tree.undoFailed",
          lineKey: outcome.key,
        })
      },
    },
  })
}
