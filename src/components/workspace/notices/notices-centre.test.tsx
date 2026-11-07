// @vitest-environment happy-dom
// The notification centre (docs/notices.md, section 5, step 2): the bell of the dock opens a side panel with
// "Needs a decision", "Attention" and the journal; the number on the bell counts the first two.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import { ACTION_DEFS, PANEL_DEFS, PERSISTENT_ACTION_BUTTONS } from "../panel-definitions"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { NoteNotices } from "../note-notices/note-notices"
import { OPEN_SETTINGS_REQUEST_EVENT } from "../settings-navigation"
import { useDocStore, type Document } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { createFakePort, emitVaultStatus, vaultStatus } from "../sync/fake-sync-port"
import { NoticesDock } from "../sync/dock-test-harness"
import { dockButton } from "../sync/dock-button"
import { SyncNoticesHost } from "../sync/sync-notices-host"
import { useSyncNoticesStore } from "../sync/use-sync-notices-store"
import { noteNoticeId } from "./centre-entries"
import { OPEN_NOTE_REQUEST_EVENT } from "./note-open-request"
import { NoticesPanel } from "./notices-panel"
import { useNoticesCentreStore } from "./use-notices-centre-store"

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  readGlobalRaw: vi.fn(async () => null),
  writeGlobalRaw: vi.fn(async () => {}),
}))

const conflict = (id: string) => ({
  id,
  kind: "bothEdited",
  originalPath: "Заметки/идея.md",
  copyPath: `Заметки/идея.${id}-conflict.md`,
  createdMs: 1_760_000_000_000,
})

const doc = (id: string): Document => ({
  id,
  title: "идея",
  content: "текст",
  created: "",
  modified: "",
  wordCount: 1,
  path: `/vault/Заметки/${id}.md`,
  source: "текст",
})

async function mountHost(status = vaultStatus()) {
  const port = createFakePort({ vaultStatus: async () => status })
  render(
    <>
      <SyncNoticesHost port={port} />
      <NoticesDock />
    </>,
  )
  await waitFor(() => expect(port.vaultStatus).toHaveBeenCalled())
  return port
}

const openCentre = async () => {
  fireEvent.click(dockButton()!)
  return screen.findByTestId("notices-centre")
}
const push = async (status: ReturnType<typeof vaultStatus>) => {
  await act(async () => emitVaultStatus(status))
}
const count = () => screen.queryByTestId("notices-dock-count")

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({ vault: "/vault" })
  useDocStore.setState({ openDocs: {}, externalConflicts: {} })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
  useNoteNoticesStore.setState(useNoteNoticesStore.getInitialState())
  useNoticesCentreStore.setState(useNoticesCentreStore.getInitialState())
  useNoticeJournalStore.setState(useNoticeJournalStore.getInitialState())
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("how the centre is built into the dock", () => {
  it("is a panel, opened by the bell, which stays the persistent action between help and settings", () => {
    const bell = ACTION_DEFS.find((item) => item.id === "notices")
    expect(bell?.kind).toBe("action")
    expect(bell?.persistent).toBe(true)
    expect(bell?.opens).toBe("notices-centre")
    expect(PANEL_DEFS.some((item) => item.id === "notices-centre")).toBe(true)
    const order = (id: string) => PERSISTENT_ACTION_BUTTONS.find((b) => b.defId === id)!.order
    expect(order("notices")).toBeGreaterThan(order("help"))
    expect(order("notices")).toBeLessThan(order("settings"))
  })

  it("opens on a click, marks the bell as active, and closes on the next click", async () => {
    await mountHost()
    expect(screen.queryByTestId("notices-centre")).toBeNull()
    await openCentre()
    expect(dockButton()!.getAttribute("data-active")).not.toBeNull()
    fireEvent.click(dockButton()!)
    await waitFor(() => expect(screen.queryByTestId("notices-centre")).toBeNull())
    expect(dockButton()!.getAttribute("data-active")).toBeNull()
  })

  it("leaves nothing of the old popover of conflicts or of the floating badge", async () => {
    await mountHost(vaultStatus({ conflicts: [conflict("aaaaaaaaaaaa")] }))
    await screen.findByTestId("notices-dock-count")
    await openCentre()
    expect(screen.queryByTestId("sync-conflict-popover")).toBeNull()
    expect(screen.queryByTestId("sync-conflict-badge")).toBeNull()
  })
})

describe("the number on the bell", () => {
  it("is not there while nothing is wrong, and the bell stays", () => {
    render(<NoticesDock />)
    expect(dockButton()).not.toBeNull()
    expect(count()).toBeNull()
  })

  it("counts the records of 'Needs a decision' and 'Attention' and takes the level of the worst", () => {
    render(<NoticesDock />)
    act(() =>
      useSyncNoticesStore.setState({
        conflicts: [conflict("aaaaaaaaaaaa"), conflict("bbbbbbbbbbbb")],
        limits: [{ kind: "quotaFull" }],
      }),
    )
    expect(count()!.textContent).toBe("3")
    expect(count()!.getAttribute("data-level")).toBe("decision")
    expect(dockButton()!.getAttribute("aria-label")).toBe("Уведомления: 3")
    expect(count()!.getAttribute("class")).toContain("--notice-decision-")
  })

  it("is a warning when only a record of 'Attention' speaks", () => {
    render(<NoticesDock />)
    act(() => useSyncNoticesStore.setState({ itemErrors: 2 }))
    expect(count()!.textContent).toBe("1")
    expect(count()!.getAttribute("data-level")).toBe("warning")
    expect(count()!.getAttribute("class")).not.toMatch(/amber/)
  })

  it("is danger when a note could not be saved", () => {
    render(<NoticesDock />)
    act(() => {
      useDocStore.setState({ openDocs: { n: doc("n") } })
      useNoteNoticesStore.getState().setSaveFailed("n", true)
      useSyncNoticesStore.setState({ itemErrors: 1 })
    })
    expect(count()!.textContent).toBe("2")
    expect(count()!.getAttribute("data-level")).toBe("danger")
  })

  it("is not changed by the journal, however long it is", () => {
    render(<NoticesDock />)
    act(() => {
      for (let i = 0; i < 40; i += 1) {
        useNoticeJournalStore.getState().record({
          kind: "restored",
          level: "info",
          subject: `n${i}.md`,
          params: { name: `n${i}` },
          target: `n${i}.md`,
        })
      }
    })
    expect(count()).toBeNull()
  })

  it("loses the number with the last cause", () => {
    render(<NoticesDock />)
    act(() => useSyncNoticesStore.setState({ conflicts: [conflict("aaaaaaaaaaaa")] }))
    expect(count()).not.toBeNull()
    act(() => useSyncNoticesStore.setState({ conflicts: [] }))
    expect(count()).toBeNull()
  })
})

describe("the sections of the centre", () => {
  it("has the journal, with a sentence for emptiness, and no empty sections of trouble", async () => {
    await mountHost()
    const centre = await openCentre()
    expect(within(centre).queryByTestId("notices-section-decision")).toBeNull()
    expect(within(centre).queryByTestId("notices-section-warning")).toBeNull()
    const journal = within(centre).getByTestId("notices-section-journal")
    expect(within(journal).getByRole("heading", { name: "Журнал" })).toBeTruthy()
    expect(within(journal).getByText("Пока ничего не происходило")).toBeTruthy()
  })

  it("puts the conflicts into 'Needs a decision', each with the one button 'Compare'", async () => {
    const port = await mountHost(
      vaultStatus({ conflicts: [conflict("aaaaaaaaaaaa"), conflict("bbbbbbbbbbbb")] }),
    )
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    const section = within(centre).getByTestId("notices-section-decision")
    expect(within(section).getByRole("heading", { name: "Требует решения" })).toBeTruthy()
    const list = within(section).getByTestId("sync-conflicts")
    expect(within(list).getAllByRole("listitem")).toHaveLength(2)
    expect(within(list).getAllByText("«идея» изменили на двух компьютерах")).toHaveLength(2)
    expect(list.textContent).not.toMatch(/conflict\.md|\.amby|Заметки\//)
    expect(within(list).getAllByRole("button")).toHaveLength(2)
    fireEvent.click(within(list).getAllByRole("button", { name: "Сравнить" })[0]!)
    expect(useSyncNoticesStore.getState().compareId).toBe("aaaaaaaaaaaa")
    expect(port.resolveConflict).not.toHaveBeenCalled()
  })

  it("takes a conflict away as soon as it is resolved", async () => {
    await mountHost(vaultStatus({ conflicts: [conflict("aaaaaaaaaaaa")] }))
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    expect(within(centre).getByTestId("notices-section-decision")).toBeTruthy()
    await push(vaultStatus({ conflicts: [] }))
    await waitFor(() => expect(within(centre).queryByTestId("notices-section-decision")).toBeNull())
    await waitFor(() => expect(count()).toBeNull())
  })

  it("puts a stop of the sync into 'Needs a decision' with a button to the settings of the sync", async () => {
    await mountHost(vaultStatus({ stop: { kind: "vaultMissing" } }))
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    const entry = within(centre).getByTestId("notices-entry")
    expect(entry.getAttribute("data-level")).toBe("decision")
    expect(entry.textContent).toMatch(/Папка хранилища не найдена/)
    const seen: unknown[] = []
    const listen = (event: Event) => seen.push((event as CustomEvent).detail)
    window.addEventListener(OPEN_SETTINGS_REQUEST_EVENT, listen)
    fireEvent.click(within(entry).getByRole("button", { name: "Открыть настройки синхронизации" }))
    window.removeEventListener(OPEN_SETTINGS_REQUEST_EVENT, listen)
    expect(seen).toEqual([{ section: "sync" }])
    // Not a place to decide: one button, no approval inside the centre.
    expect(within(entry).getAllByRole("button")).toHaveLength(1)
    await push(vaultStatus({ stop: null }))
    await waitFor(() => expect(screen.queryByTestId("notices-entry")).toBeNull())
  })

  it("says nothing about paths or service words in a stop", async () => {
    await mountHost(
      vaultStatus({
        stop: {
          kind: "massChange",
          direction: "outgoing",
          total: 40,
          files: [{ action: "delete", path: "Заметки/секрет.md" }] as never,
        },
      }),
    )
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    expect(centre.textContent).toMatch(/40/)
    expect(centre.textContent).not.toMatch(/секрет|\.md|massChange/)
  })

  it("puts a failed autosave of a note that is not open into 'Needs a decision' as danger", async () => {
    await mountHost()
    act(() =>
      useNoteNoticesStore
        .getState()
        .setClosedSaveFailed("note-1", { name: "идея", path: "Заметки/идея.md" }),
    )
    const centre = await openCentre()
    const entry = within(centre).getByTestId("notices-entry")
    expect(entry.getAttribute("data-level")).toBe("danger")
    expect(entry.getAttribute("role")).toBe("alert")
    expect(entry.textContent).toMatch(/«идея» не сохранилась/)
    expect(entry.textContent).toMatch(/Текст в черновике, не потерян/)
    const asked: unknown[] = []
    const listen = (event: Event) => asked.push((event as CustomEvent).detail)
    window.addEventListener(OPEN_NOTE_REQUEST_EVENT, listen)
    fireEvent.click(within(entry).getByRole("button", { name: "Открыть" }))
    window.removeEventListener(OPEN_NOTE_REQUEST_EVENT, listen)
    expect(asked).toEqual([{ id: "note-1" }])
  })

  it("puts the limits and the files that failed into 'Attention', as warnings", async () => {
    await mountHost(
      vaultStatus({
        itemErrors: 2,
        unsynced: [
          { path: "big.bin", reason: "tooLarge", maxBytes: 1_000_000 },
          { path: "big2.bin", reason: "tooLarge", maxBytes: 1_000_000 },
          { path: "any.md", reason: "quotaFull" },
        ] as never,
      }),
    )
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    const section = within(centre).getByTestId("notices-section-warning")
    expect(within(section).getByRole("heading", { name: "Внимание" })).toBeTruthy()
    const entries = within(section).getAllByTestId("notices-entry")
    expect(entries).toHaveLength(3)
    expect(entries.every((entry) => entry.getAttribute("data-level") === "warning")).toBe(true)
    expect(section.textContent).toMatch(/1\s?МБ|1 MB|1,0/)
    expect(count()!.textContent).toBe("3")
    expect(count()!.getAttribute("data-level")).toBe("warning")
  })

  it("leads from a limit to the list of the files in the settings", async () => {
    await mountHost(
      vaultStatus({
        unsynced: [{ path: "big.bin", reason: "tooLarge", maxBytes: 1_000_000 }] as never,
      }),
    )
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    const seen: unknown[] = []
    const listen = (event: Event) => seen.push((event as CustomEvent).detail)
    window.addEventListener(OPEN_SETTINGS_REQUEST_EVENT, listen)
    fireEvent.click(within(centre).getByRole("button", { name: "Показать" }))
    window.removeEventListener(OPEN_SETTINGS_REQUEST_EVENT, listen)
    expect(seen).toEqual([{ section: "sync" }])
  })
})

describe("hiding a record of 'Attention'", () => {
  const quota = () => vaultStatus({ unsynced: [{ path: "a.md", reason: "quotaFull" }] as never })

  it("takes it out of the section and of the number", async () => {
    await mountHost(quota())
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    fireEvent.click(within(centre).getByRole("button", { name: "Скрыть" }))
    expect(screen.queryByTestId("notices-entry")).toBeNull()
    expect(count()).toBeNull()
  })

  it("keeps it hidden while the cause stays, through any number of passes", async () => {
    await mountHost(quota())
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    fireEvent.click(within(centre).getByRole("button", { name: "Скрыть" }))
    await push(quota())
    await push(vaultStatus({ ...quota(), lastSyncMs: 1_760_000_999_000 }))
    expect(screen.queryByTestId("notices-entry")).toBeNull()
  })

  it("brings it back only after the cause has gone and come again", async () => {
    await mountHost(quota())
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    fireEvent.click(within(centre).getByRole("button", { name: "Скрыть" }))
    await push(vaultStatus())
    expect(screen.queryByTestId("notices-entry")).toBeNull()
    await push(quota())
    expect(await screen.findByTestId("notices-entry")).toBeTruthy()
    expect(count()!.textContent).toBe("1")
  })

  it("is not offered for what needs a decision", async () => {
    await mountHost(vaultStatus({ stop: { kind: "authRequired" } }))
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    expect(within(centre).queryByRole("button", { name: "Скрыть" })).toBeNull()
  })

  it("is remembered only until the restart: the hiding is in memory", () => {
    useNoticesCentreStore.getState().hide("limit:quotaFull")
    expect(useNoticesCentreStore.getState().hidden).toEqual(["limit:quotaFull"])
    expect(localStorage.getItem("amby:notices-hidden")).toBeNull()
  })
})

describe("the copies of the cards of the open notes", () => {
  it("shows the danger of an open note in the centre and in the note, as one notice", async () => {
    await mountHost()
    useDocStore.setState({ openDocs: { "/vault/Заметки/n.md": doc("/vault/Заметки/n.md") } })
    const id = "/vault/Заметки/n.md"
    render(<NoteNotices document={{ id, path: id }} warningKey={null} />)
    act(() => useNoteNoticesStore.getState().setSaveFailed(id, true))
    const card = await screen.findByTestId("note-notice-save-failed")
    expect(card).toBeTruthy()
    const centre = await openCentre()
    const entry = within(centre).getByTestId("notices-entry")
    expect(entry.getAttribute("data-entry-id")).toBe(noteNoticeId(id, "save-failed"))
    expect(entry.getAttribute("data-level")).toBe("danger")
    // Solved in either place, it is gone from both.
    act(() => useNoteNoticesStore.getState().setSaveFailed(id, false))
    await waitFor(() => expect(screen.queryByTestId("note-notice-save-failed")).toBeNull())
    expect(within(centre).queryByTestId("notices-entry")).toBeNull()
    expect(count()).toBeNull()
  })

  it("leads to the note with 'Open the note'", async () => {
    await mountHost()
    act(() => {
      useDocStore.setState({ openDocs: { n: doc("n") } })
      useNoteNoticesStore.getState().offerDraft("n", { accept() {}, reject() {} })
    })
    const centre = await openCentre()
    const entry = within(centre).getByTestId("notices-entry")
    expect(entry.getAttribute("data-level")).toBe("decision")
    const asked: unknown[] = []
    const listen = (event: Event) => asked.push((event as CustomEvent).detail)
    window.addEventListener(OPEN_NOTE_REQUEST_EVENT, listen)
    fireEvent.click(within(entry).getByRole("button", { name: "Открыть заметку" }))
    window.removeEventListener(OPEN_NOTE_REQUEST_EVENT, listen)
    expect(asked).toEqual([{ id: "n" }])
  })

  it("names the note and does not show a path", async () => {
    await mountHost()
    act(() => {
      useDocStore.setState({ openDocs: { n: doc("n") } })
      useNoteNoticesStore.getState().setSaveFailed("n", true)
    })
    const centre = await openCentre()
    const entry = within(centre).getByTestId("notices-entry")
    expect(entry.textContent).toMatch(/«n»/)
    expect(entry.textContent).not.toMatch(/\/vault|\.md/)
  })
})

describe("the journal", () => {
  const record = (name: string, subject = `${name}.md`) =>
    useNoticeJournalStore.getState().record({
      kind: "restored",
      level: "info",
      subject,
      params: { name },
      target: subject,
    })

  it("lists the events, the newest first, each with its time and a link to the note", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-07T10:00:00"))
    record("первая")
    vi.setSystemTime(new Date("2026-11-07T11:30:00"))
    record("вторая")
    vi.useRealTimers()
    render(<NoticesPanel port={createFakePort()} />)
    const rows = within(screen.getByTestId("notices-section-journal")).getAllByTestId(
      "notices-journal-entry",
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toMatch(/вторая/)
    expect(rows[1]!.textContent).toMatch(/первая/)
    expect(rows[0]!.querySelector("time")).not.toBeNull()
    const asked: unknown[] = []
    const listen = (event: Event) => asked.push((event as CustomEvent).detail)
    window.addEventListener(OPEN_NOTE_REQUEST_EVENT, listen)
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Открыть" }))
    window.removeEventListener(OPEN_NOTE_REQUEST_EVENT, listen)
    expect(asked).toEqual([{ path: "вторая.md" }])
  })

  it("writes a repeated cause once, with its number", () => {
    record("идея")
    record("идея")
    render(<NoticesPanel port={createFakePort()} />)
    const rows = screen.getAllByTestId("notices-journal-entry")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toMatch(/×\s?2/)
  })

  it("has information and success in the journal and nothing of them in the other sections", () => {
    useNoticeJournalStore.getState().record({
      kind: "backupReady",
      level: "success",
      subject: "backup",
      params: {},
    })
    record("идея")
    render(<NoticesPanel port={createFakePort()} />)
    const rows = screen.getAllByTestId("notices-journal-entry")
    expect(rows.map((row) => row.getAttribute("data-level")).sort()).toEqual(["info", "success"])
    expect(screen.queryByTestId("notices-section-decision")).toBeNull()
    expect(screen.queryByTestId("notices-section-warning")).toBeNull()
  })

  it("is cleared by hand with the button 'Clear', and the button is not there for an empty journal", () => {
    render(<NoticesPanel port={createFakePort()} />)
    expect(screen.queryByRole("button", { name: "Очистить" })).toBeNull()
    act(() => record("идея"))
    fireEvent.click(screen.getByRole("button", { name: "Очистить" }))
    expect(screen.queryByTestId("notices-journal-entry")).toBeNull()
    expect(useNoticeJournalStore.getState().entries).toEqual([])
  })

  it("is written in the language of the person at the time of reading", async () => {
    record("идея")
    const view = render(<NoticesPanel port={createFakePort()} />)
    expect(view.container.textContent).toMatch(/вернули/)
    await act(async () => {
      await i18n.changeLanguage("en")
    })
    expect(view.container.textContent).toMatch(/came back/)
    await act(async () => {
      await i18n.changeLanguage("ru")
    })
  })
})
