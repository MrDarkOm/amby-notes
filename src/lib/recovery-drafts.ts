import { commands, type RecoveryEntry } from "@/lib/bindings"
import { unwrapCommand } from "@/lib/storage/ipc-result"

/**
 * Crash-recovery journal for editor and canvas buffers that have not reached
 * the filesystem yet. In desktop mode, entries are persisted directly in the
 * vault's `.amby/recovery/` journal. In web/browser mode, entries fall back to
 * `localStorage`.
 */
const PREFIX = "amby:recovery-draft:"
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000

export interface RecoveryDraft {
  content: string
  savedAt: number
  id?: string
  documentKind?: string
  pathHint?: string
}

function key(path: string): string {
  return PREFIX + encodeURIComponent(path)
}

function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export async function saveRecoveryDraft(
  id: string,
  content: string,
  documentKind?: string,
  pathHint?: string,
): Promise<void> {
  if (!id) return
  const kind = documentKind ?? (id.endsWith(".canvas") ? "canvas" : "markdown")
  const hint = pathHint ?? id

  if (isDesktop()) {
    try {
      await unwrapCommand(commands.saveRecovery(id, kind, hint, content))
      return
    } catch (error) {
      // Recovery journal writes must never interrupt user typing when unavailable.
      console.warn("Failed to persist recovery journal draft:", error)
      return
    }
  }

  try {
    localStorage.setItem(
      key(id),
      JSON.stringify({
        content,
        savedAt: Date.now(),
        id,
        documentKind: kind,
        pathHint: hint,
      } satisfies RecoveryDraft),
    )
  } catch {
    // Recovery must never prevent typing when localStorage is unavailable/full.
  }
}

export async function readRecoveryDraft(id: string): Promise<RecoveryDraft | null> {
  if (!id) return null

  if (isDesktop()) {
    try {
      const entry = await unwrapCommand<RecoveryEntry | null>(commands.readRecovery(id))
      if (!entry) return null
      return {
        content: entry.content,
        savedAt: entry.savedAtMs,
        id: entry.id,
        documentKind: entry.documentKind,
        pathHint: entry.pathHint,
      }
    } catch {
      return null
    }
  }

  try {
    const raw = localStorage.getItem(key(id))
    if (!raw) return null
    const draft: unknown = JSON.parse(raw)
    if (
      !draft ||
      typeof draft !== "object" ||
      typeof (draft as RecoveryDraft).content !== "string" ||
      typeof (draft as RecoveryDraft).savedAt !== "number" ||
      Date.now() - (draft as RecoveryDraft).savedAt > MAX_AGE_MS
    ) {
      localStorage.removeItem(key(id))
      return null
    }
    return draft as RecoveryDraft
  } catch {
    return null
  }
}

export async function discardRecoveryDraft(id: string): Promise<void> {
  if (!id) return

  if (isDesktop()) {
    try {
      await unwrapCommand(commands.deleteRecovery(id))
    } catch {
      // Best-effort cleanup.
    }
  }

  try {
    localStorage.removeItem(key(id))
  } catch {
    // Best-effort cleanup.
  }
}

/** Move a draft alongside a renamed or moved document without losing recovery. */
export async function remapRecoveryDraft(
  fromId: string,
  toId: string,
  documentKind?: string,
  newPathHint?: string,
): Promise<void> {
  if (fromId === toId) {
    if (newPathHint) {
      const draft = await readRecoveryDraft(fromId)
      if (draft && draft.pathHint !== newPathHint) {
        await saveRecoveryDraft(
          fromId,
          draft.content,
          documentKind ?? draft.documentKind,
          newPathHint,
        )
      }
    }
    return
  }
  const draft = await readRecoveryDraft(fromId)
  if (!draft) return
  await saveRecoveryDraft(
    toId,
    draft.content,
    documentKind ?? draft.documentKind,
    newPathHint ?? toId,
  )
  await discardRecoveryDraft(fromId)
}

/**
 * One-time migration on startup: migrate any legacy drafts from WebView localStorage
 * into the vault-local Rust recovery journal, verifying each write before clearing.
 */
export async function migrateLegacyRecoveryDrafts(): Promise<number> {
  if (typeof window === "undefined" || !isDesktop()) return 0

  const legacyKeys: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(PREFIX)) {
        legacyKeys.push(k)
      }
    }
  } catch {
    return 0
  }

  let migrated = 0
  for (const rawKey of legacyKeys) {
    try {
      const encoded = rawKey.slice(PREFIX.length)
      const path = decodeURIComponent(encoded)
      const raw = localStorage.getItem(rawKey)
      if (!raw) continue

      let draft: { content?: unknown; savedAt?: unknown } | null = null
      try {
        draft = JSON.parse(raw)
      } catch {
        localStorage.removeItem(rawKey)
        continue
      }

      if (
        !draft ||
        typeof draft.content !== "string" ||
        typeof draft.savedAt !== "number" ||
        Date.now() - draft.savedAt > MAX_AGE_MS
      ) {
        localStorage.removeItem(rawKey)
        continue
      }

      const kind = path.endsWith(".canvas") ? "canvas" : "markdown"
      await saveRecoveryDraft(path, draft.content, kind, path)

      // Verify the write succeeded before removing from legacy localStorage
      const verified = await readRecoveryDraft(path)
      if (verified && verified.content === draft.content) {
        localStorage.removeItem(rawKey)
        migrated++
      }
    } catch (error) {
      console.warn("Failed to migrate legacy recovery draft:", error)
    }
  }

  return migrated
}
