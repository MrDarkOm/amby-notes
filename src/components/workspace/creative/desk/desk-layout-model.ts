/**
 * The widgets of a story's desk (pure): which there are, in what order, how wide, which are
 * hidden. One layout is kept for every story of the vault (`creative-scope-storage.ts`), so a
 * saved layout is reconciled with the widgets this story can show before it is used: a widget the
 * layout does not know yet appears at the end, one that is gone (or this story cannot show) is
 * dropped from the result, and a width that is not 1, 2 or 3 columns falls back to the default.
 */

export type DeskSpan = 1 | 2 | 3

export interface DeskItem {
  /** `continue`, `progress`, `chapters`, `notes`, a world role, or `section:<sectionId>`. */
  id: string
  span: DeskSpan
  hidden: boolean
}

export const DESK_SPANS: readonly DeskSpan[] = [1, 2, 3]

/** The widgets that need nothing of the workshop but the story's text. */
export const FIXED_WIDGETS = ["continue", "progress", "chapters"] as const

/** The world roles that have a widget of their own, in the order the desk lists them. */
export const WORLD_WIDGET_ROLES = ["characters", "locations", "arcs"] as const

const DEFAULT_SPANS: Record<string, DeskSpan> = { continue: 2, chapters: 2 }

export function defaultSpanOf(id: string): DeskSpan {
  return DEFAULT_SPANS[id] ?? 1
}

/** The widget ID of a world section: its role when it has a widget by role, else its own ID. */
export function worldWidgetId(section: { id: string; role: string | null }): string {
  return (WORLD_WIDGET_ROLES as readonly string[]).includes(section.role ?? "")
    ? (section.role as string)
    : `section:${section.id}`
}

/**
 * The widgets this story can show, in the default order: the three fixed ones, the notes when the
 * workshop has a notes base, the world by role (characters, locations, arcs) and then the author's
 * own sections.
 */
export function availableWidgets(input: {
  hasNotes: boolean
  worldSections: readonly { id: string; role: string | null }[]
}): string[] {
  const ids = input.worldSections.map(worldWidgetId)
  const byRole = WORLD_WIDGET_ROLES.filter((role) => ids.includes(role))
  const own = ids.filter((id) => !(WORLD_WIDGET_ROLES as readonly string[]).includes(id))
  return [...FIXED_WIDGETS, ...(input.hasNotes ? ["notes"] : []), ...byRole, ...own]
}

export function defaultDeskLayout(available: readonly string[]): DeskItem[] {
  return available.map((id) => ({ id, span: defaultSpanOf(id), hidden: false }))
}

function isSpan(value: unknown): value is DeskSpan {
  return value === 1 || value === 2 || value === 3
}

/**
 * The saved layout made to fit the widgets available now. Unreadable entries and repeats are
 * ignored; what is missing is added after the rest, shown and at its default width.
 */
export function reconcileDeskLayout(saved: unknown, available: readonly string[]): DeskItem[] {
  const known = new Set(available)
  const seen = new Set<string>()
  const kept: DeskItem[] = []
  if (Array.isArray(saved)) {
    for (const entry of saved) {
      if (!entry || typeof entry !== "object") continue
      const { id, span, hidden } = entry as { id?: unknown; span?: unknown; hidden?: unknown }
      if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue
      seen.add(id)
      kept.push({
        id,
        span: isSpan(span) ? span : defaultSpanOf(id),
        hidden: hidden === true,
      })
    }
  }
  const added = available
    .filter((id) => !seen.has(id))
    .map((id) => ({ id, span: defaultSpanOf(id), hidden: false }))
  return [...kept, ...added]
}

/** How many columns the desk has at a width in pixels: 3 wide, 2 medium, 1 narrow. */
export function deskColumns(width: number): 1 | 2 | 3 {
  if (width <= 0) return 3
  if (width < 560) return 1
  if (width < 860) return 2
  return 3
}

/** The columns a widget takes at the desk's width: never more than the desk has. */
export function effectiveSpan(span: DeskSpan, columns: 1 | 2 | 3): number {
  return Math.min(span, columns)
}

// ── Changing the layout ─────────────────────────────────────────────────────────────────────────
// Every change returns a new list (or the same one when nothing would change); none of them writes
// anything: the page keeps what the last one returned.

/**
 * A widget one place earlier (`-1`) or later (`1`) among the shown ones: it trades places with the
 * nearest shown neighbour, so hidden widgets keep their own places. The same list when it is already
 * at that end, or is hidden, or unknown.
 */
export function moveWidget(items: readonly DeskItem[], id: string, direction: -1 | 1): DeskItem[] {
  const shown = items.filter((item) => !item.hidden)
  const at = shown.findIndex((item) => item.id === id)
  const neighbour = at === -1 ? undefined : shown[at + direction]
  if (!neighbour) return [...items]
  const from = items.findIndex((item) => item.id === id)
  const to = items.findIndex((item) => item.id === neighbour.id)
  const next = [...items]
  next[from] = items[to]
  next[to] = items[from]
  return next
}

/** The width after the one given: a third, two thirds, the whole row, and around again. */
export function nextSpan(span: DeskSpan): DeskSpan {
  return span === 3 ? 1 : ((span + 1) as DeskSpan)
}

export function setWidgetSpan(items: readonly DeskItem[], id: string, span: DeskSpan): DeskItem[] {
  return items.map((item) => (item.id === id ? { ...item, span } : item))
}

/** Hides a widget (it waits in the tray) or brings it back where it stood. */
export function setWidgetHidden(
  items: readonly DeskItem[],
  id: string,
  hidden: boolean,
): DeskItem[] {
  return items.map((item) => (item.id === id ? { ...item, hidden } : item))
}
