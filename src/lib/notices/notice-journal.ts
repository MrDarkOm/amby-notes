// The journal of the notification centre (docs/notices.md, section 5): the events of the levels `info` and
// `success`, newest first, kept for seven days. Pure functions over a list; storage is in
// journal-storage.ts and the live list in use-notice-journal-store.ts.

/** How long an entry is kept, in days. */
export const JOURNAL_DAYS = 7

/** The most entries kept: a guard against a runaway source, far above what a week brings. */
const JOURNAL_MAX_ENTRIES = 500

const DAY_MS = 24 * 60 * 60 * 1000
const FILE_VERSION = 1

type JournalLevel = "info" | "success"

/**
 * What happened. The text is made from the kind and the params when the journal is read, in the language
 * of the person at that time; an unknown kind (from a newer Amby) is shown with a general text.
 */
type JournalKind = "restored" | "conflictOutcome" | "merged" | "backupReady" | "updateFailed"

export interface JournalEntry {
  id: string
  kind: JournalKind
  level: JournalLevel
  /** What the cause is: the same kind with the same subject is one entry with a number. */
  subject: string
  /** The last time it happened, Unix milliseconds. */
  at: number
  /** How many times it happened. */
  count: number
  /** Words for the text (the name of the note, the choice made). */
  params: Record<string, string>
  /** The note the entry is about, as a path in the vault, if any. */
  target?: string
}

export interface JournalInput {
  kind: JournalKind
  level: JournalLevel
  subject: string
  params: Record<string, string>
  target?: string
}

let counter = 0
function newId(at: number): string {
  counter += 1
  return `${at.toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Entries from newest to oldest. */
function byNewest(entries: JournalEntry[]): JournalEntry[] {
  return [...entries].sort((a, b) => b.at - a.at)
}

/**
 * Adds an event. The same cause again (same kind and subject) is not a second entry: the existing one
 * moves to the top with its number raised.
 */
export function addJournalEntry(
  entries: JournalEntry[],
  input: JournalInput,
  now: number,
): JournalEntry[] {
  const same = entries.find((item) => item.kind === input.kind && item.subject === input.subject)
  const entry: JournalEntry = same
    ? { ...same, level: input.level, at: now, count: same.count + 1, params: input.params }
    : {
        id: newId(now),
        kind: input.kind,
        level: input.level,
        subject: input.subject,
        at: now,
        count: 1,
        params: input.params,
      }
  if (input.target !== undefined) entry.target = input.target
  const rest = entries.filter((item) => item !== same)
  return byNewest([entry, ...rest]).slice(0, JOURNAL_MAX_ENTRIES)
}

/** Forgets what is older than the term. */
export function pruneJournal(entries: JournalEntry[], now: number): JournalEntry[] {
  return entries.filter((entry) => now - entry.at <= JOURNAL_DAYS * DAY_MS)
}

/** Joins two lists (for example what was read and what happened meanwhile), one entry per cause. */
export function mergeJournals(a: JournalEntry[], b: JournalEntry[]): JournalEntry[] {
  const byCause = new Map<string, JournalEntry>()
  for (const entry of [...a, ...b]) {
    const key = `${entry.kind}\u0000${entry.subject}`
    const known = byCause.get(key)
    if (!known) byCause.set(key, entry)
    else {
      const latest = entry.at >= known.at ? entry : known
      byCause.set(key, { ...latest, count: known.count + entry.count })
    }
  }
  return byNewest([...byCause.values()]).slice(0, JOURNAL_MAX_ENTRIES)
}

export function serializeJournal(entries: JournalEntry[]): string {
  return JSON.stringify({ version: FILE_VERSION, entries })
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  )
}

function readEntry(value: unknown): JournalEntry | null {
  if (typeof value !== "object" || value === null) return null
  const item = value as Record<string, unknown>
  if (
    typeof item.id !== "string" ||
    typeof item.kind !== "string" ||
    (item.level !== "info" && item.level !== "success") ||
    typeof item.subject !== "string" ||
    typeof item.at !== "number" ||
    !Number.isFinite(item.at) ||
    typeof item.count !== "number" ||
    !Number.isInteger(item.count) ||
    item.count < 1 ||
    !isStringMap(item.params) ||
    (item.target !== undefined && typeof item.target !== "string")
  ) {
    return null
  }
  const entry: JournalEntry = {
    id: item.id,
    kind: item.kind as JournalKind,
    level: item.level,
    subject: item.subject,
    at: item.at,
    count: item.count,
    params: item.params,
  }
  if (typeof item.target === "string") entry.target = item.target
  return entry
}

/**
 * Reads the file. No file is an empty journal. A file that is not the journal (not JSON, another shape, a
 * version from the future) is an empty one that is said to be `damaged`, so the caller can note it in the
 * log; one broken entry among good ones is dropped alone.
 */
export function parseJournal(raw: string | null): { entries: JournalEntry[]; damaged: boolean } {
  if (raw === null) return { entries: [], damaged: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { entries: [], damaged: true }
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== FILE_VERSION ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    return { entries: [], damaged: true }
  }
  const entries = (parsed as { entries: unknown[] }).entries
    .map(readEntry)
    .filter((entry): entry is JournalEntry => entry !== null)
  return { entries: byNewest(entries), damaged: false }
}
