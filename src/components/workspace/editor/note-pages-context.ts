import { createContext } from "react"

/** Workshop dossiers default to pages by their top-level sections (see `notePagesRule`). */
export const NotePagesDossierContext = createContext(false)

/** The place in the note's title row where the "Whole note / Show pages" switch is shown. */
export const NotePagesSlotContext = createContext<HTMLElement | null>(null)
