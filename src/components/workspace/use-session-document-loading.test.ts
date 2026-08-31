import { describe, expect, it, vi } from "vitest"
import type { Document } from "./use-doc-store"
import type { Tab } from "./use-tabs-store"
import { loadMissingSessionDocuments } from "./use-session-document-loading"

function document(fileId: string): Document {
  return {
    id: fileId,
    title: fileId,
    content: "",
    created: "—",
    modified: "—",
    wordCount: 0,
    path: `/vault/${fileId}.md`,
    source: "",
  }
}

function tab(fileId: string, kind: Tab["kind"] = "document"): Tab {
  if (kind !== "document") {
    return {
      key: `${kind}:${fileId}`,
      kind,
      fileId,
      title: fileId,
      history: [],
      historyIndex: 0,
    } as Tab
  }
  return {
    key: `document:${fileId}`,
    kind: "document",
    fileId,
    title: fileId,
    history: [fileId],
    historyIndex: 0,
  }
}

describe("restored session document loading", () => {
  it("loads missing document tabs sequentially and skips non-documents and duplicates", async () => {
    let activeLoads = 0
    let maximumActiveLoads = 0
    const order: string[] = []
    const loadDocument = vi.fn(async (fileId: string) => {
      activeLoads += 1
      maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads)
      order.push(`start:${fileId}`)
      await Promise.resolve()
      order.push(`end:${fileId}`)
      activeLoads -= 1
      return document(fileId)
    })

    await loadMissingSessionDocuments({
      tabs: [tab("folder", "folder"), tab("one"), tab("one"), tab("two"), tab("loaded")],
      isLoaded: (fileId) => fileId === "loaded",
      isCurrent: () => true,
      loadDocument,
    })

    expect(maximumActiveLoads).toBe(1)
    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"])
    expect(loadDocument).toHaveBeenCalledTimes(2)
  })

  it("stops before the next restored tab when its generation becomes stale", async () => {
    let current = true
    const loadDocument = vi.fn(async (fileId: string) => {
      current = false
      return document(fileId)
    })

    await loadMissingSessionDocuments({
      tabs: [tab("one"), tab("two")],
      isLoaded: () => false,
      isCurrent: () => current,
      loadDocument,
    })

    expect(loadDocument).toHaveBeenCalledOnce()
    expect(loadDocument).toHaveBeenCalledWith("one", "one")
  })
})
