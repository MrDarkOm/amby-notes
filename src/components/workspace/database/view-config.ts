import type { DatabaseFieldRef, DatabaseFilterNode, DatabaseSortSpec } from "@/lib/storage"

/**
 * The persisted part of a database view: what survives a restart and a
 * Table → Gallery → Table round trip. Search and selection stay session state.
 * Everything here is read from and written to the view document by editing the
 * parsed JSON, so unknown fields, other layouts' settings and future additions
 * are preserved byte-for-meaning.
 */

export const TITLE_KEY = "title"
export const MIN_FIELD_WIDTH = 40
export const MAX_FIELD_WIDTH = 2000

type Json = Record<string, unknown>

/** A filter in the durable view format (`value` is a plain JSON operand). */
export interface DurableFilter {
  kind: "group" | "condition" | string
  [key: string]: unknown
}

export interface ViewCondition {
  field: DatabaseFieldRef
  operator: string
  operand?: unknown
}

export interface ViewSort {
  field: DatabaseFieldRef
  direction: "asc" | "desc"
  nulls: "first" | "last"
}

export type CardSize = "small" | "medium" | "large"

export interface ViewSettings {
  /** The saved filter as stored; `null` when none. */
  filter: DurableFilter | null
  sorts: ViewSort[]
  /** Field keys (`title` or a property ID) that are hidden. */
  hidden: string[]
  widths: Record<string, number>
  wrapped: string[]
  /** Field key up to which columns are frozen; `null` freezes nothing. */
  frozenKey: string | null
  openMode: string
  cardSize: CardSize
  /** Property that splits a board into columns; `null` is no grouping. */
  groupBy: string | null
  /** Gallery: show the cover image at the top of each card. */
  coverVisible: boolean
}

export interface SettingsPatch {
  filter?: DurableFilter | null
  sorts?: ViewSort[]
  hidden?: string[]
  /** `null` removes a stored width. Merged per field. */
  widths?: Record<string, number | null>
  wrapped?: string[]
  frozenKey?: string | null
  openMode?: string
  cardSize?: CardSize
  groupBy?: string | null
  coverVisible?: boolean
}

export const EMPTY_SETTINGS: ViewSettings = {
  filter: null,
  sorts: [],
  hidden: [],
  widths: {},
  wrapped: [],
  frozenKey: null,
  openMode: "sidePeek",
  cardSize: "medium",
  groupBy: null,
  coverVisible: true,
}

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** `title` for the system title, the property ID for a property, else `null`. */
export function fieldKey(ref: unknown): string | null {
  if (!isObject(ref)) return null
  if (ref.kind === "property") {
    const id = ref.propertyId ?? ref.property_id
    return typeof id === "string" ? id : null
  }
  if (ref.kind === "system") {
    return ref.field === TITLE_KEY ? TITLE_KEY : null
  }
  return null
}

/** The property ID of a field reference; `null` for the title or an unreadable reference. */
function propertyKey(ref: unknown): string | null {
  const key = fieldKey(ref)
  return key && key !== TITLE_KEY ? key : null
}

export function fieldRefFromKey(key: string): DatabaseFieldRef {
  return key === TITLE_KEY
    ? { kind: "system", field: TITLE_KEY }
    : { kind: "property", propertyId: key }
}

function durableField(ref: DatabaseFieldRef): Json {
  return ref.kind === "property"
    ? { kind: "property", propertyId: ref.propertyId }
    : { kind: "system", field: ref.field }
}

function parseDoc(configJson: string): Json {
  try {
    const parsed: unknown = JSON.parse(configJson)
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function parseSorts(value: unknown): ViewSort[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): ViewSort[] => {
    if (!isObject(entry)) return []
    const key = fieldKey(entry.field)
    if (!key) return []
    return [
      {
        field: fieldRefFromKey(key),
        direction: entry.direction === "desc" ? "desc" : "asc",
        nulls: entry.nulls === "first" ? "first" : "last",
      },
    ]
  })
}

export function parseViewSettings(configJson: string): ViewSettings {
  const doc = parseDoc(configJson)
  const hidden: string[] = []
  const widths: Record<string, number> = {}
  if (Array.isArray(doc.fields)) {
    for (const entry of doc.fields) {
      if (!isObject(entry)) continue
      const key = fieldKey(entry.field)
      if (!key) continue
      if (key !== TITLE_KEY && entry.visible === false) hidden.push(key)
      if (typeof entry.width === "number") widths[key] = entry.width
    }
  }
  const layout = isObject(doc.layoutConfig) ? doc.layoutConfig : {}
  return {
    filter:
      isObject(doc.filter) && typeof doc.filter.kind === "string"
        ? (doc.filter as DurableFilter)
        : null,
    sorts: parseSorts(doc.sorts),
    hidden,
    widths,
    wrapped: Array.isArray(layout.wrappedFields)
      ? layout.wrappedFields.filter((key): key is string => typeof key === "string")
      : [],
    frozenKey: typeof layout.frozenBoundary === "string" ? layout.frozenBoundary : null,
    openMode: typeof doc.openMode === "string" ? doc.openMode : "sidePeek",
    cardSize:
      layout.cardSize === "small" || layout.cardSize === "large" ? layout.cardSize : "medium",
    groupBy: isObject(doc.group) ? propertyKey(doc.group.field) : null,
    coverVisible: layout.coverVisible !== false,
  }
}

/** The flat list of conditions when the filter is a plain AND of conditions. */
export function flatConditions(filter: DurableFilter | null): ViewCondition[] | null {
  if (!filter) return []
  const toCondition = (node: unknown): ViewCondition | null => {
    if (!isObject(node) || node.kind !== "condition" || typeof node.operator !== "string")
      return null
    const key = fieldKey(node.field)
    if (!key) return null
    return { field: fieldRefFromKey(key), operator: node.operator, operand: node.value }
  }
  if (filter.kind === "condition") {
    const single = toCondition(filter)
    return single ? [single] : null
  }
  if (filter.kind === "group" && filter.operator === "and" && Array.isArray(filter.children)) {
    const conditions = filter.children.map(toCondition)
    return conditions.every((condition) => condition !== null)
      ? (conditions as ViewCondition[])
      : null
  }
  return null
}

export function conditionsToFilter(conditions: ViewCondition[]): DurableFilter | null {
  const nodes = conditions.map((condition) => {
    const node: DurableFilter = {
      kind: "condition",
      field: durableField(condition.field),
      operator: condition.operator,
    }
    if (condition.operand !== undefined) node.value = condition.operand
    return node
  })
  if (nodes.length === 0) return null
  if (nodes.length === 1) return nodes[0]
  return { kind: "group", operator: "and", children: nodes }
}

function toQueryField(ref: unknown): DatabaseFieldRef {
  const key = fieldKey(ref)
  // An unreadable reference must not widen the result: it matches nothing useful.
  return key ? fieldRefFromKey(key) : { kind: "system", field: "invalid" }
}

/** The durable filter as the query request wants it (operands as JSON text). */
export function toQueryFilter(filter: DurableFilter | null): DatabaseFilterNode | undefined {
  if (!filter) return undefined
  if (filter.kind === "group" && Array.isArray(filter.children)) {
    return {
      kind: "group",
      operator: String(filter.operator ?? "and"),
      children: filter.children
        .map((child) => toQueryFilter(child as DurableFilter))
        .filter((child): child is DatabaseFilterNode => child !== undefined),
    }
  }
  if (filter.kind === "condition") {
    return {
      kind: "condition",
      field: toQueryField(filter.field),
      operator: String(filter.operator ?? ""),
      ...(filter.value !== undefined ? { value: JSON.stringify(filter.value) } : {}),
    }
  }
  // An unknown node type: keep the query from silently ignoring it.
  return {
    kind: "condition",
    field: { kind: "system", field: "invalid" },
    operator: "invalid",
  }
}

export function toQuerySorts(sorts: ViewSort[]): DatabaseSortSpec[] {
  return sorts.map((sort) => ({ field: sort.field, direction: sort.direction, nulls: sort.nulls }))
}

function clampWidth(width: number): number {
  return Math.min(MAX_FIELD_WIDTH, Math.max(MIN_FIELD_WIDTH, Math.round(width)))
}

function ensureField(fields: Json[], key: string): Json {
  const found = fields.find((entry) => fieldKey(entry.field) === key)
  if (found) return found
  const created: Json = {
    field: durableField(fieldRefFromKey(key)),
    visible: true,
    width: null,
    frozen: false,
  }
  fields.push(created)
  return created
}

/**
 * Applies a patch to a view document and returns the new document text. Only
 * the patched settings change. The Title field stays first, visible and frozen.
 */
export function applySettingsPatch(configJson: string, patch: SettingsPatch): string {
  const doc = parseDoc(configJson)
  if ("filter" in patch) doc.filter = patch.filter ?? null
  if (patch.sorts) {
    doc.sorts = patch.sorts.map((sort) => ({
      field: durableField(sort.field),
      direction: sort.direction,
      nulls: sort.nulls,
    }))
  }
  if (patch.openMode) doc.openMode = patch.openMode
  if (patch.groupBy !== undefined) {
    // Keep the rule's other fields (written by newer builds) and change only its field.
    doc.group = patch.groupBy
      ? {
          ...(isObject(doc.group) ? doc.group : {}),
          field: durableField(fieldRefFromKey(patch.groupBy)),
        }
      : null
  }
  if (patch.hidden || patch.widths) {
    const fields = (Array.isArray(doc.fields) ? doc.fields : [])
      .filter(isObject)
      .map((entry) => ({ ...entry }))
    if (!fields.some((entry) => fieldKey(entry.field) === TITLE_KEY)) {
      fields.unshift({
        field: durableField(fieldRefFromKey(TITLE_KEY)),
        visible: true,
        width: null,
        frozen: true,
      })
    }
    if (patch.hidden) {
      const hidden = new Set(patch.hidden)
      for (const key of hidden) if (key !== TITLE_KEY) ensureField(fields, key).visible = false
      for (const entry of fields) {
        const key = fieldKey(entry.field)
        if (key && key !== TITLE_KEY && !hidden.has(key)) entry.visible = true
      }
    }
    for (const [key, width] of Object.entries(patch.widths ?? {})) {
      ensureField(fields, key).width = width === null ? null : clampWidth(width)
    }
    doc.fields = fields
  }
  if (
    patch.wrapped !== undefined ||
    patch.frozenKey !== undefined ||
    patch.cardSize !== undefined ||
    patch.coverVisible !== undefined
  ) {
    const layout = isObject(doc.layoutConfig) ? { ...doc.layoutConfig } : {}
    if (patch.wrapped !== undefined) {
      if (patch.wrapped.length > 0) layout.wrappedFields = patch.wrapped
      else delete layout.wrappedFields
    }
    if (patch.frozenKey !== undefined) {
      if (patch.frozenKey) layout.frozenBoundary = patch.frozenKey
      else delete layout.frozenBoundary
    }
    if (patch.cardSize !== undefined) {
      if (patch.cardSize === "medium") delete layout.cardSize
      else layout.cardSize = patch.cardSize
    }
    if (patch.coverVisible !== undefined) {
      if (patch.coverVisible) delete layout.coverVisible
      else layout.coverVisible = false
    }
    doc.layoutConfig = layout
  }
  return JSON.stringify(doc)
}

/** Combines two patches; later values win, widths merge per field. */
export function mergePatches(earlier: SettingsPatch, later: SettingsPatch): SettingsPatch {
  const merged: SettingsPatch = { ...earlier, ...later }
  if (earlier.widths || later.widths) merged.widths = { ...earlier.widths, ...later.widths }
  return merged
}

/** The settings after a patch, for the optimistic local copy. */
export function settingsAfter(settings: ViewSettings, patch: SettingsPatch): ViewSettings {
  const widths = { ...settings.widths }
  for (const [key, width] of Object.entries(patch.widths ?? {})) {
    if (width === null) delete widths[key]
    else widths[key] = clampWidth(width)
  }
  return {
    filter: "filter" in patch ? (patch.filter ?? null) : settings.filter,
    sorts: patch.sorts ?? settings.sorts,
    hidden: patch.hidden ?? settings.hidden,
    widths,
    wrapped: patch.wrapped ?? settings.wrapped,
    frozenKey: patch.frozenKey !== undefined ? patch.frozenKey : settings.frozenKey,
    openMode: patch.openMode ?? settings.openMode,
    cardSize: patch.cardSize ?? settings.cardSize,
    groupBy: patch.groupBy !== undefined ? patch.groupBy : settings.groupBy,
    coverVisible: patch.coverVisible ?? settings.coverVisible,
  }
}
