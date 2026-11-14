// @vitest-environment happy-dom
// The notification centre (docs/notices.md, section 5, step 2): the bell of the dock opens a floating stack of
// cards beside it, growing upwards from the button: "Needs a decision", "Attention" and, below, the journal
// ("Earlier"); the number on the bell counts the first two.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import { ACTION_DEFS, PANEL_DEFS, PERSISTENT_ACTION_BUTTONS } from "../panel-definitions"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { NoteNotices } from "../note-notices/note-notices"
import { OPEN_SETTINGS_REQUEST_EVENT } from "../settings-navigation"
import { useDocStore, type Document } from "../use-doc-store"
import { useTabsStore } from "../use-tabs-store"
import { useVaultStore } from "../use-vault-store"
import { createFakePort, emitVaultStatus, vaultStatus } from "../sync/fake-sync-port"
import { NoticesDock } from "../sync/dock-test-harness"
import { dockButton } from "../sync/dock-button"
import { SyncNoticesHost } from "../sync/sync-notices-host"
import { useSyncNoticesStore } from "../sync/use-sync-notices-store"
import { noteNoticeId } from "./centre-entries"
import { OPEN_NOTE_REQUEST_EVENT } from "./note-open-request"
import { NoticesStack } from "./notices-stack"
import { useNoticesStackStore } from "./use-notices-stack-store"
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

// Every open note here has its tab, as in the workspace; a test closes a tab through `useTabsStore`.
let stopTabs = () => {}
beforeEach(async () => {
  useTabsStore.setState(useTabsStore.getInitialState())
  stopTabs = useDocStore.subscribe((state, previous) => {
    if (state.openDocs === previous.openDocs) return
    const known = new Set(useTabsStore.getState().tabs.map((tab) => tab.fileId))
    const added = Object.keys(state.openDocs)
      .filter((id) => !known.has(id))
      .map((id) => ({
        key: `tab-${id}`,
        kind: "document" as const,
        fileId: id,
        title: id,
        history: [],
        historyIndex: 0,
      }))
    if (added.length > 0) useTabsStore.getState().setTabs((tabs) => [...tabs, ...added])
  })
  await i18n.changeLanguage("ru")
  useVaultStore.setState({ vault: "/vault" })
  useDocStore.setState({ openDocs: {}, externalConflicts: {} })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
  useNoteNoticesStore.setState(useNoteNoticesStore.getInitialState())
  useNoticesCentreStore.setState(useNoticesCentreStore.getInitialState())
  useNoticeJournalStore.setState(useNoticeJournalStore.getInitialState())
  useNoticesStackStore.setState(useNoticesStackStore.getInitialState())
})
afterEach(() => {
  stopTabs()
  cleanup()
  vi.clearAllMocks()
})

describe("how the centre is built into the dock", () => {
  it("is opened by the bell, which stays the persistent action between help and settings, and is not a panel", () => {
    const bell = ACTION_DEFS.find((item) => item.id === "notices")
    expect(bell?.kind).toBe("action")
    expect(bell?.persistent).toBe(true)
    expect("opens" in (bell ?? {})).toBe(false)
    expect(PANEL_DEFS.some((item) => (item.id as string) === "notices-centre")).toBe(false)
    const order = (id: string) => PERSISTENT_ACTION_BUTTONS.find((b) => b.defId === id)!.order
    expect(order("notices")).toBeGreaterThan(order("help"))
    expect(order("notices")).toBeLessThan(order("settings"))
  })

  it("opens on a click, marks the bell as open, and closes on the next click", async () => {
    await mountHost()
    expect(screen.queryByTestId("notices-centre")).toBeNull()
    expect(dockButton()!.getAttribute("aria-expanded")).toBe("false")
    await openCentre()
    expect(dockButton()!.getAttribute("data-active")).not.toBeNull()
    expect(dockButton()!.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(dockButton()!)
    await waitFor(() => expect(screen.queryByTestId("notices-centre")).toBeNull())
    expect(dockButton()!.getAttribute("data-active")).toBeNull()
  })

  it("closes on a click anywhere else, and not on a click inside", async () => {
    await mountHost()
    const centre = await openCentre()
    fireEvent.pointerDown(centre)
    expect(screen.getByTestId("notices-centre")).toBeTruthy()
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByTestId("notices-centre")).toBeNull())
  })

  it("closes on Escape and gives the focus back to the bell", async () => {
    await mountHost()
    await openCentre()
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("notices-centre")).toBeNull())
    expect(document.activeElement).toBe(dockButton())
  })

  it("gives the focus back to the bell when it is closed by a click outside, too", async () => {
    await mountHost()
    const centre = await openCentre()
    centre.focus()
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByTestId("notices-centre")).toBeNull())
    expect(document.activeElement).toBe(dockButton())
  })

  it("stands beside the bell and grows upwards from it, on the side where the dock is, with a gap from the dock", async () => {
    await mountHost()
    const box = (left: number, width: number, top: number, bottom: number) =>
      ({
        left,
        right: left + width,
        top,
        bottom,
        width,
        height: bottom - top,
        x: left,
        y: top,
      }) as DOMRect
    const dock = document.querySelector<HTMLElement>("[data-activity-bar]")!
    dockButton()!.getBoundingClientRect = () => box(4, 36, 500, 530)
    dock.getBoundingClientRect = () => box(0, 48, 0, 768)
    const left = await openCentre()
    // 12px from the edge of the dock (not from the button), so no button of the dock is covered.
    expect(left.style.left).toBe("60px")
    // The foot of the stack is level with the foot of the bell, never lower.
    expect(Number.parseInt(left.style.bottom)).toBeGreaterThanOrEqual(window.innerHeight - 530)
    expect(left.style.maxHeight).toBeTruthy()
    fireEvent.click(dockButton()!)
    await waitFor(() => expect(screen.queryByTestId("notices-centre")).toBeNull())
    const edge = window.innerWidth - 48
    dockButton()!.getBoundingClientRect = () => box(edge + 8, 36, 500, 530)
    dock.getBoundingClientRect = () => box(edge, 48, 0, 768)
    const right = await openCentre()
    expect(right.style.right).toBe("60px")
    expect(right.style.left).toBe("")
  })

  it("lies on one surface like the other pop-up menus: popover colour, a thin frame, a shadow, rounded, scrolling inside", async () => {
    await mountHost(vaultStatus({ conflicts: [conflict("aaaaaaaaaaaa")], itemErrors: 1 }))
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    const classes = centre.getAttribute("class") ?? ""
    expect(classes).toContain("bg-popover")
    expect(classes).toMatch(/\bborder\b/)
    expect(classes).toMatch(/\bshadow-/)
    expect(classes).toMatch(/\brounded-/)
    expect(classes).toContain("overflow-y-auto")
    // The sections and their cards are inside it, and it takes no pointer events away from the window around.
    expect(centre.contains(screen.getByTestId("notices-section-decision"))).toBe(true)
    expect(centre.contains(screen.getByTestId("notices-section-warning"))).toBe(true)
    expect(classes).not.toContain("pointer-events-none")
  })

  it("leaves nothing of the old popover of conflicts, of the floating badge or of a side panel", async () => {
    await mountHost(vaultStatus({ conflicts: [conflict("aaaaaaaaaaaa")] }))
    await screen.findByTestId("notices-dock-count")
    await openCentre()
    expect(screen.queryByTestId("sync-conflict-popover")).toBeNull()
    expect(screen.queryByTestId("sync-conflict-badge")).toBeNull()
    expect(document.querySelector(".amby-panel-host")).toBeNull()
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
  it("has only a quiet sentence while nothing has happened", async () => {
    await mountHost()
    const centre = await openCentre()
    expect(within(centre).queryByTestId("notices-section-decision")).toBeNull()
    expect(within(centre).queryByTestId("notices-section-warning")).toBeNull()
    expect(within(centre).queryByTestId("notices-section-journal")).toBeNull()
    expect(within(centre).getByText("Пока ничего не происходило")).toBeTruthy()
  })

  it("puts the conflicts into 'Needs a decision' as cards of a decision, each with the one button 'Compare'", async () => {
    const port = await mountHost(
      vaultStatus({ conflicts: [conflict("aaaaaaaaaaaa"), conflict("bbbbbbbbbbbb")] }),
    )
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    const section = within(centre).getByTestId("notices-section-decision")
    expect(within(section).getByRole("heading", { name: "Требует решения" })).toBeTruthy()
    const cards = within(section).getAllByTestId("notices-entry")
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(card.getAttribute("data-kind")).toBe("sync-conflict")
      expect(card.getAttribute("data-level")).toBe("decision")
      expect(card.textContent).toMatch(/Заметка «идея» изменена на двух компьютерах/)
      expect(card.textContent).toMatch(/Обе версии целы/)
      expect(card.textContent).not.toMatch(/conflict\.md|\.amby|Заметки\//)
      expect(within(card).getAllByRole("button")).toHaveLength(1)
    }
    fireEvent.click(within(cards[0]!).getByRole("button", { name: "Сравнить" }))
    expect(useSyncNoticesStore.getState().compareId).toBe("aaaaaaaaaaaa")
    expect(port.resolveConflict).not.toHaveBeenCalled()
    // No separate list of conflicts with its own look.
    expect(within(centre).queryByTestId("sync-conflicts")).toBeNull()
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
    expect(entry.textContent).toMatch(/Заметка «идея» не сохранилась/)
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

  it("keeps the order: what needs a decision (danger first), then attention, then the journal", async () => {
    await mountHost(
      vaultStatus({
        conflicts: [conflict("aaaaaaaaaaaa")],
        itemErrors: 1,
      }),
    )
    act(() => {
      useDocStore.setState({ openDocs: { n: doc("n") } })
      useNoteNoticesStore.getState().setSaveFailed("n", true)
      useNoticeJournalStore.getState().record({
        kind: "backupReady",
        level: "success",
        subject: "backup",
        params: {},
      })
    })
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    const order = Array.from(
      centre.querySelectorAll(
        '[data-testid="notices-entry"], [data-testid="notices-journal-entry"]',
      ),
    ).map((node) => node.getAttribute("data-level"))
    expect(order).toEqual(["danger", "decision", "warning", "success"])
    const decision = within(centre).getByTestId("notices-section-decision")
    const warning = within(centre).getByTestId("notices-section-warning")
    const journal = within(centre).getByTestId("notices-section-journal")
    const before = (x: Element, y: Element) =>
      Boolean(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(before(decision, warning)).toBe(true)
    expect(before(warning, journal)).toBe(true)
  })
})

describe("the look of the cards of the centre (docs/notices.md, section 11)", () => {
  it("is calm: no fill, no coloured frame, a stripe and the icon of the level, for every card and every line", async () => {
    await mountHost(
      vaultStatus({
        conflicts: [conflict("aaaaaaaaaaaa")],
        stop: { kind: "vaultMissing" },
        itemErrors: 1,
      }),
    )
    act(() => {
      useDocStore.setState({ openDocs: { n: doc("n") } })
      useNoteNoticesStore.getState().setSaveFailed("n", true)
      useNoticeJournalStore.getState().record({
        kind: "backupReady",
        level: "success",
        subject: "backup",
        params: {},
      })
    })
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    const cards = centre.querySelectorAll(
      '[data-testid="notices-entry"], [data-testid="notices-journal-entry"]',
    )
    expect(cards.length).toBe(5)
    for (const card of Array.from(cards)) {
      const level = card.getAttribute("data-level")!
      const classes = card.getAttribute("class") ?? ""
      expect(classes, level).not.toMatch(/--notice-[a-z]+-bg/)
      expect(classes, level).not.toMatch(/--notice-[a-z]+-border/)
      expect(classes, level).toContain("border-l-[color:" + "var(--notice-" + level + "-fg)]")
      expect(card.querySelector("svg")?.getAttribute("class") ?? "", level).toContain(
        `--notice-${level}-fg`,
      )
    }
  })

  it("has no buttons with their own purple, and no white list of conflicts", async () => {
    await mountHost(vaultStatus({ conflicts: [conflict("aaaaaaaaaaaa")] }))
    await screen.findByTestId("notices-dock-count")
    const centre = await openCentre()
    const button = within(centre).getByRole("button", { name: "Сравнить" })
    expect(button.getAttribute("class")).not.toMatch(/bg-primary(?!-)/)
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

  it("leads to the tab of a note whose file is gone, and the copy leaves with the tab (К12)", async () => {
    await mountHost()
    act(() => {
      useDocStore.setState({ openDocs: { n: { ...doc("n"), externallyDeleted: true } } })
      useTabsStore
        .getState()
        .setTabs((tabs) => [
          ...tabs,
          { key: "other", kind: "document", fileId: "x", title: "x", history: [], historyIndex: 0 },
        ])
      useTabsStore.getState().setActiveTabKey("other")
    })
    const centre = await openCentre()
    const entry = within(centre).getByTestId("notices-entry")
    expect(entry.getAttribute("data-entry-id")).toBe(noteNoticeId("n", "external-deleted"))
    // The workspace answers the request with the tab of the note, not with the file tree.
    const { activateNoteTab } = await import("./activate-note-tab")
    expect(activateNoteTab("n")).toBe(true)
    expect(useTabsStore.getState().activeTabKey).toBe("tab-n")
    act(() => useTabsStore.getState().setTabs((tabs) => tabs.filter((tab) => tab.fileId !== "n")))
    await waitFor(() => expect(within(centre).queryByTestId("notices-entry")).toBeNull())
    expect(count()).toBeNull()
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

describe("the journal ('Earlier')", () => {
  beforeEach(() => useNoticesStackStore.setState({ isOpen: true }))

  // The automatic update could not install a version: the journal names it and links to its release
  // for a manual download; a failed check names nothing and offers no link.
  it("offers a failed automatic update for a manual download", () => {
    useNoticeJournalStore.getState().record({
      kind: "updateFailed",
      level: "info",
      subject: "automatic",
      params: { version: "0.1.9-beta.6" },
    })
    render(<NoticesStack port={createFakePort()} />)
    const row = screen.getByTestId("notices-journal-entry")
    expect(row.textContent).toMatch(/Не удалось установить обновление 0\.1\.9-beta\.6/)
    const link = within(row).getByRole("link", { name: "Скачать версию вручную" })
    expect(link.getAttribute("href")).toBe(
      "https://github.com/MrDarkOm/amby-notes/releases/tag/v0.1.9-beta.6",
    )
  })

  it("has no download link when only the check of updates failed", () => {
    useNoticeJournalStore.getState().record({
      kind: "updateFailed",
      level: "info",
      subject: "automatic",
      params: {},
    })
    render(<NoticesStack port={createFakePort()} />)
    const row = screen.getByTestId("notices-journal-entry")
    expect(row.textContent).toMatch(/Не удалось проверить обновления/)
    expect(within(row).queryByRole("link")).toBeNull()
  })

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
    render(<NoticesStack port={createFakePort()} />)
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
    render(<NoticesStack port={createFakePort()} />)
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
    render(<NoticesStack port={createFakePort()} />)
    const rows = screen.getAllByTestId("notices-journal-entry")
    expect(rows.map((row) => row.getAttribute("data-level")).sort()).toEqual(["info", "success"])
    expect(screen.queryByTestId("notices-section-decision")).toBeNull()
    expect(screen.queryByTestId("notices-section-warning")).toBeNull()
  })

  it("is headed 'Earlier', shows the last three lines, and 'Show all' opens the rest in the same stack", () => {
    for (let i = 1; i <= 5; i += 1) record(`заметка${i}`)
    render(<NoticesStack port={createFakePort()} />)
    const section = screen.getByTestId("notices-section-journal")
    expect(within(section).getByRole("heading", { name: "Ранее" })).toBeTruthy()
    expect(within(section).getAllByTestId("notices-journal-entry")).toHaveLength(3)
    // the newest three
    expect(section.textContent).toMatch(/заметка5/)
    expect(section.textContent).not.toMatch(/заметка1/)
    fireEvent.click(within(section).getByRole("button", { name: /Показать все/ }))
    expect(within(section).getAllByTestId("notices-journal-entry")).toHaveLength(5)
    expect(screen.getByTestId("notices-centre").contains(section)).toBe(true)
    expect(within(section).getByRole("button", { name: "Очистить" })).toBeTruthy()
  })

  it("has no 'Show all' when three lines or fewer are there", () => {
    for (let i = 1; i <= 3; i += 1) record(`заметка${i}`)
    render(<NoticesStack port={createFakePort()} />)
    expect(screen.queryByRole("button", { name: /Показать все/ })).toBeNull()
  })

  it("is cleared by hand with the button 'Clear', and the button is not there for an empty journal", () => {
    render(<NoticesStack port={createFakePort()} />)
    expect(screen.queryByRole("button", { name: "Очистить" })).toBeNull()
    act(() => record("идея"))
    fireEvent.click(screen.getByRole("button", { name: "Очистить" }))
    expect(screen.queryByTestId("notices-journal-entry")).toBeNull()
    expect(useNoticeJournalStore.getState().entries).toEqual([])
  })

  it("is written in the language of the person at the time of reading", async () => {
    record("идея")
    const view = render(<NoticesStack port={createFakePort()} />)
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
