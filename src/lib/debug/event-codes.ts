import allowedEvents from "./allowed-events.txt?raw"

/** The allow-list lives in `allowed-events.txt`, shared with the backend filter in `logging.rs`. */
const EVENT_CODES = new Set(
  allowedEvents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#")),
)

const OPERATION_EVENT_BASES = new Set([
  "note.read",
  "note.write",
  "read_note",
  "write_note",
  "database.aggregate",
  "database.query",
  "database.rebuild",
  "database.refresh",
  "database.sync_yaml",
  "index.load",
  "index.rebuild",
  "index.refresh",
  "search.notes",
  "storage.read_file",
  "storage.read_note",
  "storage.write_file",
  "watcher.process",
  "watcher.start",
  "watcher.stop",
])

const FRONTEND_SUBSYSTEMS = new Set([
  "ai",
  "autosave",
  "canvas",
  "database",
  "diagnostics",
  "doc",
  "editor",
  "external_conflict",
  "external_open",
  "file",
  "history",
  "index",
  "layer",
  "media_drop",
  "modules",
  "note_written",
  "property",
  "refresh_vault",
  "search",
  "session",
  "settings",
  "sketch",
  "startup",
  "storage",
  "tab",
  "tree",
  "updater",
  "vault_switch",
  "vault_tree",
  "visibilitychange",
  "watcher",
  "window_close",
  "window_state",
])

const BACKEND_SUBSYSTEMS = new Set([
  "assets",
  "backend",
  "database",
  "debug",
  "history",
  "index",
  "logging",
  "modules",
  "mutations",
  "notes",
  "state",
  "vault",
  "watcher",
])

const OPERATION_SUFFIXES = new Set(["started", "completed", "succeeded", "failed"])

export function isKnownDebugEvent(value: string): boolean {
  if (EVENT_CODES.has(value)) return true
  const separator = value.lastIndexOf(".")
  if (separator < 0) return false
  const base = value.slice(0, separator)
  const suffix = value.slice(separator + 1)
  return OPERATION_EVENT_BASES.has(base) && OPERATION_SUFFIXES.has(suffix)
}

export function isKnownDebugSubsystem(value: string): boolean {
  return FRONTEND_SUBSYSTEMS.has(value) || BACKEND_SUBSYSTEMS.has(value)
}
