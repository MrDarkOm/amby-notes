/**
 * Remembers which view of a database the user looked at last, so reopening a note
 * or a database does not jump back to the first one. It is a per-device
 * convenience (like the view display modes), never part of the note or the
 * database: losing it only means the first view opens.
 */
const STORAGE_KEY = "amby:db-last-views"
const MAX_ENTRIES = 300

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => {
        return typeof entry[1] === "string"
      }),
    )
  } catch {
    return {}
  }
}

function write(entries: Record<string, string>): void {
  try {
    // Insertion order is age: the oldest entries go first.
    const keys = Object.keys(entries)
    const kept =
      keys.length > MAX_ENTRIES
        ? Object.fromEntries(
            keys.slice(keys.length - MAX_ENTRIES).map((key) => [key, entries[key]]),
          )
        : entries
    localStorage.setItem(STORAGE_KEY, JSON.stringify(kept))
  } catch {
    // Private mode or blocked storage: the choice simply is not remembered.
  }
}

/** The view last chosen in `scope` (a database id or a view id of an embedded block). */
export function readLastView(scope: string | null | undefined): string | null {
  if (!scope) return null
  return read()[scope] ?? null
}

export function rememberLastView(scope: string | null | undefined, viewId: string): void {
  if (!scope) return
  const entries = read()
  if (entries[scope] === viewId) return
  delete entries[scope]
  entries[scope] = viewId
  write(entries)
}

/**
 * An embedded block has no id of its own, but every tab has a unique one. The
 * block's memory lives under all of them, so it is found whichever tabs remain.
 */
export function rememberedBlockView(viewIds: readonly string[]): string | null {
  const entries = read()
  for (const id of viewIds) {
    const remembered = entries[id]
    if (remembered && viewIds.includes(remembered)) return remembered
  }
  return null
}

export function rememberBlockView(viewIds: readonly string[], activeId: string): void {
  if (viewIds.length < 2) return
  const entries = read()
  if (viewIds.every((id) => entries[id] === activeId)) return
  for (const id of viewIds) {
    delete entries[id]
    entries[id] = activeId
  }
  write(entries)
}
