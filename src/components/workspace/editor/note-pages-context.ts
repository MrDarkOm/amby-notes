import { createContext, type ReactNode } from "react"

/** Workshop dossiers default to pages by their top-level sections (see `notePagesRule`). */
export const NotePagesDossierContext = createContext(false)

/** The place in the note's title row where the "Whole note / Show pages" switch is shown. */
export const NotePagesSlotContext = createContext<HTMLElement | null>(null)

/**
 * What the note's frame shows under the page tabs, above the open page's text: given the open
 * page's title (`null` for the whole note). A dossier shows the fields of the open section here.
 */
export const NotePageAboveContext = createContext<((title: string | null) => ReactNode) | null>(
  null,
)
