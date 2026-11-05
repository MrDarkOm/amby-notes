import { create } from "zustand"
import type { OpenPropertiesView } from "@/lib/properties/property-groups-port"

interface PropertyMigrationState {
  /** The vault (and its generation) whose opening has been asked about; asked once. */
  key: string | null
  /** What the opening did with the properties (docs/sync-plan.md, З57, З58). */
  outcome: OpenPropertiesView | null
  /** The notice «переведены в новый формат» was closed. */
  dismissed: boolean
  begin: (key: string) => boolean
  finish: (key: string, outcome: OpenPropertiesView | null) => void
  dismiss: () => void
  settle: (noteId: string, name: string) => void
}

/** The answer of the opening of the vault, shared by the notices of every note. */
export const usePropertyMigrationStore = create<PropertyMigrationState>((set, get) => ({
  key: null,
  outcome: null,
  dismissed: false,
  begin: (key) => {
    if (get().key === key) return false
    set({ key, outcome: null, dismissed: false })
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
}))
