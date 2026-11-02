import { useDocStore, type Document } from "../use-doc-store"
import { formatModified } from "../workspace-tree-utils"

export function createFallbackDocument(
  fileId: string,
  title: string,
  path: string,
  created?: number | string,
  modified?: number | string,
): Document {
  const doc: Document = {
    id: fileId,
    title,
    content: "",
    created: typeof created === "number" ? formatModified(created) : (created ?? ""),
    modified: typeof modified === "number" ? formatModified(modified) : (modified ?? ""),
    wordCount: 0,
    path,
    revision: "",
    source: "",
  }
  const state = useDocStore.getState()
  if (!state.openDocs[fileId]) {
    state.setDoc(fileId, doc)
    if (path && path !== fileId && !state.openDocs[path]) {
      state.setDoc(path, doc)
    }
  }
  return doc
}
