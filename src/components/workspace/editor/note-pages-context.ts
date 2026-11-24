import { createContext } from "react"

/** Dossiers page by their `##` sections, without the `amby-pages` flag (see `notePagesRule`). */
export const NotePagesDossierContext = createContext(false)

/** The place in the note's title row where the "Whole note / Show pages" switch is shown. */
export const NotePagesSlotContext = createContext<HTMLElement | null>(null)
