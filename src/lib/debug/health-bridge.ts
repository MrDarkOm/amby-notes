import type { DebugHealthSnapshot } from "./health"

const REQUEST_EVENT = "amby:debug-health-request"
const RESPONSE_EVENT = "amby:debug-health-response"
const REASONS = new Set([
  "unterminated_frontmatter",
  "identity_read_only",
  "inspection_limit",
  "footnotes",
  "reference_links",
  "mixed_line_endings",
  "round_trip_mismatch",
  "source_selected",
  "inspection_failed",
])

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {}
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(1_000_000_000, Math.floor(value))
    : 0

/** Only aggregates cross the window boundary, even if an unexpected window replies. */
export function projectSharedDebugHealth(value: unknown): Omit<DebugHealthSnapshot, "backend"> {
  const input = record(value)
  const documents = record(input.documents)
  const autosave = record(input.autosave)
  const recovery = record(input.recovery)
  const modules = record(input.modules)
  const reasonValues = record(input.editorReasons)
  const editorReasons = Object.fromEntries(
    [...REASONS]
      .filter((reason) => reason in reasonValues)
      .map((reason) => [reason, count(reasonValues[reason])]),
  )
  return {
    runtime: "desktop",
    generatedAt: new Date().toISOString(),
    documents: {
      open: count(documents.open),
      dirty: count(documents.dirty),
      conflicts: count(documents.conflicts),
      source: count(documents.source),
      livePreview: count(documents.livePreview),
    },
    autosave: {
      participants: count(autosave.participants),
      scheduled: count(autosave.scheduled),
      inFlight: count(autosave.inFlight),
      paused: count(autosave.paused),
      dirty: count(autosave.dirty),
      errors: count(autosave.errors),
    },
    recovery: { pending: count(recovery.pending), failed: count(recovery.failed) },
    modules: { enabled: count(modules.enabled), safeMode: modules.safeMode === true },
    editorReasons,
  }
}

let installed = false
export async function installDebugHealthBridge(
  collect: () => Promise<DebugHealthSnapshot>,
): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  if (installed || getCurrentWindow().label !== "main") return
  const { emitTo, listen } = await import("@tauri-apps/api/event")
  installed = true
  try {
    await listen<{ requestId: string; requester: string }>(REQUEST_EVENT, ({ payload }) => {
      if (payload?.requester !== "settings" || !/^[a-f0-9-]{36}$/i.test(payload.requestId ?? ""))
        return
      void collect()
        .then((snapshot) =>
          emitTo(payload.requester, RESPONSE_EVENT, {
            requestId: payload.requestId,
            snapshot: projectSharedDebugHealth(snapshot),
          }),
        )
        .catch(() => {
          // A requester has its own bounded timeout; diagnostic failure does not alter the workspace.
        })
    })
  } catch {
    installed = false
  }
}

export async function requestWorkspaceDebugHealth(): Promise<Omit<DebugHealthSnapshot, "backend">> {
  const { emitTo, listen } = await import("@tauri-apps/api/event")
  const requestId = crypto.randomUUID()
  let stop: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  try {
    return await new Promise((resolve, reject) => {
      const finish = (snapshot?: unknown) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        stop?.()
        stop = undefined
        if (snapshot === undefined) reject(new Error("DEBUG_HEALTH_UNAVAILABLE"))
        else resolve(projectSharedDebugHealth(snapshot))
      }
      timer = setTimeout(() => finish(), 2000)
      void listen<{ requestId: string; snapshot: unknown }>(RESPONSE_EVENT, ({ payload }) => {
        if (payload?.requestId === requestId) finish(payload.snapshot)
      })
        .then((unlisten) => {
          stop = unlisten
          if (settled) {
            unlisten()
            return
          }
          return emitTo("main", REQUEST_EVENT, { requestId, requester: "settings" })
        })
        .catch(() => finish())
    })
  } finally {
    if (timer) clearTimeout(timer)
    stop?.()
  }
}
