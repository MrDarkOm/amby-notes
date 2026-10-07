import { isEmbedLayout, type EmbedLayout } from "./embedded-view-model"
import { parseDatabaseLinkedReference } from "./linked-reference"
import type { DurableFilter } from "./view-config"

/**
 * A database "shortcut" in a note: a few views (tabs), each of which looks at a
 * database with its own settings. Nothing here belongs to the database: the
 * name and icon are the shortcut's, and the settings are a private copy in the
 * block's `amby-db` fence, so editing a view here never changes the database's
 * own views.
 */
export interface LinkedView {
  /** Local key of the tab, unique inside the block. */
  id: string
  databaseId: string
  /** The tab's own name; empty shows the database's name. */
  title: string
  /** An `IconValue`; absent shows the icon of the layout. */
  icon?: string
  layout: EmbedLayout
  /** The view document's JSON shape (fields, filter, sorts, layoutConfig, group). */
  config: Record<string, unknown>
  /** Ties the view to the page it sits on (`@currentPage` on a relation). */
  pageFilter?: DurableFilter
  /** Fields this version does not know, kept as they were. */
  extra: Record<string, unknown>
}

export interface LinkedBlock {
  views: LinkedView[]
  extra: Record<string, unknown>
}

export interface ParsedLinkedBlock {
  block: LinkedBlock
  /** The fence text as read; unrelated saves keep it byte for byte. */
  raw: string
}

export const LINKED_BLOCK_VERSION = 2

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u
const VIEW_KEYS = new Set(["id", "databaseId", "title", "icon", "layout", "config", "pageFilter"])
const BLOCK_KEYS = new Set(["version", "views"])

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function rest(source: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !known.has(key)))
}

function parseView(value: unknown): LinkedView | null {
  if (!isObject(value)) return null
  const { id, databaseId, title, icon, layout, config, pageFilter } = value
  if (typeof id !== "string" || !id) return null
  if (typeof databaseId !== "string" || !ULID.test(databaseId)) return null
  if (title !== undefined && typeof title !== "string") return null
  if (icon !== undefined && typeof icon !== "string") return null
  if (layout !== undefined && typeof layout !== "string") return null
  if (config !== undefined && !isObject(config)) return null
  if (pageFilter !== undefined && !(isObject(pageFilter) && typeof pageFilter.kind === "string")) {
    return null
  }
  return {
    id,
    databaseId,
    title: title ?? "",
    ...(icon ? { icon } : {}),
    layout: isEmbedLayout(layout) ? layout : "table",
    config: config ?? {},
    ...(pageFilter ? { pageFilter: pageFilter as DurableFilter } : {}),
    extra: rest(value, VIEW_KEYS),
  }
}

/**
 * Reads a block fence. Version 2 is the shortcut format above. The first
 * format, `{databaseId, viewId, layout?, filter?}`, opens as a
 * shortcut with one view and is rewritten as version 2 only when edited.
 * Anything else (legacy sidecar ids, unknown versions) is `null`.
 */
export function parseLinkedBlock(raw: string): ParsedLinkedBlock | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(value)) return null

  if (value.version === LINKED_BLOCK_VERSION) {
    if (!Array.isArray(value.views) || value.views.length === 0) return null
    const views = value.views.map(parseView)
    if (views.some((view) => view === null)) return null
    const ids = new Set((views as LinkedView[]).map((view) => view.id))
    if (ids.size !== views.length) return null
    return {
      raw,
      block: {
        views: views as LinkedView[],
        extra: rest(value, BLOCK_KEYS),
      },
    }
  }

  const first = parseDatabaseLinkedReference(raw)
  if (!first) return null
  const reference = first.value
  return {
    raw,
    block: {
      views: [
        {
          id: "v1",
          databaseId: reference.databaseId,
          title: "",
          layout: isEmbedLayout(reference.layout) ? reference.layout : "table",
          config: {},
          ...(reference.filter ? { pageFilter: reference.filter as DurableFilter } : {}),
          extra: {},
        },
      ],
      extra: {},
    },
  }
}

/** The fence text for a block; unchanged blocks keep their original bytes. */
export function serializeLinkedBlock(parsed: ParsedLinkedBlock, next?: LinkedBlock): string {
  if (!next) return parsed.raw
  return stringifyLinkedBlock(next)
}

export function stringifyLinkedBlock(block: LinkedBlock): string {
  return JSON.stringify({
    ...block.extra,
    version: LINKED_BLOCK_VERSION,
    views: block.views.map((view) => ({
      ...view.extra,
      id: view.id,
      databaseId: view.databaseId,
      title: view.title,
      ...(view.icon ? { icon: view.icon } : {}),
      layout: view.layout,
      config: view.config,
      ...(view.pageFilter ? { pageFilter: view.pageFilter } : {}),
    })),
  })
}

export function newLinkedViewId(): string {
  try {
    return `v${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`
  } catch {
    return `v${Math.random().toString(36).slice(2, 12)}`
  }
}

/** A block with one view, as inserted into a note. */
export function newLinkedBlock(view: LinkedView): LinkedBlock {
  return { views: [view], extra: {} }
}

export function replaceView(block: LinkedBlock, id: string, view: LinkedView): LinkedBlock {
  return {
    ...block,
    views: block.views.map((candidate) => (candidate.id === id ? view : candidate)),
  }
}

export function addView(block: LinkedBlock, view: LinkedView, after?: string): LinkedBlock {
  const index = after ? block.views.findIndex((candidate) => candidate.id === after) : -1
  const views = [...block.views]
  views.splice(index < 0 ? views.length : index + 1, 0, view)
  return { ...block, views }
}

/** A copy that starts on the same data and settings but is its own tab. */
export function duplicateView(view: LinkedView): LinkedView {
  return { ...view, id: newLinkedViewId(), config: structuredClone(view.config) }
}

/** Removes a view; the last one stays, a shortcut without views would be empty. */
export function removeView(block: LinkedBlock, id: string): LinkedBlock {
  if (block.views.length <= 1) return block
  return { ...block, views: block.views.filter((view) => view.id !== id) }
}

/** The tab's name, or the database's when the tab has none of its own. */
export function viewLabel(view: LinkedView, databaseTitle?: string): string {
  return view.title.trim() || databaseTitle || ""
}
