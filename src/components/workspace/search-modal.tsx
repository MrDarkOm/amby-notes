"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { motionTransition } from "@/lib/motion-config"
import { SidebarSearch, type SpotlightCreateAction } from "./sidebar-search"
import { searchScopesFor, topLevelSearchScopes } from "./search-scope"
import { spotlightOriginFrom, spotlightTransition } from "./spotlight-motion"
import type { TreeItem } from "./sidebar-tree"
import type { SearchResult } from "@/lib/storage"

interface SearchModalProps {
  open: boolean
  onClose: () => void
  items: TreeItem[]
  onSelect: (id: string) => void
  searchNotes?: (query: string) => Promise<SearchResult[]>
  vault?: string | null
  /** The note or folder open when search starts; its folders are offered as places to search. */
  contextItemId?: string | null
  /** Opened to open a file: every file is listed at once and the last row creates a note. */
  onCreateNote?: () => void
  /** Other things to create, shown as icons next to "Create a new note". */
  createActions?: SpotlightCreateAction[]
  /** The control the window grows out of; it simply fades in when that is not on screen. */
  originSelector?: string
}

export function SearchModal({
  open,
  onClose,
  items,
  onSelect,
  searchNotes,
  vault,
  contextItemId,
  onCreateNote,
  createActions,
  originSelector,
}: SearchModalProps) {
  const { t } = useTranslation()
  // Read once per opening: the places and the origin belong to the moment it was opened.
  const scopes = React.useMemo(
    () => (open ? searchScopesFor(items, contextItemId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  )
  // Every top folder is offered too; one already listed around the open note is not repeated.
  const folderScopes = React.useMemo(() => {
    if (!open) return []
    const nearby = new Set(scopes.map((scope) => scope.id))
    return topLevelSearchScopes(items).filter((scope) => !nearby.has(scope.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scopes])
  const vaultName =
    vault
      ?.replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .pop() || undefined
  const origin = React.useMemo(
    () => (open ? spotlightOriginFrom(originSelector) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  )

  function handleSelect(id: string) {
    onSelect(id)
    onClose()
  }

  function handleCreateNote() {
    onClose()
    onCreateNote?.()
  }

  const closingCreateActions = React.useMemo(
    () =>
      createActions?.map((action) => ({
        ...action,
        run: () => {
          onClose()
          action.run()
        },
      })),
    [createActions, onClose],
  )

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          // Radix sees Escape before the field does: with a query typed, the first Escape only
          // clears it (the field handles that) and the window stays open.
          const target = event.target
          if (target instanceof HTMLInputElement && target.value) event.preventDefault()
        }}
        style={{ transformOrigin: origin ?? "50% 0" }}
        initial={{ opacity: 0, scale: origin ? 0.06 : 0.96, x: "-50%", y: 0 }}
        transition={motionTransition(spotlightTransition)}
        className="top-[14%] left-1/2 w-[640px] max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-0 grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden rounded-2xl border-border bg-background p-0 shadow-2xl sm:max-w-[640px]"
      >
        <DialogTitle className="sr-only">{t("search.title")}</DialogTitle>
        <SidebarSearch
          items={items}
          onSelect={handleSelect}
          searchNotes={searchNotes}
          vault={vault}
          scopes={scopes}
          folderScopes={folderScopes}
          vaultName={vaultName}
          onCreateNote={onCreateNote ? handleCreateNote : undefined}
          createActions={closingCreateActions}
        />
      </DialogContent>
    </Dialog>
  )
}
