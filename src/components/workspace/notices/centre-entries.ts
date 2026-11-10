import type { VaultSyncStatus } from "@/lib/sync/sync-port"
import { relativeToVault } from "../editor/document-breadcrumbs-utils"
import type { LimitNotice } from "../sync/limit-notices"
import { conflictName } from "../sync/conflict-outcome"
import { noticeSeverityRank, type NoticeLevel } from "./notice-look"
import type { AppNotice } from "./use-app-notices-store"

// What the notification centre says now (docs/notices.md, section 5). "Needs a decision" and "Attention"
// are not kept anywhere: this derives them from the live causes each time, so a record leaves with its cause.

export type CentreConflict = VaultSyncStatus["conflicts"][number]
export type CentreStop = NonNullable<VaultSyncStatus["stop"]>

/** Where a button of a record leads. */
export type CentreAction =
  { kind: "compare"; conflictId: string } | { kind: "settings" } | { kind: "note"; id: string }

export type CentreKind =
  | "sync-conflict"
  | "sync-stop"
  | "note-card"
  | "closed-save-failed"
  | "limit-too-large"
  | "limit-quota-full"
  | "item-errors"
  | "app-notice"

export interface CentreEntry {
  /** Stable while the cause stays. A copy of a card of an open note has the id of the card. */
  id: string
  section: "decision" | "warning"
  level: NoticeLevel
  kind: CentreKind
  /** The card of the note this is a copy of (`save-failed`, `draft`, …). */
  card?: string
  /** The note it is about, by name. */
  name?: string
  count?: number
  maxBytes?: number
  stop?: CentreStop
  conflict?: CentreConflict
  /** The notice of the application this entry shows (`app-notice`). */
  appNotice?: AppNotice
  action: CentreAction
}

/** The open note as the centre needs it. */
export interface CentreDoc {
  id: string
  path: string
  externallyDeleted?: boolean
  externallyArchived?: boolean
}

export interface CentreInput {
  vault: string | null
  conflicts: CentreConflict[]
  stop: CentreStop | null
  limits: LimitNotice[]
  itemErrors: number
  openDocs: Record<string, CentreDoc>
  /**
   * Ids of the notes that have a tab. A note whose tab was closed stays in `openDocs`, but it has nothing to
   * decide any more and no card to point at, so it has no copy in the centre.
   */
  tabbedDocIds: string[]
  externalConflicts: Record<string, unknown>
  saveFailed: Record<string, true>
  propertyFailed: Record<string, true>
  draftOffers: Record<string, unknown>
  /** Paths in the vault of open notes deleted on another computer. */
  remoteDeleted: string[]
  /** Paths whose return from the archive failed: the general "file deleted" card is shown again. */
  restoreFailed?: string[]
  closedSaveFailures: Record<string, { name: string; path: string }>
  /** Ids of records of "Attention" the person hid. */
  hidden: string[]
  /** Notices of the application with no other place (a vault that did not open, a link that did not open). */
  appNotices?: AppNotice[]
}

export interface Centre {
  decision: CentreEntry[]
  warning: CentreEntry[]
}

/**
 * The id of a notice of an open note, the same for its card and for its copy in the centre: a decision in
 * either place removes both, because both are derived from the same cause.
 */
export function noteNoticeId(docId: string, card: string): string {
  return `note:${docId}:${card}`
}

function bySeriousness(entries: CentreEntry[]): CentreEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        noticeSeverityRank(a.entry.level) - noticeSeverityRank(b.entry.level) || a.index - b.index,
    )
    .map(({ entry }) => entry)
}

function warningsOf(input: CentreInput): CentreEntry[] {
  const warning: CentreEntry[] = []
  for (const limit of input.limits) {
    if (limit.kind === "tooLarge") {
      warning.push({
        id: "limit:tooLarge",
        section: "warning",
        level: "warning",
        kind: "limit-too-large",
        count: limit.count,
        maxBytes: limit.maxBytes,
        action: { kind: "settings" },
      })
    } else {
      warning.push({
        id: "limit:quotaFull",
        section: "warning",
        level: "warning",
        kind: "limit-quota-full",
        action: { kind: "settings" },
      })
    }
  }
  if (input.itemErrors > 0) {
    warning.push({
      id: "item-errors",
      section: "warning",
      level: "warning",
      kind: "item-errors",
      count: input.itemErrors,
      action: { kind: "settings" },
    })
  }
  return warning
}

/** The ids of every record of "Attention" that has a cause now, hidden or not. */
export function liveWarningIds(input: CentreInput): string[] {
  return warningsOf({ ...input, hidden: [] }).map((entry) => entry.id)
}

/** Forgets the hiding of a record whose cause has gone: when it comes again, it is shown. */
export function reconcileHidden(hidden: string[], liveIds: string[]): string[] {
  const kept = hidden.filter((id) => liveIds.includes(id))
  return kept.length === hidden.length ? hidden : kept
}

export function deriveCentre(input: CentreInput): Centre {
  const decision: CentreEntry[] = []
  for (const conflict of input.conflicts) {
    decision.push({
      id: `sync-conflict:${conflict.id}`,
      section: "decision",
      level: "decision",
      kind: "sync-conflict",
      name: conflictName(conflict.originalPath),
      conflict,
      action: { kind: "compare", conflictId: conflict.id },
    })
  }
  if (input.stop) {
    decision.push({
      id: `sync-stop:${input.stop.kind}`,
      section: "decision",
      level: "decision",
      kind: "sync-stop",
      stop: input.stop,
      action: { kind: "settings" },
    })
  }

  const tabbed = new Set(input.tabbedDocIds)
  const open = Object.values(input.openDocs).filter((doc) => tabbed.has(doc.id))
  const relativeOf = (doc: CentreDoc) =>
    input.vault ? relativeToVault(doc.path, input.vault).normalize("NFC") : null
  const copy = (doc: CentreDoc, card: string, level: NoticeLevel) =>
    decision.push({
      id: noteNoticeId(doc.id, card),
      section: "decision",
      level,
      kind: "note-card",
      card,
      name: conflictName(doc.path),
      action: { kind: "note", id: doc.id },
    })
  for (const doc of open) {
    const relative = relativeOf(doc)
    const remoteDeleted = relative !== null && input.remoteDeleted.includes(relative)
    if (doc.externallyArchived) copy(doc, "archived-elsewhere", "decision")
    else if (remoteDeleted) copy(doc, "remote-deleted", "decision")
    else if (doc.externallyDeleted) copy(doc, "external-deleted", "decision")
    if (input.externalConflicts[doc.id] && !doc.externallyDeleted)
      copy(doc, "external-change", "decision")
    if (input.saveFailed[doc.id]) copy(doc, "save-failed", "danger")
    if (input.propertyFailed[doc.id]) copy(doc, "property-failed", "danger")
    if (input.draftOffers[doc.id]) copy(doc, "draft", "decision")
  }
  for (const [fileId, failure] of Object.entries(input.closedSaveFailures)) {
    // An open note has its own card for this; the record of the closed one would say it twice.
    if (tabbed.has(fileId) && input.openDocs[fileId]) continue
    decision.push({
      id: `closed-save-failed:${fileId}`,
      section: "decision",
      level: "danger",
      kind: "closed-save-failed",
      name: failure.name,
      action: { kind: "note", id: fileId },
    })
  }

  const warning = warningsOf(input).filter((entry) => !input.hidden.includes(entry.id))
  // A notice of the application stands until the person closes it, so it is not hidden: it is dismissed.
  for (const notice of input.appNotices ?? []) {
    const entry: CentreEntry = {
      id: `app:${notice.id}`,
      section: notice.level === "warning" ? "warning" : "decision",
      level: notice.level,
      kind: "app-notice",
      appNotice: notice,
      action: { kind: "settings" },
    }
    if (entry.section === "warning") warning.push(entry)
    else decision.push(entry)
  }
  return { decision: bySeriousness(decision), warning }
}

/** The number on the bell: the records of both sections, and the level of the most serious. */
export function centreCounter(centre: Centre): { count: number; level: NoticeLevel } | null {
  const all = [...centre.decision, ...centre.warning]
  if (all.length === 0) return null
  const level = all.reduce<NoticeLevel>(
    (worst, entry) =>
      noticeSeverityRank(entry.level) < noticeSeverityRank(worst) ? entry.level : worst,
    "warning",
  )
  return { count: all.length, level }
}
