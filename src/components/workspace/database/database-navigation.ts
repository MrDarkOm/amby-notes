/**
 * How an embedded database view reaches the rest of the app. The workspace
 * registers the real handlers; a view that is shown where nothing registered
 * them (a test, an exported page) simply does nothing when a row is clicked.
 */
export interface DatabaseNavigation {
  openNote: (noteId: string) => void
  openDatabase: (databaseId: string, title: string) => void
}

let current: DatabaseNavigation | null = null

/** Returns the function that removes this registration. */
export function registerDatabaseNavigation(navigation: DatabaseNavigation): () => void {
  current = navigation
  return () => {
    if (current === navigation) current = null
  }
}

export function openNoteFromDatabase(noteId: string): void {
  current?.openNote(noteId)
}

export function openDatabaseFromEmbed(databaseId: string, title: string): void {
  current?.openDatabase(databaseId, title)
}
