import { newTabKey } from "../workspace-tree-utils"
import type { Tab, TabTarget } from "../use-tabs-store"

export type DatabaseTabTarget = Pick<TabTarget, "fileId" | "title"> & {
  kind: "database"
}

export function createDatabaseTab(target: DatabaseTabTarget): Tab {
  return {
    ...target,
    key: newTabKey(),
    history: [target.fileId],
    historyIndex: 0,
  }
}
