import type { ReactNode } from "react"
import { NotePagesDossierContext } from "../../editor/note-pages-context"
import { NotePlaceContext, useNotePlace } from "./use-note-dossier"

/** Shares one lookup between the note's menu and its Workshop frame. */
export function CreativeNoteProvider({
  noteId,
  children,
}: {
  noteId: string | null
  children: ReactNode
}) {
  const place = useNotePlace(noteId)
  return (
    <NotePlaceContext.Provider value={place}>
      <NotePagesDossierContext.Provider value={place?.kind === "world"}>
        {children}
      </NotePagesDossierContext.Provider>
    </NotePlaceContext.Provider>
  )
}
