// @vitest-environment happy-dom
// The toasts, the records of the centre and the number on the bell have a level of docs/notices.md (section 2.1)
// and are drawn by it: a conflict is a decision, a limit of the plan is a warning, a note that came back is
// information and lives in the journal, never in a toast.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { listTrash, restoreTrash } from "@/lib/storage"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { SyncNoticesHost } from "./sync-notices-host"
import { NoticeToastHost } from "../notices/notice-toasts-host"
import { useNoticesStackStore } from "../notices/use-notices-stack-store"
import { useNoticeToastStore } from "../notices/use-notice-toasts-store"
import { useNoticesCentreStore } from "../notices/use-notices-centre-store"
import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import { NoticesDock } from "./dock-test-harness"
import { useSyncNoticesStore } from "./use-sync-notices-store"
import {
  createFakePort,
  emitRestoredAfterDeletion,
  emitVaultStatus,
  vaultStatus,
} from "./fake-sync-port"

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
  readGlobalRaw: vi.fn(async () => null),
  writeGlobalRaw: vi.fn(async () => {}),
}))

const ORIGINAL = "Заметки/идея.md"
const conflict = {
  id: "0123456789ab",
  kind: "bothEdited",
  originalPath: ORIGINAL,
  copyPath: "Заметки/идея.0123456789ab-conflict.md",
  createdMs: 1_760_000_000_000,
}

async function mount(status = vaultStatus()) {
  const port = createFakePort({ vaultStatus: async () => status })
  render(
    <>
      <SyncNoticesHost port={port} />
      <NoticeToastHost />
      <NoticesDock port={port} />
    </>,
  )
  await waitFor(() => expect(port.vaultStatus).toHaveBeenCalled())
  return port
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({ vault: "/vault" })
  useDocStore.setState({ openDocs: {}, externalConflicts: {} })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
  useNoteNoticesStore.setState(useNoteNoticesStore.getInitialState())
  useNoticeToastStore.setState(useNoticeToastStore.getInitialState())
  useNoticesCentreStore.setState(useNoticesCentreStore.getInitialState())
  useNoticesStackStore.setState(useNoticesStackStore.getInitialState())
  useNoticeJournalStore.setState(useNoticeJournalStore.getInitialState())
  vi.mocked(listTrash).mockResolvedValue([])
  vi.mocked(restoreTrash).mockResolvedValue({ changed: [] } as never)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the level of what the sync host says", () => {
  it("a note that came back after a deletion is information in the journal, not a triangle", async () => {
    await mount()
    await act(async () => emitRestoredAfterDeletion([ORIGINAL]))
    act(() => useNoticesStackStore.getState().open())
    const row = await screen.findByTestId("notices-journal-entry")
    expect(row.getAttribute("data-level")).toBe("info")
    expect(row.querySelector("svg.lucide-info")).not.toBeNull()
    expect(row.querySelector("svg.lucide-triangle-alert")).toBeNull()
    expect(screen.queryByTestId("notice-toast")).toBeNull()
  })

  it("a new conflict is a decision, in the toast and in the centre", async () => {
    await mount()
    await act(async () => emitVaultStatus(vaultStatus({ conflicts: [conflict] })))
    const toast = await screen.findByTestId("notice-toast")
    expect(toast.textContent).toMatch(/изменена на двух компьютерах/)
    expect(toast.getAttribute("data-level")).toBe("decision")
    expect(toast.querySelector("svg.lucide-triangle-alert")).not.toBeNull()
  })

  it("the number on the dock button is a decision for a conflict, and no floating badge is left", async () => {
    await mount(vaultStatus({ conflicts: [conflict] }))
    const count = await screen.findByTestId("notices-dock-count")
    expect(count.getAttribute("data-level")).toBe("decision")
    expect(count.getAttribute("class")).toContain("--notice-decision-")
    expect(count.getAttribute("class")).not.toMatch(/amber/)
    expect(screen.queryByTestId("sync-conflict-badge")).toBeNull()
  })

  it("the files over the limit, and the full storage, are warnings of the centre, and no toasts", async () => {
    await mount()
    await act(async () =>
      emitVaultStatus(
        vaultStatus({
          unsynced: [
            {
              path: "a.bin",
              reason: "tooLarge",
              detail: null,
              maxBytes: 20_000_000,
              limitSource: "plan",
            },
            { path: "b.bin", reason: "quotaFull", detail: null },
          ],
        }),
      ),
    )
    act(() => useNoticesStackStore.getState().open())
    const entries = await screen.findAllByTestId("notices-entry")
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      expect(entry.getAttribute("data-level")).toBe("warning")
      expect(entry.getAttribute("role")).toBe("status")
      expect(entry.querySelector("svg.lucide-circle-alert")).not.toBeNull()
    }
    expect(screen.queryByTestId("notice-toast")).toBeNull()
  })

  it("nothing keeps an amber class", async () => {
    await mount()
    await act(async () => emitRestoredAfterDeletion([ORIGINAL]))
    await act(async () =>
      emitVaultStatus(
        vaultStatus({
          conflicts: [conflict],
          unsynced: [{ path: "b.bin", reason: "quotaFull", detail: null }],
        }),
      ),
    )
    await screen.findByTestId("notices-dock-count")
    expect(document.body.innerHTML).not.toMatch(/amber/)
  })
})
