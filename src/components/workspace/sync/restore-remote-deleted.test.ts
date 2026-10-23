// @vitest-environment happy-dom
// Bringing a note back from the archive must not break the open buffer (Opus review of the sync UX).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { listTrash, readNote, restoreTrash } from "@/lib/storage"
import { useDocStore, type Document } from "../use-doc-store"
import { restoreRemoteDeleted } from "./restore-remote-deleted"
import { useSyncNoticesStore } from "./use-sync-notices-store"

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  listTrash: vi.fn(),
  readNote: vi.fn(),
  restoreTrash: vi.fn(),
}))

const REL = "Заметки/идея.md"
const doc = (content: string): Document => ({
  id: "n1",
  title: "идея",
  content,
  created: "",
  modified: "",
  wordCount: 1,
  path: `/vault/${REL}`,
  source: content,
  externallyDeleted: true,
})

beforeEach(() => {
  useDocStore.setState({ openDocs: {}, externalConflicts: {}, unsavedFileIds: new Set() })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
  useSyncNoticesStore.getState().markRemoteDeleted(REL)
  vi.mocked(listTrash).mockResolvedValue([
    { id: "t1", originalPath: REL, deletedAtMs: 1, name: "идея" },
  ])
  vi.mocked(restoreTrash).mockResolvedValue({ changed: [] } as never)
})

describe("restoreRemoteDeleted", () => {
  it("clears the deleted flag of the open note when the text is the same", async () => {
    useDocStore.setState({ openDocs: { n1: doc("текст") } })
    vi.mocked(readNote).mockResolvedValue({
      content: "текст",
      revision: "r2",
      source: "текст",
    } as never)
    await restoreRemoteDeleted("/vault", REL)
    expect(useDocStore.getState().openDocs.n1?.externallyDeleted).toBe(false)
    expect(useSyncNoticesStore.getState().remoteDeleted).toEqual([])
  })

  it("keeps unsaved edits as an external conflict instead of dropping them", async () => {
    useDocStore.setState({ openDocs: { n1: doc("новый текст") } })
    vi.mocked(readNote).mockResolvedValue({
      content: "старый",
      revision: "r2",
      source: "старый",
    } as never)
    await restoreRemoteDeleted("/vault", REL)
    const conflict = useDocStore.getState().externalConflicts.n1
    expect(conflict?.localContent).toBe("новый текст")
    expect(conflict?.externalContent).toBe("старый")
  })

  it("marks the failure so the general strip comes back", async () => {
    useDocStore.setState({ openDocs: { n1: doc("текст") } })
    vi.mocked(listTrash).mockResolvedValue([])
    await expect(restoreRemoteDeleted("/vault", REL)).rejects.toThrow()
    expect(useSyncNoticesStore.getState().restoreFailed).toEqual([REL])
    expect(useSyncNoticesStore.getState().remoteDeleted).toEqual([REL])
  })
})
