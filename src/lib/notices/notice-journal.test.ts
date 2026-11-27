// @vitest-environment happy-dom
// The journal of the notification centre (docs/notices.md, section 5): information and successes,
// kept per vault in the data of the application, for seven days. Behaviour only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { logger } from "@/lib/logger"
import { readGlobalRaw, writeGlobalRaw } from "@/lib/storage"
import {
  addJournalEntry,
  JOURNAL_DAYS,
  parseJournal,
  pruneJournal,
  serializeJournal,
  type JournalEntry,
} from "./notice-journal"
import { journalFileFor, loadJournal, saveJournal } from "./journal-storage"
import { useNoticeJournalStore } from "./use-notice-journal-store"

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  readGlobalRaw: vi.fn(),
  writeGlobalRaw: vi.fn(),
}))

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_760_000_000_000

const restored = (subject = "Заметки/идея.md") => ({
  kind: "restored" as const,
  level: "info" as const,
  subject,
  params: { name: "идея" },
  target: subject,
})

/** An in-memory stand-in for the data of the application. */
function fakeAppData() {
  const files = new Map<string, string>()
  vi.mocked(readGlobalRaw).mockImplementation(async (file) => files.get(file) ?? null)
  vi.mocked(writeGlobalRaw).mockImplementation(async (file, contents) => {
    files.set(file, contents)
  })
  return files
}

beforeEach(() => {
  vi.clearAllMocks()
  useNoticeJournalStore.setState(useNoticeJournalStore.getInitialState())
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("the entries of the journal", () => {
  it("adds an entry with its time, its level and the object it is about", () => {
    const entries = addJournalEntry([], restored(), NOW)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: "restored",
      level: "info",
      at: NOW,
      count: 1,
      target: "Заметки/идея.md",
    })
    expect(entries[0]?.id).toBeTruthy()
  })

  it("keeps the newest first", () => {
    let entries = addJournalEntry([], restored("a.md"), NOW)
    entries = addJournalEntry(entries, restored("b.md"), NOW + 1000)
    expect(entries.map((entry) => entry.subject)).toEqual(["b.md", "a.md"])
  })

  it("makes one entry with a number out of the same cause happening again", () => {
    let entries = addJournalEntry([], restored(), NOW)
    entries = addJournalEntry(entries, restored(), NOW + 5000)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ count: 2, at: NOW + 5000 })
  })

  it("does not join different causes of the same kind", () => {
    let entries = addJournalEntry([], restored("a.md"), NOW)
    entries = addJournalEntry(entries, restored("b.md"), NOW + 1)
    expect(entries).toHaveLength(2)
  })

  it("forgets what is older than seven days, and only that", () => {
    expect(JOURNAL_DAYS).toBe(7)
    const old = addJournalEntry([], restored("old.md"), NOW - 7 * DAY - 1)
    const fresh = addJournalEntry(old, restored("fresh.md"), NOW - 6 * DAY)
    expect(pruneJournal(fresh, NOW).map((entry) => entry.subject)).toEqual(["fresh.md"])
  })
})

describe("the file of the journal", () => {
  it("goes round without losing anything", () => {
    const entries = addJournalEntry([], restored(), NOW)
    const back = parseJournal(serializeJournal(entries))
    expect(back.damaged).toBe(false)
    expect(back.entries).toEqual(entries)
  })

  it("is empty, and not damaged, when there is no file yet", () => {
    expect(parseJournal(null)).toEqual({ entries: [], damaged: false })
  })

  it.each([
    ["text that is not JSON", "{{{ not json"],
    ["JSON of another shape", JSON.stringify({ version: 1, entries: "nope" })],
    ["a version from the future", JSON.stringify({ version: 99, entries: [] })],
  ])("is empty and damaged for %s", (_name, raw) => {
    expect(parseJournal(raw)).toEqual({ entries: [], damaged: true })
  })

  it("drops a single broken entry but keeps the others", () => {
    const good = addJournalEntry([], restored(), NOW)[0] as JournalEntry
    const raw = JSON.stringify({ version: 1, entries: [{ kind: 5 }, good] })
    expect(parseJournal(raw).entries).toEqual([good])
  })
})

describe("where the journal lives", () => {
  it("is a file in the data of the application, one for each vault, never in .amby/", () => {
    const one = journalFileFor("/vault/one")
    const two = journalFileFor("/vault/two")
    expect(one).not.toBe(two)
    expect(one).toBe(journalFileFor("/vault/one"))
    expect(one).not.toMatch(/\.amby/)
    expect(one).not.toMatch(/\.\.|^\//)
    // The path of the vault is not written into the name of the file.
    expect(one).not.toMatch(/vault/)
  })

  it("is saved and read back for the same vault only", async () => {
    fakeAppData()
    await saveJournal("/vault/one", addJournalEntry([], restored(), NOW))
    expect((await loadJournal("/vault/one", NOW)).map((entry) => entry.subject)).toEqual([
      "Заметки/идея.md",
    ])
    expect(await loadJournal("/vault/two", NOW)).toEqual([])
  })

  it("drops what is too old when it is read", async () => {
    fakeAppData()
    await saveJournal("/vault/one", addJournalEntry([], restored(), NOW - 8 * DAY))
    expect(await loadJournal("/vault/one", NOW)).toEqual([])
  })

  it("starts empty and says why in the log when the file is damaged", async () => {
    const files = fakeAppData()
    files.set(journalFileFor("/vault/one"), "{{{ broken")
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => null)
    expect(await loadJournal("/vault/one", NOW)).toEqual([])
    expect(warn).toHaveBeenCalledWith("notices.journal_damaged", expect.anything())
  })

  it("starts empty and says why in the log when the file cannot be read", async () => {
    vi.mocked(readGlobalRaw).mockRejectedValue(new Error("EACCES"))
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => null)
    expect(await loadJournal("/vault/one", NOW)).toEqual([])
    expect(warn).toHaveBeenCalledWith("notices.journal_unreadable", expect.anything())
  })

  it("does not fail, and does not block the work, when the file cannot be written", async () => {
    vi.mocked(writeGlobalRaw).mockRejectedValue(new Error("ENOSPC"))
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => null)
    await expect(saveJournal("/vault/one", [])).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith("notices.journal_write_failed", expect.anything())
  })
})

describe("the store of the journal", () => {
  it("keeps what happens and writes it down for the vault that is open", async () => {
    const files = fakeAppData()
    await useNoticeJournalStore.getState().open("/vault/one")
    useNoticeJournalStore.getState().record(restored())
    await useNoticeJournalStore.getState().settled()
    expect(useNoticeJournalStore.getState().entries).toHaveLength(1)
    expect(files.get(journalFileFor("/vault/one"))).toContain("restored")
  })

  it("is read again when the same vault is opened next time", async () => {
    fakeAppData()
    await useNoticeJournalStore.getState().open("/vault/one")
    useNoticeJournalStore.getState().record(restored())
    await useNoticeJournalStore.getState().settled()
    useNoticeJournalStore.setState(useNoticeJournalStore.getInitialState())
    await useNoticeJournalStore.getState().open("/vault/one")
    expect(useNoticeJournalStore.getState().entries).toHaveLength(1)
  })

  it("does not carry the entries of one vault into another", async () => {
    fakeAppData()
    await useNoticeJournalStore.getState().open("/vault/one")
    useNoticeJournalStore.getState().record(restored())
    await useNoticeJournalStore.getState().settled()
    await useNoticeJournalStore.getState().open("/vault/two")
    expect(useNoticeJournalStore.getState().entries).toEqual([])
  })

  it("keeps an entry that came while the file was being read", async () => {
    fakeAppData()
    const opening = useNoticeJournalStore.getState().open("/vault/one")
    useNoticeJournalStore.getState().record(restored())
    await opening
    await useNoticeJournalStore.getState().settled()
    expect(useNoticeJournalStore.getState().entries).toHaveLength(1)
  })

  it("keeps what happened before any vault was open and gives it to the vault that opens", async () => {
    // For example a failed update at the start of the application.
    fakeAppData()
    useNoticeJournalStore.getState().record({
      kind: "updateFailed",
      level: "info",
      subject: "update",
      params: {},
    })
    await useNoticeJournalStore.getState().open("/vault/one")
    await useNoticeJournalStore.getState().settled()
    expect(useNoticeJournalStore.getState().entries.map((entry) => entry.kind)).toEqual([
      "updateFailed",
    ])
    await useNoticeJournalStore.getState().open("/vault/two")
    expect(useNoticeJournalStore.getState().entries).toEqual([])
  })

  it("clears the entries and the file", async () => {
    const files = fakeAppData()
    await useNoticeJournalStore.getState().open("/vault/one")
    useNoticeJournalStore.getState().record(restored())
    useNoticeJournalStore.getState().clear()
    await useNoticeJournalStore.getState().settled()
    expect(useNoticeJournalStore.getState().entries).toEqual([])
    expect(parseJournal(files.get(journalFileFor("/vault/one")) ?? null).entries).toEqual([])
  })

  it("works with a damaged file: empty, and new entries are written over it", async () => {
    const files = fakeAppData()
    files.set(journalFileFor("/vault/one"), "garbage")
    vi.spyOn(logger, "warn").mockImplementation(() => null)
    await useNoticeJournalStore.getState().open("/vault/one")
    expect(useNoticeJournalStore.getState().entries).toEqual([])
    useNoticeJournalStore.getState().record(restored())
    await useNoticeJournalStore.getState().settled()
    expect(parseJournal(files.get(journalFileFor("/vault/one")) ?? null).entries).toHaveLength(1)
  })
})
