import { logger } from "@/lib/logger"
import type { JournalEntry, JournalKind } from "@/lib/notices/notice-journal"
import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import type { FsMutationResult, UndoRecord } from "@/lib/storage"
import { useTreeMessageStore } from "../tree/use-tree-message-store"

// «Вернуть» for a rename or a move that rewrote links and for a merge (docs/notices.md, sections 9 and 10).
// These are not asked about: after the action a line under the tree and a journal entry say what happened,
// with a button that undoes it exactly. The record that undoes it comes from the backend with the result and
// is kept in the entry; the undo itself runs in the document mutations hook, which registers it here.

/** How an undo ended; `key` (with `params`) is the text to show when it did not all happen. */
export type UndoOutcome =
  { outcome: "restored" } | { outcome: "refused"; key: string; params?: Record<string, unknown> }

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
  "renamedWithLinks" | "movedWithLinks" | "movedManyWithLinks" | "notesMerged"
>

let counter = 0

/** Whether a journal entry still offers «Вернуть». */
export function canUndo(entry: JournalEntry): boolean {
  return Boolean(entry.params.undo && !entry.params.restored)
}

function isRecord(value: unknown): value is UndoRecord {
  return typeof value === "object" && value !== null && "kind" in value
}

/** The records of an entry, in the order the operations ran: one, or one per moved item. */
function readRecords(raw: string | undefined): UndoRecord[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    const records = Array.isArray(parsed) ? parsed : [parsed]
    return records.every(isRecord) ? records : []
  } catch {
    // A damaged entry offers nothing; the journal keeps the line itself.
    return []
  }
}

/**
 * Runs the undo of an entry and marks it done. The operations are undone from the last to the first, each
 * exactly or not at all (the backend checks it). When one is refused, the ones already undone stay undone,
 * the entry keeps the rest, and the outcome says how many came back: nothing is lost either way.
 */
export async function undoFromJournal(entry: JournalEntry): Promise<UndoOutcome> {
  const records = readRecords(entry.params.undo)
  if (!records.length || !applier) return { outcome: "refused", key: "notices.journal.undoFailed" }
  const journal = useNoticeJournalStore.getState()
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const result = await applier(records[index])
    if (result.outcome === "restored") continue
    const done = records.length - 1 - index
    if (done === 0) return result
    journal.amend(entry.kind, entry.subject, {
      undo: JSON.stringify(records.slice(0, index + 1)),
    })
    return {
      outcome: "refused",
      key: "notices.journal.undoPartial",
      params: { done, total: records.length },
    }
  }
  journal.amend(entry.kind, entry.subject, { restored: "1" })
  return { outcome: "restored" }
}

/**
 * The notes whose links the operations rewrote, other than the moved or renamed items themselves and a
 * database description. This is the number the line and the entry name.
 */
export function rewrittenNoteCount(records: UndoRecord[]): number {
  const items = new Set(
    records.map((record) => (record.kind === "merge" ? record.target.path : record.primaryPath)),
  )
  const notes = new Set<string>()
  for (const record of records) {
    if (record.kind === "merge") return 1
    for (const note of record.rewritten) {
      if (!items.has(note.path) && /\.md$/iu.test(note.path)) notes.add(note.path)
    }
  }
  return notes.size
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
 * with «Вернуть». `results` are the mutations of one action in the order they ran (several for a move of
 * several items); they are undone together. Nothing is said when no other note was changed.
 */
export function announceUndoable(results: FsMutationResult[], announcement: Announcement): void {
  const records = results.flatMap((result) => (result.undo ? [result.undo] : []))
  if (!records.length) return
  const count = rewrittenNoteCount(records)
  if (count === 0) return
  counter += 1
  const subject = `${Date.now().toString(36)}-${counter.toString(36)}`
  const undo = JSON.stringify(records.length === 1 ? records[0] : records)
  useNoticeJournalStore.getState().record({
    kind: announcement.kind,
    level: "info",
    subject,
    params: { ...announcement.params, count: String(count), undo },
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
    params: { ...announcement.params, count },
    lineKey: announcement.lineKey,
    action: {
      labelKey: "notices.journal.restore",
      run: async () => {
        const entry = entryOf()
        const outcome: UndoOutcome = entry
          ? await undoFromJournal(entry)
          : { outcome: "refused", key: "notices.journal.undoFailed" }
        if (outcome.outcome === "restored") return
        logger.info("file.undo_refused", { kind: announcement.kind, key: outcome.key })
        useTreeMessageStore.getState().show({
          id: `undo-failed:${subject}`,
          level: "warning",
          titleKey: "notices.tree.undoFailed",
          lineKey: outcome.key,
          ...(outcome.params ? { params: outcome.params } : {}),
        })
      },
    },
  })
}
