import type { Document, ExternalConflict } from "./use-doc-store"
import type { Tab } from "./use-tabs-store"

export interface DocumentBufferUsage {
  tabRefs: number
  paneRefs: number
}

export interface EvictionCandidateInput {
  openDocs: Record<string, Document>
  unsavedFileIds: Set<string>
  externalConflicts: Record<string, ExternalConflict>
  tabs: Tab[]
  activeTabKey: string
  secondaryTabKey: string | null
  hasPendingAutosave: (fileId: string) => boolean
  hasRecoveryDraft: (fileId: string, document: Document) => boolean
}

/** Count references held by document tabs and the two rendered editor panes. */
export function collectDocumentBufferUsage(
  tabs: Tab[],
  activeTabKey: string,
  secondaryTabKey: string | null,
): Map<string, DocumentBufferUsage> {
  const usage = new Map<string, DocumentBufferUsage>()
  const add = (fileId: string, field: keyof DocumentBufferUsage) => {
    const current = usage.get(fileId) ?? { tabRefs: 0, paneRefs: 0 }
    usage.set(fileId, { ...current, [field]: current[field] + 1 })
  }

  for (const tab of tabs) {
    if (
      tab.kind === "document" ||
      tab.kind === "canvas" ||
      tab.kind === "sketch" ||
      tab.kind === "database"
    ) {
      add(tab.fileId, "tabRefs")
    }
  }
  for (const key of [activeTabKey, secondaryTabKey]) {
    if (!key) continue
    const tab = tabs.find((item) => item.key === key)
    if (
      tab?.kind === "document" ||
      tab?.kind === "canvas" ||
      tab?.kind === "sketch" ||
      tab?.kind === "database"
    ) {
      add(tab.fileId, "paneRefs")
    }
  }
  return usage
}

/**
 * The entries one step back and one step forward in every tab's history. Their clean buffers stay
 * in memory, so Back and Forward show the note at once instead of reading it again.
 */
export function historyNeighbours(tabs: Tab[]): Set<string> {
  const ids = new Set<string>()
  for (const tab of tabs) {
    for (const index of [tab.historyIndex - 1, tab.historyIndex + 1]) {
      const fileId = tab.history[index]
      if (fileId) ids.add(fileId)
    }
  }
  return ids
}

/** Return clean buffers which no tab or pane owns, nor a tab's next step back or forward. */
export function selectEvictableDocumentIds({
  openDocs,
  unsavedFileIds,
  externalConflicts,
  tabs,
  activeTabKey,
  secondaryTabKey,
  hasPendingAutosave,
  hasRecoveryDraft,
}: EvictionCandidateInput): string[] {
  const usage = collectDocumentBufferUsage(tabs, activeTabKey, secondaryTabKey)
  const neighbours = historyNeighbours(tabs)
  return Object.entries(openDocs)
    .filter(([fileId, document]) => {
      const refs = usage.get(fileId) ?? (document.path ? usage.get(document.path) : undefined)
      return (
        !refs &&
        !neighbours.has(fileId) &&
        !(document.path && neighbours.has(document.path)) &&
        !unsavedFileIds.has(fileId) &&
        !externalConflicts[fileId] &&
        !hasPendingAutosave(fileId) &&
        !hasRecoveryDraft(fileId, document)
      )
    })
    .map(([fileId]) => fileId)
}

/** A split must never place two editable editors over one document buffer. */
export function canRenderSplit(activeTab: Tab | null, secondaryTab: Tab | null): boolean {
  return Boolean(
    activeTab?.kind === "document" &&
    secondaryTab?.kind === "document" &&
    activeTab.key !== secondaryTab.key &&
    activeTab.fileId !== secondaryTab.fileId,
  )
}
