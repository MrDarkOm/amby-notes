// @vitest-environment happy-dom
// Conflicts of sync made visible (docs/sync-plan.md, Р7, Р8): a badge with a list, a short notice,
// a card in the note, a side-by-side comparison, and the warning about a note deleted on another
// computer that was open at that moment. Behaviour only; how it looks is checked in a native window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { getNoteProperties, listTrash, readFile, restoreTrash } from "@/lib/storage"
import type { Document } from "../use-doc-store"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import {
  createFakePort,
  emitAmbyWritten,
  emitRemoteDeleted,
  emitRestoredAfterDeletion,
  emitVaultStatus,
  vaultStatus,
} from "./fake-sync-port"
import { NoteNotices } from "../note-notices/note-notices"
import { SyncNoticesHost } from "./sync-notices-host"
import { NoticesDock } from "./dock-test-harness"
import { NoticeToastHost } from "../notices/notice-toasts-host"
import { useNoticesStackStore } from "../notices/use-notices-stack-store"
import { useNoticeToastStore } from "../notices/use-notice-toasts-store"
import { useNoticesCentreStore } from "../notices/use-notices-centre-store"
import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import { dockButton } from "./dock-button"
import { useSyncNoticesStore } from "./use-sync-notices-store"

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  readGlobalRaw: vi.fn(async () => null),
  writeGlobalRaw: vi.fn(async () => {}),
  readFile: vi.fn(),
  getNoteProperties: vi.fn(),
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
}))

const ORIGINAL = "Заметки/идея.md"
const COPY = "Заметки/идея.0123456789ab-conflict.md"
const conflict = {
  id: "0123456789ab",
  kind: "bothEdited",
  originalPath: ORIGINAL,
  copyPath: COPY,
  createdMs: 1_760_000_000_000,
}

/** The notices of the note at `path`, as the editor wears them. */
const notes = (path: string) => <NoteNotices document={{ id: path, path }} warningKey={null} />

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

async function mount(status = vaultStatus()) {
  const port = createFakePort({
    vaultStatus: async () => status,
    readConflictVersions: async () => ({
      original: "основная версия",
      copy: "версия с другого компьютера",
      stamp: "stamp-1",
    }),
  })
  const view = render(
    <>
      <SyncNoticesHost port={port} />
      <NoticeToastHost />
      <NoticesDock />
    </>,
  )
  await waitFor(() => expect(port.vaultStatus).toHaveBeenCalled())
  return { port, ...view }
}

/** The cards of the panel, not the line of the strip that repeats the title of the most serious one. */
const stackCards = async () => within(await screen.findByTestId("note-notices-stack"))

const pushStatus = async (status: ReturnType<typeof vaultStatus>) => {
  await act(async () => emitVaultStatus(status))
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({ vault: "/vault" })
  useDocStore.setState({ openDocs: {}, externalConflicts: {} })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
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

/** Opens the notification centre with a click on the bell, as a person does. */
const openCentre = async () => {
  fireEvent.click(dockButton()!)
  return screen.findByTestId("notices-centre")
}

describe("the dock button and the conflicts in the centre", () => {
  it("shows no number while there is no conflict, and no floating badge", async () => {
    await mount()
    expect(dockButton()).not.toBeNull()
    expect(screen.queryByTestId("notices-dock-count")).toBeNull()
    expect(screen.queryByTestId("sync-conflict-badge")).toBeNull()
  })

  it("shows the number of conflicts on the dock button, and the list in the centre on a click", async () => {
    await mount(vaultStatus({ conflicts: [conflict, { ...conflict, id: "ba9876543210" }] }))
    const count = await screen.findByTestId("notices-dock-count")
    expect(count.textContent).toContain("2")
    expect(dockButton()!.getAttribute("aria-label")).toMatch(/Уведомления: 2/)
    expect(screen.queryByTestId("notices-entry")).toBeNull()
    const centre = await openCentre()
    const cards = within(centre).getAllByTestId("notices-entry")
    expect(cards).toHaveLength(2)
    expect(within(centre).getAllByText("Заметка «идея» изменена на двух компьютерах")).toHaveLength(
      2,
    )
    expect(centre.textContent).not.toMatch(/conflict\.md|\.amby|Заметки\//)
  })

  it("takes the number away once the conflict is resolved, and the stack stays open", async () => {
    await mount(vaultStatus({ conflicts: [conflict] }))
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    await within(centre).findByTestId("notices-entry")
    await pushStatus(vaultStatus({ conflicts: [] }))
    await waitFor(() => expect(screen.queryByTestId("notices-dock-count")).toBeNull())
    expect(screen.queryByTestId("notices-entry")).toBeNull()
    expect(screen.getByTestId("notices-centre")).toBeTruthy()
    expect(dockButton()).not.toBeNull()
  })

  it("has one button in a line, and the choice is made in the comparison with the existing command", async () => {
    const { port } = await mount(vaultStatus({ conflicts: [conflict] }))
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    const list = within(centre).getByTestId("notices-entry")
    expect(within(list).getAllByRole("button")).toHaveLength(1)
    expect(within(list).queryByRole("button", { name: /Оставить|Взять|Сохранить/ })).toBeNull()
    fireEvent.click(within(list).getByRole("button", { name: "Сравнить" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Оставить версию в заметке" }),
    )
    await waitFor(() =>
      expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", "keepOriginal"),
    )
  })

  it("chooses a conflict of a group of note properties by notes, as the settings do (З69)", async () => {
    const group = {
      ...conflict,
      originalPath: ".amby/properties/prop_3.jsonl",
      copyPath: ".amby/conflicts/0123456789ab/other.jsonl",
      hasBase: true,
    }
    const resolveGroupConflict = vi.fn(async () => {})
    const port = createFakePort({
      vaultStatus: async () => vaultStatus({ conflicts: [group] }),
      readGroupConflict: vi.fn(async () => ({
        group: {
          notes: [
            {
              noteId: "A",
              notePath: "Идея.md",
              noteTitle: "Идея",
              changes: [],
              orderDiffers: true,
              currentRemoved: false,
              otherRemoved: false,
            },
          ],
          autoMerged: 2,
        },
        stamp: "stamp-g",
      })),
      resolveGroupConflict,
    })
    render(
      <>
        <SyncNoticesHost port={port} />
        <NoticesDock port={port} />
      </>,
    )
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    const row = within(centre).getAllByTestId("notices-entry")[0]!
    expect(row.getAttribute("data-kind")).toBe("sync-conflict")
    const notes = await within(row).findByTestId("sync-group-notes")
    expect(notes.textContent).toMatch(/«Идея»/)
    expect(within(row).queryByRole("button", { name: "Взять с другого компьютера" })).toBeNull()
    fireEvent.click(within(notes).getByRole("radio", { name: "Другой компьютер" }))
    fireEvent.click(within(row).getByRole("button", { name: "Применить" }))
    await waitFor(() =>
      expect(resolveGroupConflict).toHaveBeenCalledWith("0123456789ab", { A: "other" }, "stamp-g"),
    )
    expect(port.resolveConflict).not.toHaveBeenCalled()
  })
})

describe("the notice about a new conflict", () => {
  it("is a toast that appears when a conflict of a note that is not open appears, once", async () => {
    await mount()
    await pushStatus(vaultStatus({ conflicts: [conflict] }))
    const notice = await screen.findByTestId("notice-toast")
    expect(notice.textContent).toMatch(/изменена на двух компьютерах/)
    expect(notice.textContent).toMatch(/идея/)
    await pushStatus(vaultStatus({ conflicts: [conflict], lastSyncMs: 1_760_000_999_000 }))
    expect(screen.getAllByTestId("notice-toast")).toHaveLength(1)
  })

  it("is not shown for a conflict that was already there when the screen opened", async () => {
    await mount(vaultStatus({ conflicts: [conflict] }))
    await screen.findByTestId("notices-dock-count")
    expect(screen.queryByTestId("notice-toast")).toBeNull()
  })

  it("is not shown for a note that is open: its own strip says it", async () => {
    useDocStore.setState({ openDocs: { a: doc(`/vault/${ORIGINAL}`) } })
    await mount()
    await pushStatus(vaultStatus({ conflicts: [conflict] }))
    expect(screen.queryByTestId("notice-toast")).toBeNull()
  })
})

describe("the note brought back after a deletion made here", () => {
  it("is in the journal, whether the note is open or not, and names it", async () => {
    await mount()
    await act(async () => emitRestoredAfterDeletion([ORIGINAL]))
    expect(screen.queryByTestId("notice-toast")).toBeNull()
    expect(screen.queryByRole("status")).toBeNull()
    const centre = await openCentre()
    const entry = within(centre).getByTestId("notices-journal-entry")
    expect(entry.textContent).toMatch(/Заметку «идея» вернули/)
    expect(entry.textContent).toMatch(/правили на другом компьютере/)
    expect(useDocStore.getState().openDocs).toEqual({})
  })
})

describe("the card of a note that has a second version", () => {
  const strip = /Заметка «идея» изменена на двух компьютерах/

  it("is shown in the main file and in the copy, and not in another note", async () => {
    await mount(vaultStatus({ conflicts: [conflict] }))
    const { rerender } = render(notes(`/vault/${ORIGINAL}`))
    expect(await (await stackCards()).findByText(strip)).toBeTruthy()
    rerender(notes(`/vault/${COPY}`))
    expect(await (await stackCards()).findByText(strip)).toBeTruthy()
    rerender(notes("/vault/Заметки/другая.md"))
    expect(screen.queryByText(strip)).toBeNull()
  })

  it("goes away when the conflict is resolved", async () => {
    await mount(vaultStatus({ conflicts: [conflict] }))
    render(notes(`/vault/${ORIGINAL}`))
    await (await stackCards()).findByText(strip)
    await pushStatus(vaultStatus({ conflicts: [] }))
    await waitFor(() => expect(screen.queryByText(strip)).toBeNull())
  })
})

describe("the comparison of the two versions", () => {
  async function openFromStrip() {
    const view = await mount(vaultStatus({ conflicts: [conflict] }))
    render(notes(`/vault/${COPY}`))
    fireEvent.click(await screen.findByRole("button", { name: "Сравнить" }))
    const dialog = await screen.findByRole("dialog")
    return { ...view, dialog }
  }

  it("opens from the card and shows both versions side by side, read through the port", async () => {
    const { port, dialog } = await openFromStrip()
    await waitFor(() => expect(within(dialog).getByText("основная версия")).toBeTruthy())
    expect(within(dialog).getByText("версия с другого компьютера")).toBeTruthy()
    expect(port.readConflictVersions).toHaveBeenCalledWith("0123456789ab")
    expect(vi.mocked(readFile)).not.toHaveBeenCalled()
  })

  it("opens from the list too", async () => {
    await mount(vaultStatus({ conflicts: [conflict] }))
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    fireEvent.click(await within(centre).findByRole("button", { name: "Сравнить" }))
    expect(await screen.findByRole("dialog")).toBeTruthy()
  })

  it.each([
    ["Оставить версию в заметке", "keepOriginal"],
    ["Взять вторую версию", "keepCopy"],
  ])("offers “%s” and resolves the conflict with the existing command", async (label, choice) => {
    const { port, dialog } = await openFromStrip()
    fireEvent.click(within(dialog).getByRole("button", { name: label }))
    await waitFor(() => expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", choice))
  })

  it("offers keeping both as separate notes in the menu", async () => {
    const { port, dialog } = await openFromStrip()
    fireEvent.pointerDown(within(dialog).getByRole("button", { name: "Другие варианты" }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Сохранить обе как отдельные заметки" }),
    )
    await waitFor(() =>
      expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", "keepBoth"),
    )
  })

  it("closes once the conflict has left the list", async () => {
    await openFromStrip()
    await pushStatus(vaultStatus({ conflicts: [] }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })
})

describe("what was done after the choice", () => {
  it("is a card in the note when the note is open", async () => {
    useDocStore.setState({ openDocs: { a: doc(`/vault/${ORIGINAL}`) } })
    const { port } = await mount(vaultStatus({ conflicts: [conflict] }))
    render(notes(`/vault/${ORIGINAL}`))
    fireEvent.click(await screen.findByRole("button", { name: "Сравнить" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(await within(dialog).findByRole("button", { name: "Взять вторую версию" }))
    await waitFor(() => expect(port.resolveConflict).toHaveBeenCalled())
    await pushStatus(vaultStatus({ conflicts: [] }))
    // the stack was open for the question; if it closed with it, the strip opens it again
    if (!screen.queryByTestId("note-notices-stack")) {
      fireEvent.click(await screen.findByTestId("note-notices-strip"))
    }
    const cards = await stackCards()
    expect(
      await cards.findByText("В заметке «идея» теперь вторая версия. Прежняя — в истории заметки."),
    ).toBeTruthy()
    expect(cards.getByRole("button", { name: "Открыть историю" })).toBeTruthy()
  })

  it("is a line of the journal when the note is not open, and no card anywhere", async () => {
    const { port } = await mount(vaultStatus({ conflicts: [conflict] }))
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    fireEvent.click(await within(centre).findByRole("button", { name: "Сравнить" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Оставить версию в заметке" }),
    )
    await waitFor(() => expect(port.resolveConflict).toHaveBeenCalled())
    await pushStatus(vaultStatus({ conflicts: [] }))
    // The centre stays open and keeps the news, in the journal, as long as the person wants.
    const entry = await within(screen.getByTestId("notices-centre")).findByTestId(
      "notices-journal-entry",
    )
    expect(entry.textContent).toMatch(
      "Оставлена версия в заметке «идея». Вторая версия — в корзине хранилища.",
    )
    expect(screen.queryByTestId("sync-conflict-outcome")).toBeNull()
    expect(useSyncNoticesStore.getState().outcomes).toEqual([])
  })

  it("is in the journal also when the note is open, besides the card", async () => {
    useDocStore.setState({ openDocs: { a: doc(`/vault/${ORIGINAL}`) } })
    const { port } = await mount(vaultStatus({ conflicts: [conflict] }))
    render(notes(`/vault/${ORIGINAL}`))
    fireEvent.click(await screen.findByRole("button", { name: "Сравнить" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(await within(dialog).findByRole("button", { name: "Взять вторую версию" }))
    await waitFor(() => expect(port.resolveConflict).toHaveBeenCalled())
    expect(useNoticeJournalStore.getState().entries.map((entry) => entry.params.choice)).toEqual([
      "keepCopy",
    ])
  })

  it("is forgotten with the vault it was about", async () => {
    useSyncNoticesStore.setState({
      outcomes: [{ conflictId: "x", path: ORIGINAL, name: "идея", choice: "keepBoth" }],
    })
    await mount()
    await waitFor(() => expect(useSyncNoticesStore.getState().outcomes).toEqual([]))
  })
})

describe("a note deleted on another computer", () => {
  const message = /Эту заметку удалили на другом компьютере\. Она в архиве хранилища/

  it("is announced when that note is open, with a way back", async () => {
    useDocStore.setState({ openDocs: { a: doc(`/vault/${ORIGINAL}`) } })
    await mount()
    render(notes(`/vault/${ORIGINAL}`))
    expect(screen.queryByText(message)).toBeNull()
    await act(async () => emitRemoteDeleted([ORIGINAL]))
    expect(await (await stackCards()).findByText(message)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Вернуть" })).toBeTruthy()
  })

  it("ignores an announcement that belongs to the vault it left behind", async () => {
    // a late event of the previous vault must not mark the note of the same name in this one
    useDocStore.setState({ openDocs: { a: doc(`/vault/${ORIGINAL}`) } })
    await mount()
    render(notes(`/vault/${ORIGINAL}`))
    await act(async () => emitRemoteDeleted([ORIGINAL], "/old-vault"))
    expect(screen.queryByText(message)).toBeNull()
    expect(useSyncNoticesStore.getState().remoteDeleted).toEqual([])
    expect(useDocStore.getState().openDocs.a?.externallyDeleted).toBeFalsy()
  })

  it("says nothing when the note was not open", async () => {
    useDocStore.setState({ openDocs: { a: doc("/vault/Заметки/другая.md") } })
    await mount()
    render(notes(`/vault/${ORIGINAL}`))
    await act(async () => emitRemoteDeleted([ORIGINAL]))
    expect(screen.queryByText(message)).toBeNull()
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("brings the file back from the archive of the vault", async () => {
    useDocStore.setState({ openDocs: { a: doc(`/vault/${ORIGINAL}`) } })
    vi.mocked(listTrash).mockResolvedValue([
      { id: "t0", originalPath: "/vault/Заметки/старая.md", deletedAtMs: 1, name: "старая" },
      { id: "t1", originalPath: `/vault/${ORIGINAL}`, deletedAtMs: 2, name: "идея" },
    ])
    await mount()
    render(notes(`/vault/${ORIGINAL}`))
    await act(async () => emitRemoteDeleted([ORIGINAL]))
    fireEvent.click(await screen.findByRole("button", { name: "Вернуть" }))
    await waitFor(() => expect(restoreTrash).toHaveBeenCalledWith("t1"))
    await waitFor(() => expect(screen.queryByText(message)).toBeNull())
  })

  it("keeps the message and shows an error when the archive does not have it", async () => {
    useDocStore.setState({ openDocs: { a: doc(`/vault/${ORIGINAL}`) } })
    await mount()
    render(notes(`/vault/${ORIGINAL}`))
    await act(async () => emitRemoteDeleted([ORIGINAL]))
    fireEvent.click(await screen.findByRole("button", { name: "Вернуть" }))
    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(restoreTrash).not.toHaveBeenCalled()
    expect(within(screen.getByTestId("note-notices-stack")).getByText(message)).toBeTruthy()
  })
})

describe("properties changed on another computer (З65)", () => {
  const written = { hasFrontmatter: true, properties: [], customProperties: [] }
  const withLook = {
    hasFrontmatter: true,
    properties: [],
    customProperties: [
      { id: "p", name: "Статус", icon: "star", propertyType: "text", value: "", settings: "" },
    ],
  }
  const openNote = () => {
    const note = {
      ...doc("/vault/Заметки/идея.md"),
      id: "n1",
      noteId: "n1",
      noteProperties: written,
    }
    useDocStore.setState({ openDocs: { n1: note }, externalConflicts: {} })
    vi.mocked(getNoteProperties).mockResolvedValue(withLook)
  }

  it("a written group makes the open notes read their properties again", async () => {
    await mount()
    openNote()
    await act(async () => emitAmbyWritten([".amby/properties/prop_a.jsonl"]))
    await waitFor(() => expect(useDocStore.getState().openDocs.n1.noteProperties).toEqual(withLook))
  })

  it("other files of .amby/ do not", async () => {
    await mount()
    openNote()
    await act(async () => emitAmbyWritten([".amby/blocks/n.json"]))
    expect(getNoteProperties).not.toHaveBeenCalled()
  })
})
