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
    if (tab.kind === "document") add(tab.fileId, "tabRefs")
  }
  for (const key of [activeTabKey, secondaryTabKey]) {
    if (!key) continue
    const tab = tabs.find((item) => item.key === key)
    if (tab?.kind === "document") add(tab.fileId, "paneRefs")
  }
  return usage
}

/** Return clean buffers which no tab or pane owns. */
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
  return Object.entries(openDocs)
    .filter(([fileId, document]) => {
      const refs = usage.get(fileId)
      return (
        !refs &&
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
