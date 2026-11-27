import type { DatabaseSummary, TreeItem } from "@/lib/storage"
import type { Document } from "../use-doc-store"

type DatabaseLayer = Pick<DatabaseSummary, "databaseId" | "title" | "icon" | "attachedNoteId">

/** The filesystem tree knows a newly attached manifest before the catalog refresh can publish it. */
export function findDocumentDatabaseLayer(
  databases: readonly DatabaseSummary[],
  document: Pick<Document, "id" | "noteId" | "path"> | null,
  treeItem: TreeItem | null | undefined,
  tabFileId?: string,
): DatabaseLayer | undefined {
  const member = treeItem?.bundleMembers?.find((item) => item.type === "database")
  const ids = new Set([
    document?.id,
    document?.noteId,
    document?.path,
    treeItem?.id,
    treeItem?.path,
    tabFileId,
  ])
  const found = databases.find(
    (database) =>
      database.databaseId === member?.id ||
      ids.has(database.databaseId) ||
      (database.attachedNoteId !== null && ids.has(database.attachedNoteId)),
  )
  if (found) return found
  if (!member) return undefined
  return {
    databaseId: member.id,
    title: member.name,
    icon: member.icon ?? null,
    attachedNoteId: document?.noteId ?? (treeItem?.type === "file" ? treeItem.id : null),
  }
}
