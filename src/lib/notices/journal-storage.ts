import { errorType, logger } from "@/lib/logger"
import { readGlobalRaw, writeGlobalRaw } from "@/lib/storage"
import { parseJournal, pruneJournal, serializeJournal, type JournalEntry } from "./notice-journal"

/** The folder of the journals in the data of the application (next to the settings, never in `.amby/`). */
const JOURNAL_DIR = "notice-journal"

/** Two FNV-1a hashes of different seeds, written as 16 hex digits: the name of a vault without its path. */
function vaultKey(vault: string): string {
  const text = vault.replace(/\\/gu, "/").replace(/\/+$/u, "")
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x9e3779b9
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")
}

/**
 * The file of the journal of one vault, relative to the data of the application. The journal is kept there
 * and not in the vault: it is not synchronised and the rules about the service data of a vault do not
 * apply to it (docs/notices.md, section 5).
 */
export function journalFileFor(vault: string): string {
  return `${JOURNAL_DIR}/${vaultKey(vault)}.json`
}

/**
 * Reads the journal of a vault. It never fails and never blocks the work: a file that cannot be read or is
 * damaged is an empty journal, and the log says why (the journal is a convenience, not the data of a person).
 */
export async function loadJournal(vault: string, now: number): Promise<JournalEntry[]> {
  let raw: string | null
  try {
    raw = await readGlobalRaw(journalFileFor(vault))
  } catch (error) {
    logger.warn("notices.journal_unreadable", { errorType: errorType(error) })
    return []
  }
  const { entries, damaged } = parseJournal(raw)
  if (damaged) logger.warn("notices.journal_damaged", {})
  return pruneJournal(entries, now)
}

/** Writes the journal of a vault. A failure goes to the log and nowhere else. */
export async function saveJournal(vault: string, entries: JournalEntry[]): Promise<void> {
  try {
    await writeGlobalRaw(journalFileFor(vault), serializeJournal(entries))
  } catch (error) {
    logger.warn("notices.journal_write_failed", { errorType: errorType(error) })
  }
}
