import { create } from "zustand"

interface NoteModulesState {
  /** Whether the Templates module is on in this window (set by the workspace). */
  templatesEnabled: boolean
  /** Whether the Daily notes module is on, with the action that opens today's note. */
  openDaily: (() => void) | null
  /** The dialog for a note from a template. */
  open: boolean
  /** Where the note goes: a folder or note path, or `null` for the vault root. */
  parentPath: string | null
  setTemplatesEnabled: (enabled: boolean) => void
  setOpenDaily: (openDaily: (() => void) | null) => void
  show: (parentPath: string | null) => void
  close: () => void
}

/**
 * The Templates and Daily notes actions offered by the file panel, the tree and the creation
 * dialog. The workspace sets what is on and mounts the one dialog that asks for the name and
 * the template.
 */
export const useNoteModulesStore = create<NoteModulesState>((set) => ({
  templatesEnabled: false,
  openDaily: null,
  open: false,
  parentPath: null,
  setTemplatesEnabled: (templatesEnabled) =>
    set((state) => ({ templatesEnabled, open: templatesEnabled && state.open })),
  setOpenDaily: (openDaily) => set({ openDaily }),
  show: (parentPath) => set({ open: true, parentPath }),
  close: () => set({ open: false }),
}))
