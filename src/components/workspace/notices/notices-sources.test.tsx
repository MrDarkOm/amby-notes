// @vitest-environment happy-dom
// What the sync host announces and what it writes to the journal (docs/notices.md, sections 4, 6, 12 and the
// step 2 of the transition): a toast only for danger and a decision about something that is not on the
// screen, never for what is already there at the start; the events go to the journal.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import { listTrash, restoreTrash } from "@/lib/storage"
import { NoteNotices } from "../note-notices/note-notices"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { recordConflictOutcome } from "../sync/conflict-outcome"
import {
  createFakePort,
  emitMerged,
  emitRestoredAfterDeletion,
  emitVaultStatus,
  vaultStatus,
} from "../sync/fake-sync-port"
import { SyncNoticesHost } from "../sync/sync-notices-host"
import { useSyncNoticesStore } from "../sync/use-sync-notices-store"
import { useDocStore, type Document } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { NoticeToastHost } from "./notice-toasts-host"
import { useNoticeToastStore } from "./use-notice-toasts-store"
import { useNoticesCentreStore } from "./use-notices-centre-store"

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
const second = { ...conflict, id: "ba9876543210", originalPath: "Заметки/мысль.md" }

const doc = (path: string): Document => ({
  id: path,
  title: "идея",
  content: "текст",
  created: "",
  modified: "",
  wordCount: 1,
  path,
  source: "текст",
})

async function mount(
  status = vaultStatus(),
  port = createFakePort({ vaultStatus: async () => status }),
) {
  render(
    <>
      <SyncNoticesHost port={port} />
      <NoticeToastHost />
    </>,
  )
  await waitFor(() => expect(port.vaultStatus).toHaveBeenCalled())
  return port
}
const push = async (status: ReturnType<typeof vaultStatus>) => {
  await act(async () => emitVaultStatus(status))
}
const toasts = () => screen.queryAllByTestId("notice-toast")
const journal = () => useNoticeJournalStore.getState().entries

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({ vault: "/vault" })
  useDocStore.setState({ openDocs: {}, externalConflicts: {} })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
  useNoteNoticesStore.setState(useNoteNoticesStore.getInitialState())
  useNoticeToastStore.setState(useNoticeToastStore.getInitialState())
  useNoticesCentreStore.setState(useNoticesCentreStore.getInitialState())
  useNoticeJournalStore.setState(useNoticeJournalStore.getInitialState())
  vi.mocked(listTrash).mockResolvedValue([])
  vi.mocked(restoreTrash).mockResolvedValue({ changed: [] } as never)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("a new conflict", () => {
  it("is announced by a toast of a decision when its note is not open, and only once", async () => {
    await mount()
    await push(vaultStatus({ conflicts: [conflict] }))
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]!.getAttribute("data-level")).toBe("decision")
    expect(toasts()[0]!.textContent).toMatch(/«идея» изменили на двух компьютерах/)
    await push(vaultStatus({ conflicts: [conflict], lastSyncMs: 1_760_000_999_000 }))
    expect(toasts()).toHaveLength(1)
  })

  it("is one toast with a number when several come at once", async () => {
    await mount()
    await push(vaultStatus({ conflicts: [conflict, second] }))
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]!.textContent).toMatch(/Новых конфликтов: 2/)
  })

  it("is not announced when the note is open: the strip of the note announces it", async () => {
    useDocStore.setState({ openDocs: { [`/vault/${ORIGINAL}`]: doc(`/vault/${ORIGINAL}`) } })
    await mount()
    await push(vaultStatus({ conflicts: [conflict] }))
    expect(toasts()).toHaveLength(0)
    expect(useNoticeToastStore.getState().toasts).toEqual([])
  })

  it("is not announced when it was already there at the start, nor after a change of the vault", async () => {
    const port = await mount(vaultStatus({ conflicts: [conflict] }))
    await waitFor(() => expect(useSyncNoticesStore.getState().conflicts).toHaveLength(1))
    expect(toasts()).toHaveLength(0)
    port.vaultStatus.mockResolvedValue(vaultStatus({ conflicts: [conflict, second] }))
    await act(async () => useVaultStore.setState({ vault: "/other" }))
    await waitFor(() => expect(port.vaultStatus).toHaveBeenCalledTimes(2))
    expect(toasts()).toHaveLength(0)
    // What comes after the first status is news.
    const third = { ...conflict, id: "ccccccccccc1", originalPath: "Заметки/третья.md" }
    await push(vaultStatus({ conflicts: [conflict, second, third] }))
    expect(toasts()).toHaveLength(1)
  })

  it("is announced again if it was resolved and came back", async () => {
    await mount()
    await push(vaultStatus({ conflicts: [conflict] }))
    await push(vaultStatus({ conflicts: [] }))
    act(() => useNoticeToastStore.getState().clear())
    await push(vaultStatus({ conflicts: [conflict] }))
    expect(toasts()).toHaveLength(1)
  })
})

describe("a stop of the sync", () => {
  it("is announced by a toast of a decision, once for each stop", async () => {
    await mount()
    await push(vaultStatus({ stop: { kind: "vaultMissing" } }))
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]!.getAttribute("data-level")).toBe("decision")
    expect(toasts()[0]!.textContent).toMatch(/Папка хранилища не найдена/)
    await push(vaultStatus({ stop: { kind: "vaultMissing" }, lastSyncMs: 1 }))
    expect(toasts()).toHaveLength(1)
    // A toast goes with its cause: the new stop replaces the old one.
    await push(vaultStatus({ stop: { kind: "serverReset" } }))
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]!.textContent).toMatch(/Сервер сброшен или заменён/)
  })

  it("is not announced when it was there at the start", async () => {
    await mount(vaultStatus({ stop: { kind: "vaultMissing" } }))
    await waitFor(() => expect(useSyncNoticesStore.getState().stop).not.toBeNull())
    expect(toasts()).toHaveLength(0)
  })
})

describe("what is not announced", () => {
  it("a limit of the plan or a failed file appears in the centre, quietly", async () => {
    await mount()
    await push(
      vaultStatus({
        itemErrors: 2,
        unsynced: [
          { path: "big.bin", reason: "tooLarge", maxBytes: 1_000_000 },
          { path: "a.md", reason: "quotaFull" },
        ] as never,
      }),
    )
    expect(toasts()).toHaveLength(0)
    expect(useSyncNoticesStore.getState().limits).toHaveLength(2)
    expect(useSyncNoticesStore.getState().itemErrors).toBe(2)
  })

  it("a note that came back is not a toast, in an open note or in a closed one", async () => {
    await mount()
    await act(async () => emitRestoredAfterDeletion([ORIGINAL]))
    expect(toasts()).toHaveLength(0)
    expect(screen.queryByRole("status")).toBeNull()
  })
})

describe("the journal gets", () => {
  it("a note that came back, whether it is open or not, with the note it is about", async () => {
    await mount()
    await act(async () => emitRestoredAfterDeletion([ORIGINAL]))
    expect(journal()).toHaveLength(1)
    expect(journal()[0]).toMatchObject({
      kind: "restored",
      level: "info",
      target: ORIGINAL,
      params: { name: "идея" },
    })
  })

  it("a note that came back and is open also says so in its own notices", async () => {
    const open = `/vault/${ORIGINAL}`
    useDocStore.setState({ openDocs: { [open]: doc(open) } })
    await mount()
    render(<NoteNotices document={{ id: open, path: open }} warningKey={null} />)
    await act(async () => emitRestoredAfterDeletion([ORIGINAL]))
    expect(journal()).toHaveLength(1)
    expect(useNoteNoticesStore.getState().restored).toEqual([ORIGINAL])
    expect(toasts()).toHaveLength(0)
  })

  it("the merge of the edits of two computers (sync-merged), once for each note", async () => {
    await mount()
    await act(async () => emitMerged([ORIGINAL]))
    expect(journal()).toHaveLength(1)
    expect(journal()[0]).toMatchObject({
      kind: "merged",
      level: "info",
      target: ORIGINAL,
      params: { name: "идея" },
    })
    await act(async () => emitMerged([ORIGINAL, "Заметки/мысль.md"]))
    expect(journal()).toHaveLength(2)
    expect(journal().find((entry) => entry.target === ORIGINAL)!.count).toBe(2)
    expect(toasts()).toHaveLength(0)
  })

  it("the result of a choice in a conflict, for a note that is open and for one that is not", () => {
    recordConflictOutcome(conflict as never, "keepCopy")
    recordConflictOutcome(second as never, "keepBoth")
    expect(journal().map((entry) => [entry.kind, entry.params.choice, entry.params.name])).toEqual([
      ["conflictOutcome", "keepBoth", "мысль"],
      ["conflictOutcome", "keepCopy", "идея"],
    ])
    expect(journal().every((entry) => entry.level === "info")).toBe(true)
  })
})

describe("the backup before the first pass", () => {
  it("is a success in the journal when it is made, and nothing when it was there at the start", async () => {
    await mount()
    await push(vaultStatus({ backupPath: "/backups/vault-copy" }))
    expect(journal()).toHaveLength(1)
    expect(journal()[0]).toMatchObject({ kind: "backupReady", level: "success" })
    // The path of the copy is not written into the journal.
    expect(JSON.stringify(journal())).not.toMatch(/backups/)
    await push(vaultStatus({ backupPath: "/backups/vault-copy", lastSyncMs: 1 }))
    expect(journal()).toHaveLength(1)
    expect(toasts()).toHaveLength(0)
  })

  it("is not news at the start", async () => {
    await mount(vaultStatus({ backupPath: "/backups/vault-copy" }))
    await waitFor(() => expect(useSyncNoticesStore.getState().conflicts).toEqual([]))
    expect(journal()).toEqual([])
  })
})

describe("the merge in an open note", () => {
  const open = `/vault/${ORIGINAL}`

  async function mountOpen() {
    useDocStore.setState({ openDocs: { [open]: doc(open) } })
    await mount()
    render(<NoteNotices document={{ id: open, path: open }} warningKey={null} />)
  }

  it("is a quiet card, information, that the old version is in the history", async () => {
    await mountOpen()
    await act(async () => emitMerged([ORIGINAL]))
    const strip = await screen.findByTestId("note-notices-strip")
    // A card of information waits for a click: the stack is not opened by itself.
    expect(strip.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByTestId("note-notices-stack")).toBeNull()
    expect(strip.getAttribute("data-level")).toBe("info")
    fireEvent.click(strip)
    const card = await screen.findByTestId("note-notice-merged")
    expect(card.getAttribute("data-level")).toBe("info")
    expect(card.textContent).toMatch(/Правки двух компьютеров объединены/)
    expect(card.textContent).toMatch(/Прежняя версия — в истории/)
    expect(within(card).getByRole("button", { name: "Открыть историю" })).toBeTruthy()
  })

  it("can be closed, and does not come back with the next merge of another note", async () => {
    await mountOpen()
    await act(async () => emitMerged([ORIGINAL]))
    fireEvent.click(await screen.findByTestId("note-notices-strip"))
    const card = await screen.findByTestId("note-notice-merged")
    fireEvent.click(within(card).getByRole("button", { name: "Закрыть" }))
    await waitFor(() => expect(screen.queryByTestId("note-notice-merged")).toBeNull())
    await act(async () => emitMerged(["Заметки/мысль.md"]))
    expect(screen.queryByTestId("note-notice-merged")).toBeNull()
  })

  it("is not shown for a note that is not open", async () => {
    await mount()
    render(
      <NoteNotices
        document={{ id: "/vault/Заметки/другая.md", path: "/vault/Заметки/другая.md" }}
        warningKey={null}
      />,
    )
    await act(async () => emitMerged([ORIGINAL]))
    expect(screen.queryByTestId("note-notices-strip")).toBeNull()
  })
})
