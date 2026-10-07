"use client"

import * as React from "react"
import { useDatabaseStore } from "./database-store"
import type { DatabaseViewChoice } from "./database-view-picker-model"
import {
  addView,
  duplicateView,
  removeView,
  replaceView,
  type LinkedBlock,
  type LinkedView,
} from "./linked-block"
import { LinkedTabs } from "./linked-view-controls"
import { raiseHeightFloor } from "./embedded-view-model"
import { LinkedViewPane } from "./linked-view-pane"
import { viewFromChoice } from "./linked-view-factory"
import { rememberBlockView, rememberedBlockView } from "./last-view-memory"

interface LinkedDatabaseProps {
  block: LinkedBlock
  /** The page the shortcut sits on; `@currentPage` filters and new records tie to it. */
  noteId?: string
  editable: boolean
  /** Saves the block (tabs, names, settings) into its note. */
  onBlockChange?: (next: LinkedBlock) => void
}

/**
 * A database shortcut inside a note: tabs, each a full view of a database with
 * its own name, icon and settings. All of it belongs to the note; the database
 * only supplies the rows.
 */
export function LinkedDatabase({ block, noteId, editable, onBlockChange }: LinkedDatabaseProps) {
  const databases = useDatabaseStore((state) => state.databases)
  const [activeId, setActiveIdState] = React.useState(
    () => rememberedBlockView(block.views.map((view) => view.id)) ?? block.views[0].id,
  )
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [renameSignal, setRenameSignal] = React.useState(0)
  // The tallest content seen across the tabs, so switching them does not move the text below.
  const [heightFloor, setHeightFloor] = React.useState(0)

  // Changes made in one tick build on each other, not on the block of the last render.
  const latest = React.useRef(block)
  latest.current = block

  // Reopening the note keeps the tab last looked at.
  const setActiveId = React.useCallback((id: string) => {
    setActiveIdState(id)
    rememberBlockView(
      latest.current.views.map((view) => view.id),
      id,
    )
  }, [])

  const canEdit = editable && Boolean(onBlockChange)
  const active = block.views.find((view) => view.id === activeId) ?? block.views[0]

  const commit = React.useCallback(
    (update: (current: LinkedBlock) => LinkedBlock) => {
      const next = update(latest.current)
      if (next === latest.current) return
      latest.current = next
      onBlockChange?.(next)
    },
    [onBlockChange],
  )

  const patchActive = React.useCallback(
    (patch: Partial<Omit<LinkedView, "id" | "extra">>) => {
      const id = active.id
      commit((current) => {
        const view = current.views.find((candidate) => candidate.id === id)
        return view ? replaceView(current, id, { ...view, ...patch }) : current
      })
    },
    [active.id, commit],
  )

  async function viewFor(choice: DatabaseViewChoice): Promise<LinkedView | null> {
    const database = databases.find((candidate) => candidate.databaseId === choice.databaseId)
    if (!database) return null
    return viewFromChoice(choice, database, useDatabaseStore.getState().vaultGeneration)
  }

  async function addTab(choice: DatabaseViewChoice) {
    const view = await viewFor(choice)
    if (!view) return
    commit((current) => addView(current, view, active.id))
    setActiveId(view.id)
  }

  async function changeSource(choice: DatabaseViewChoice) {
    const view = await viewFor(choice)
    if (!view) return
    // The tab keeps its own name and icon; the old database's settings are dropped.
    patchActive({
      databaseId: view.databaseId,
      layout: view.layout,
      config: view.config,
      pageFilter: undefined,
    })
  }

  function duplicateActive() {
    const copy = duplicateView(active)
    commit((current) => addView(current, copy, active.id))
    setActiveId(copy.id)
    setSettingsOpen(false)
  }

  function deleteActive() {
    const id = active.id
    const remaining = block.views.filter((view) => view.id !== id)
    if (remaining.length === 0) return
    commit((current) => removeView(current, id))
    setActiveId(remaining[0].id)
    setSettingsOpen(false)
  }

  return (
    <LinkedViewPane
      key={active.id}
      view={active}
      views={block.views}
      noteId={noteId}
      editable={canEdit}
      minHeight={heightFloor}
      onContentHeight={(height) => setHeightFloor((floor) => raiseHeightFloor(floor, height))}
      focusNameSignal={renameSignal}
      tabs={({ collapsed }) => (
        <LinkedTabs
          views={block.views}
          databases={databases}
          activeId={active.id}
          editable={canEdit}
          collapsed={collapsed}
          onSelect={(id) => {
            setActiveId(id)
            setSettingsOpen(false)
          }}
          onActivePress={() => setSettingsOpen((open) => !open)}
          onAdd={(choice) => void addTab(choice)}
          onRename={() => {
            setSettingsOpen(true)
            setRenameSignal((signal) => signal + 1)
          }}
          onEditView={() => setSettingsOpen(true)}
          onDuplicate={duplicateActive}
          onDelete={deleteActive}
        />
      )}
      onPatchView={patchActive}
      onChangeSource={(choice) => void changeSource(choice)}
      onDuplicate={duplicateActive}
      onDelete={deleteActive}
      settingsOpen={settingsOpen}
      onSettingsOpenChange={setSettingsOpen}
    />
  )
}
