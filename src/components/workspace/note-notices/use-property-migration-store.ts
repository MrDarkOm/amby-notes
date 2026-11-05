import { create } from "zustand"
import type { OpenPropertiesView } from "@/lib/properties/property-groups-port"

export const goneKey = (noteId: string, name: string) => `${noteId}\u0000${name}`

interface PropertyMigrationState {
  /** The vault (and its generation) whose opening has been asked about; asked once. */
  key: string | null
  /** What the opening did with the properties (docs/sync-plan.md, З57, З58). */
  outcome: OpenPropertiesView | null
  /** The notice «переведены в новый формат» was closed. */
  dismissed: boolean
  /** Items of the report whose property is not in the note any more (key: note, name in the file). */
  gone: string[]
  /** The name a property of the report has now, when it was renamed in Amby (key: note, name in the file). */
  renamed: Record<string, string>
  begin: (key: string) => boolean
  finish: (key: string, outcome: OpenPropertiesView | null) => void
  dismiss: () => void
  settle: (noteId: string, name: string) => void
  /** A property of the report was renamed in Amby: the item follows it. */
  rename: (noteId: string, name: string, newName: string) => void
  /** The property of the report is not in the note any more. */
  markGone: (noteId: string, name: string) => void
}

/** The answer of the opening of the vault, shared by the notices of every note. */
export const usePropertyMigrationStore = create<PropertyMigrationState>((set, get) => ({
  key: null,
  outcome: null,
  dismissed: false,
  gone: [],
  renamed: {},
  begin: (key) => {
    if (get().key === key) return false
    set({ key, outcome: null, dismissed: false, gone: [], renamed: {} })
    return true
  },
  finish: (key, outcome) => {
    if (get().key === key) set({ outcome })
  },
  dismiss: () => set({ dismissed: true }),
  settle: (noteId, name) =>
    set((state) =>
      state.outcome
        ? {
            outcome: {
              ...state.outcome,
              diverged: state.outcome.diverged.filter(
                (item) => !(item.noteId === noteId && item.name === name),
              ),
            },
          }
        : state,
    ),
  rename: (noteId, name, newName) =>
    set((state) => {
      const item = state.outcome?.diverged.find(
        (candidate) =>
          candidate.noteId === noteId &&
          (state.renamed[goneKey(noteId, candidate.name)] ?? candidate.name) === name,
      )
      return item ? { renamed: { ...state.renamed, [goneKey(noteId, item.name)]: newName } } : state
    }),
  markGone: (noteId, name) => set((state) => ({ gone: [...state.gone, goneKey(noteId, name)] })),
}))
