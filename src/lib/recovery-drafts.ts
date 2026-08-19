/**
 * Small crash-recovery journal for editor buffers that have not reached the
 * filesystem yet.  It deliberately lives outside the normal vault cache, so
 * a renderer crash or forced app quit still leaves a recoverable copy.
 */
const PREFIX = "amby:recovery-draft:"
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000

interface RecoveryDraft {
  content: string
  savedAt: number
}

function key(path: string) {
  return PREFIX + encodeURIComponent(path)
}

export function saveRecoveryDraft(path: string, content: string) {
  try {
    localStorage.setItem(
      key(path),
      JSON.stringify({ content, savedAt: Date.now() } satisfies RecoveryDraft),
    )
  } catch {
    // Recovery must never prevent typing when storage is unavailable/full.
  }
}

export function readRecoveryDraft(path: string): RecoveryDraft | null {
  try {
    const raw = localStorage.getItem(key(path))
    if (!raw) return null
    const draft: unknown = JSON.parse(raw)
    if (
      !draft ||
      typeof draft !== "object" ||
      typeof (draft as RecoveryDraft).content !== "string" ||
      typeof (draft as RecoveryDraft).savedAt !== "number" ||
      Date.now() - (draft as RecoveryDraft).savedAt > MAX_AGE_MS
    ) {
      localStorage.removeItem(key(path))
      return null
    }
    return draft as RecoveryDraft
  } catch {
    return null
  }
}

export function discardRecoveryDraft(path: string) {
  try {
    localStorage.removeItem(key(path))
  } catch {
    // Best-effort cleanup only.
  }
}

/** Move a draft alongside a renamed or moved document without losing recovery. */
export function remapRecoveryDraft(fromPath: string, toPath: string) {
  if (fromPath === toPath) return
  const draft = readRecoveryDraft(fromPath)
  if (!draft) return
  saveRecoveryDraft(toPath, draft.content)
  discardRecoveryDraft(fromPath)
}
