import { useTreeMessageStore } from "../tree/use-tree-message-store"

/**
 * The titles of the line under the tree for an action of the tree that failed (docs/notices.md, sections 3 and 8).
 * Written out in full so that every key has a place in the code. The reason is in the debug log, not here.
 */
const FAILURE_TITLES = {
  createNote: "notices.tree.createNoteFailed",
  createFolder: "notices.tree.createFolderFailed",
  createCanvas: "notices.tree.createCanvasFailed",
  createSketch: "notices.tree.createSketchFailed",
  cloneNote: "notices.tree.cloneNoteFailed",
} as const

export type TreeActionFailure = keyof typeof FAILURE_TITLES

/** A creation or a copy in the tree did not happen: a warning under the tree, in words; nothing was changed. */
export function reportTreeActionFailure(kind: TreeActionFailure): void {
  useTreeMessageStore.getState().show({
    id: `action-failed:${kind}`,
    level: "warning",
    titleKey: FAILURE_TITLES[kind],
    lineKey: "notices.tree.nothingChanged",
  })
}
