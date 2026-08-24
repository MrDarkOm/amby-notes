import { describe, expect, it } from "vitest"
import {
  canRenderSplit,
  collectDocumentBufferUsage,
  selectEvictableDocumentIds,
} from "./document-buffer-lifecycle"
import type { Document } from "./use-doc-store"
import type { Tab } from "./use-tabs-store"

const note = (id: string): Document => ({
  id,
  title: id,
  content: id,
  created: "",
  modified: "",
  wordCount: 1,
  path: `/vault/${id}.md`,
})

const tab = (key: string, fileId: string): Tab => ({
  key,
  kind: "document",
  fileId,
  title: fileId,
  history: [fileId],
  historyIndex: 0,
})

describe("document buffer lifecycle", () => {
  it("keeps a buffer while any tab or split pane references it, then releases it after close", () => {
    const tabs = [tab("first", "one"), tab("second", "two")]
    const usage = collectDocumentBufferUsage(tabs, "first", "second")
    expect(usage.get("one")).toEqual({ tabRefs: 1, paneRefs: 1 })
    expect(usage.get("two")).toEqual({ tabRefs: 1, paneRefs: 1 })

    const eligible = selectEvictableDocumentIds({
      openDocs: { one: note("one"), two: note("two") },
      unsavedFileIds: new Set(),
      externalConflicts: {},
      tabs: [tabs[1]],
      activeTabKey: "second",
      secondaryTabKey: null,
      hasPendingAutosave: () => false,
      hasRecoveryDraft: () => false,
    })
    expect(eligible).toEqual(["one"])
  })

  it("retains a closed buffer with pending save or recovery state and permits reopen", () => {
    const input = {
      openDocs: { note: note("note") },
      unsavedFileIds: new Set<string>(),
      externalConflicts: {},
      tabs: [],
      activeTabKey: "",
      secondaryTabKey: null,
      hasRecoveryDraft: () => false,
    }
    expect(selectEvictableDocumentIds({ ...input, hasPendingAutosave: () => true })).toEqual([])
    expect(
      selectEvictableDocumentIds({
        ...input,
        hasPendingAutosave: () => false,
        hasRecoveryDraft: () => true,
      }),
    ).toEqual([])
    expect(selectEvictableDocumentIds({ ...input, hasPendingAutosave: () => false })).toEqual([
      "note",
    ])

    expect(
      selectEvictableDocumentIds({
        ...input,
        tabs: [tab("reopened", "note")],
        activeTabKey: "reopened",
        hasPendingAutosave: () => false,
      }),
    ).toEqual([])
  })

  it("refuses a split that would mount one note in two editable panes", () => {
    expect(canRenderSplit(tab("one", "note"), tab("duplicate", "note"))).toBe(false)
    expect(canRenderSplit(tab("one", "note"), tab("two", "other"))).toBe(true)
  })
})
