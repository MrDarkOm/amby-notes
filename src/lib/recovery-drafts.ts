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
const RECOVERY_DELAY_MS = 500
const RECOVERY_MAX_WAIT_MS = 1_000

export interface RecoveryDraft {
  content: string
  savedAt: number
  id?: string
  documentKind?: string
  pathHint?: string
}

export interface RecoveryScope {
  vault: string | null
  generation: number | null
}

function hasScope(scope?: RecoveryScope): scope is RecoveryScope {
  return Boolean(scope?.vault || (scope?.generation !== null && scope?.generation !== undefined))
}

function scopeKey(scope?: RecoveryScope): string {
  if (!hasScope(scope)) return "legacy"
  return `${scope.vault ?? ""}\u0000${scope.generation ?? ""}`
}

function sameScope(left?: RecoveryScope, right?: RecoveryScope): boolean {
  return scopeKey(left) === scopeKey(right)
}

function legacyPathBelongsToScope(path: string, scope?: RecoveryScope): boolean {
  if (!hasScope(scope)) return true
  if (!scope.vault) return false
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const vault = normalize(scope.vault)
  const candidate = normalize(path)
  return candidate === vault || candidate.startsWith(`${vault}/`)
}

function key(path: string, scope?: RecoveryScope): string {
  if (!hasScope(scope)) return PREFIX + encodeURIComponent(path)
  return PREFIX + encodeURIComponent(`${scopeKey(scope)}\u0000${path}`)
}

function queueKey(id: string, documentKind: string, scope?: RecoveryScope): string {
  return `${scopeKey(scope)}\u0000${documentKind}\u0000${id}`
}

function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

async function persistRecoveryDraft(
  id: string,
  content: string,
  documentKind?: string,
  pathHint?: string,
  scope?: RecoveryScope,
): Promise<string | undefined> {
  if (!id) return
  const kind = documentKind ?? (id.endsWith(".canvas") ? "canvas" : "markdown")
  const hint = pathHint ?? id

  if (isDesktop()) {
    const entry = await unwrapCommand<RecoveryEntry>(
      commands.saveRecovery(
        id,
        kind,
        hint,
        content,
        scope?.generation ?? null,
        scope?.vault ?? null,
      ),
    )
    return entry.contentHash
  }

  try {
    localStorage.setItem(
      key(id, scope),
      JSON.stringify({
        content,
        savedAt: Date.now(),
        id,
        documentKind: kind,
        pathHint: hint,
      } satisfies RecoveryDraft),
    )
    return undefined
  } catch {
    throw new Error("Recovery storage is unavailable")
  }
}

interface RecoveryQueueState {
  id: string
  documentKind: string
  pathHint: string
  content: string
  version: number
  savedVersion: number
  pendingSince: number | null
  timer: ReturnType<typeof setTimeout> | null
  maxTimer: ReturnType<typeof setTimeout> | null
  inFlight: Promise<{ ok: boolean; contentHash?: string }> | null
  ready: boolean
  scope?: RecoveryScope
  persistedContentHash?: string
  lastError?: unknown
}

const recoveryQueue = new Map<string, RecoveryQueueState>()

function clearRecoveryTimers(state: RecoveryQueueState) {
  if (state.timer) clearTimeout(state.timer)
  if (state.maxTimer) clearTimeout(state.maxTimer)
  state.timer = null
  state.maxTimer = null
}

function latestQueuedDraft(id: string, scope?: RecoveryScope): RecoveryDraft | null {
  const states = [...recoveryQueue.values()].filter(
    (state) => state.id === id && sameScope(state.scope, scope),
  )
  const state = states.sort((left, right) => right.version - left.version)[0]
  if (!state || state.savedVersion >= state.version) return null
  return {
    id: state.id,
    content: state.content,
    savedAt: Date.now(),
    documentKind: state.documentKind,
    pathHint: state.pathHint,
  }
}

function startRecoverySave(state: RecoveryQueueState) {
  if (state.inFlight || !state.ready || state.savedVersion >= state.version) return
  state.ready = false
  const version = state.version
  const snapshot = {
    id: state.id,
    content: state.content,
    documentKind: state.documentKind,
    pathHint: state.pathHint,
  }
  const promise = persistRecoveryDraft(
    snapshot.id,
    snapshot.content,
    snapshot.documentKind,
    snapshot.pathHint,
    state.scope,
  ).then(
    (contentHash) => ({ ok: true, contentHash }),
    (error) => {
      state.lastError = error
      console.warn("Failed to persist recovery journal draft:", error)
      return { ok: false, contentHash: undefined }
    },
  )
  state.inFlight = promise
  void promise.then((succeeded) => {
    if (state.inFlight !== promise) return
    state.inFlight = null
    if (!succeeded.ok) return
    state.savedVersion = Math.max(state.savedVersion, version)
    state.persistedContentHash = succeeded.contentHash
    state.lastError = undefined
    if (state.savedVersion < state.version) {
      // A newer snapshot arrived while the write was on disk. Its existing
      // timer/maxWait window remains authoritative.
      if (!state.timer && !state.maxTimer) startRecoverySave(state)
    } else {
      state.pendingSince = null
      clearRecoveryTimers(state)
    }
  })
}

function scheduleQueuedRecoveryDraft(
  id: string,
  content: string,
  documentKind: string,
  pathHint: string,
  scope?: RecoveryScope,
) {
  const idKey = queueKey(id, documentKind, scope)
  let state = recoveryQueue.get(idKey)
  const now = Date.now()
  if (!state) {
    state = {
      id,
      documentKind,
      pathHint,
      content,
      version: 1,
      savedVersion: 0,
      pendingSince: null,
      timer: null,
      maxTimer: null,
      inFlight: null,
      ready: true,
      scope,
    }
    recoveryQueue.set(idKey, state)
    startRecoverySave(state)
    return
  }

  state.version += 1
  state.content = content
  state.pathHint = pathHint
  state.pendingSince ??= now
  state.ready = true
  if (!state.timer) {
    state.timer = setTimeout(() => {
      state!.timer = null
      state!.ready = true
      startRecoverySave(state!)
    }, RECOVERY_DELAY_MS)
  }
  if (!state.maxTimer) {
    state.maxTimer = setTimeout(
      () => {
        state!.maxTimer = null
        if (state!.timer) clearTimeout(state!.timer)
        state!.timer = null
        state!.ready = true
        startRecoverySave(state!)
      },
      Math.max(0, RECOVERY_MAX_WAIT_MS - (now - (state.pendingSince ?? now))),
    )
  }
}

/** Queue a crash-recovery snapshot without making every editor change an IPC write. */
export function scheduleRecoveryDraft(
  id: string,
  content: string,
  documentKind?: string,
  pathHint?: string,
  scope?: RecoveryScope,
): void {
  if (!id) return
  const kind = documentKind ?? (id.endsWith(".canvas") ? "canvas" : "markdown")
  scheduleQueuedRecoveryDraft(id, content, kind, pathHint ?? id, scope)
}

/** Persist the latest queued snapshot before a lifecycle boundary. */
export async function flushRecoveryDraft(
  id: string,
  documentKind?: string,
  scope?: RecoveryScope,
): Promise<void> {
  const states = [...recoveryQueue.values()].filter(
    (state) =>
      state.id === id &&
      sameScope(state.scope, scope) &&
      (!documentKind || state.documentKind === documentKind),
  )
  for (const state of states) {
    clearRecoveryTimers(state)
    state.ready = true
    while (state.inFlight || state.savedVersion < state.version) {
      startRecoverySave(state)
      const inFlight = state.inFlight
      if (!inFlight) break
      const succeeded = await inFlight
      if (!succeeded.ok) {
        throw state.lastError ?? new Error("Recovery storage is unavailable")
      }
    }
  }
}

export async function flushAllRecoveryDrafts(scope?: RecoveryScope): Promise<void> {
  const states = [...recoveryQueue.values()].filter((state) => sameScope(state.scope, scope))
  await Promise.all(
    states.map((state) => flushRecoveryDraft(state.id, state.documentKind, state.scope)),
  )
}

/** Immediate API retained for recovery restore/remap paths that need durable completion. */
export async function saveRecoveryDraft(
  id: string,
  content: string,
  documentKind?: string,
  pathHint?: string,
  scope?: RecoveryScope,
): Promise<void> {
  if (!id) return
  const kind = documentKind ?? (id.endsWith(".canvas") ? "canvas" : "markdown")
  scheduleQueuedRecoveryDraft(id, content, kind, pathHint ?? id, scope)
  await flushRecoveryDraft(id, kind, scope)
}

export async function readRecoveryDraft(
  id: string,
  scope?: RecoveryScope,
): Promise<RecoveryDraft | null> {
  if (!id) return null

  const queued = latestQueuedDraft(id, scope)
  if (queued) return queued

  if (isDesktop()) {
    try {
      const entry = await unwrapCommand<RecoveryEntry | null>(
        commands.readRecovery(id, scope?.generation ?? null, scope?.vault ?? null),
      )
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
    const rawKey = key(id, scope)
    const raw = localStorage.getItem(rawKey)
    if (!raw) return null
    const draft: unknown = JSON.parse(raw)
    if (
      !draft ||
      typeof draft !== "object" ||
      typeof (draft as RecoveryDraft).content !== "string" ||
      typeof (draft as RecoveryDraft).savedAt !== "number" ||
      Date.now() - (draft as RecoveryDraft).savedAt > MAX_AGE_MS
    ) {
      localStorage.removeItem(rawKey)
      return null
    }
    return draft as RecoveryDraft
  } catch {
    return null
  }
}

export async function discardRecoveryDraft(id: string, scope?: RecoveryScope): Promise<void> {
  if (!id) return

  const states = [...recoveryQueue.values()].filter(
    (state) => state.id === id && sameScope(state.scope, scope),
  )
  let canRemoveLocalStorage = true
  for (const state of states) {
    const version = state.version
    const expectedContentHash = state.persistedContentHash
    clearRecoveryTimers(state)
    if (state.inFlight) await state.inFlight
    if (state.version !== version) {
      canRemoveLocalStorage = false
      continue
    }

    if (isDesktop()) {
      try {
        await unwrapCommand(
          commands.deleteRecovery(
            id,
            expectedContentHash ?? null,
            scope?.generation ?? null,
            scope?.vault ?? null,
          ),
        )
      } catch {
        // Best-effort cleanup.
      }
    }
    if (
      state.version === version &&
      recoveryQueue.get(queueKey(state.id, state.documentKind, scope)) === state
    ) {
      recoveryQueue.delete(queueKey(state.id, state.documentKind, scope))
    }
  }

  if (isDesktop() && states.length === 0) {
    try {
      await unwrapCommand(
        commands.deleteRecovery(id, null, scope?.generation ?? null, scope?.vault ?? null),
      )
    } catch {
      // Best-effort cleanup.
    }
  }

  try {
    if (canRemoveLocalStorage) localStorage.removeItem(key(id, scope))
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
  scope?: RecoveryScope,
): Promise<void> {
  if (fromId === toId) {
    if (newPathHint) {
      const draft = await readRecoveryDraft(fromId, scope)
      if (draft && draft.pathHint !== newPathHint) {
        await saveRecoveryDraft(
          fromId,
          draft.content,
          documentKind ?? draft.documentKind,
          newPathHint,
          scope,
        )
      }
    }
    return
  }
  const draft = await readRecoveryDraft(fromId, scope)
  if (!draft) return
  await saveRecoveryDraft(
    toId,
    draft.content,
    documentKind ?? draft.documentKind,
    newPathHint ?? toId,
    scope,
  )
  await discardRecoveryDraft(fromId, scope)
}

/**
 * One-time migration on startup: migrate any legacy drafts from WebView localStorage
 * into the vault-local Rust recovery journal, verifying each write before clearing.
 */
export async function migrateLegacyRecoveryDrafts(scope?: RecoveryScope): Promise<number> {
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
      if (path.includes("\u0000")) continue
      // Legacy keys predate RecoveryScope. Never copy a path from another
      // vault into the currently active journal; leave it available for the
      // window that eventually activates its owning vault.
      if (!legacyPathBelongsToScope(path, scope)) continue
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
      await saveRecoveryDraft(path, draft.content, kind, path, scope)

      // Verify the write succeeded before removing from legacy localStorage
      const verified = await readRecoveryDraft(path, scope)
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
