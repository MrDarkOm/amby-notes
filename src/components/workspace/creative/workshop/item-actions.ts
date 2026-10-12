import * as React from "react"

/** What the panel can do with a page, lent to every row by the pane. */
export interface ItemActions {
  onOpen: (noteId: string) => void
  onOpenInNewTab?: (noteId: string) => void
  /** Renames the page the way the file tree does. */
  onRename?: (noteId: string, name: string) => void
  /** Deletes the page the way the file tree does: confirmation, trash, open tabs. */
  onDelete?: (noteId: string) => void | Promise<void>
  /** Deletes several pages at once, with one confirmation that names them all. */
  onDeleteMany?: (noteIds: string[]) => void | Promise<void>
}

export const ItemActionsContext = React.createContext<ItemActions | null>(null)
