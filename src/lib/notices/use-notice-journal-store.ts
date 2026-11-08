import { create } from "zustand"

import { loadJournal, saveJournal } from "./journal-storage"
import {
  addJournalEntry,
  mergeJournals,
  pruneJournal,
  type JournalEntry,
  type JournalInput,
} from "./notice-journal"

interface NoticeJournalState {
  /** The vault whose journal this is, or `null` before any vault is open. */
  vault: string | null
  /** The entries, newest first. */
  entries: JournalEntry[]
  /**
   * Switches to the journal of a vault. What happened while no vault was open (a failed update at the start)
   * is kept and given to the first vault that opens; what happens while the file is being read is kept too.
   */
  open: (vault: string) => Promise<void>
  record: (input: JournalInput, now?: number) => void
  clear: () => void
  /** Resolves when everything asked to be written has been written (for tests and for quitting). */
  settled: () => Promise<void>
}

/** Reading and writing go one after another, so a write never overtakes the reading it follows. */
let chain: Promise<void> = Promise.resolve()
function enqueue(job: () => Promise<void>): Promise<void> {
  chain = chain.then(job, job).catch(() => undefined)
  return chain
}

export const useNoticeJournalStore = create<NoticeJournalState>((set, get) => {
  const persist = () => {
    const vault = get().vault
    if (vault === null) return
    void enqueue(async () => {
      // The vault was changed while this waited: the entries are no longer its own.
      if (get().vault !== vault) return
      await saveJournal(vault, get().entries)
    })
  }
  return {
    vault: null,
    entries: [],
    open: (vault) => {
      set((state) => ({ vault, entries: state.vault === null ? state.entries : [] }))
      return enqueue(async () => {
        const loaded = await loadJournal(vault, Date.now())
        if (get().vault !== vault) return
        const merged = pruneJournal(mergeJournals(get().entries, loaded), Date.now())
        const changed = merged.length !== loaded.length
        set({ entries: merged })
        if (changed) await saveJournal(vault, merged)
      })
    },
    record: (input, now = Date.now()) => {
      set((state) => ({ entries: pruneJournal(addJournalEntry(state.entries, input, now), now) }))
      persist()
    },
    clear: () => {
      set({ entries: [] })
      persist()
    },
    settled: () => chain,
  }
})
