"use client"

import type { SearchResult } from "@/lib/storage"
import { SearchModal } from "./search-modal"
import type { SpotlightCreateAction } from "./sidebar-search"
import type { TreeItem } from "./sidebar-tree"

interface QuickOpenModalProps {
  open: boolean
  onClose: () => void
  treeItems: TreeItem[]
  vault?: string | null
  onSelectFile: (id: string) => void
  onNewNote: () => void
  searchNotes?: (query: string) => Promise<SearchResult[]>
  /** The note or folder open now; its folders are offered as places to search. */
  contextItemId?: string | null
  createActions?: SpotlightCreateAction[]
  /** The control the window grows out of (see `SPOTLIGHT_ORIGIN` in spotlight-motion.ts). */
  originSelector?: string
}

/**
 * Quick Open is the same Spotlight window as search, opened to open a file: the files are
 * listed before anything is typed, and the last row creates a note.
 */
export function QuickOpenModal({
  open,
  onClose,
  treeItems,
  vault,
  onSelectFile,
  onNewNote,
  searchNotes,
  contextItemId,
  createActions,
  originSelector,
}: QuickOpenModalProps) {
  return (
    <SearchModal
      open={open}
      onClose={onClose}
      items={treeItems}
      vault={vault}
      onSelect={onSelectFile}
      searchNotes={searchNotes}
      onCreateNote={onNewNote}
      createActions={createActions}
      contextItemId={contextItemId}
      originSelector={originSelector}
    />
  )
}
