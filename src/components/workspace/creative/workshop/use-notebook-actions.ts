import * as React from "react"
import { useTranslation } from "react-i18next"
import { confirmAction, createFolder, deleteItem, type NotebookCatalog } from "@/lib/storage"
import {
  absolutePathOf,
  moveCollision,
  notebookNameProblem,
  planNotebookDelete,
  sameSegments,
  siblingNames,
  subtreeIsEmpty,
  type NoteItem,
  type NotebookNode,
} from "./notebook-model"

type MoveOutcome = "moved" | "skipped" | "failed"

interface Params {
  /** The listing of the notes base, and a way to read it again right after a write. */
  catalog: NotebookCatalog | null
  reload: () => Promise<NotebookCatalog | null>
  /** Every note of the base, whatever the filter shows. */
  notes: readonly NoteItem[]
  /** Whether `notes` is all of them (the list is cut at a thousand). */
  notesComplete: boolean
  vault: string | null
  /** The tree's own move and rename: they keep open tabs on the new path and rewrite links. */
  onMoveItem?: (sourceIds: string[], targetFolderId: string | null) => void | Promise<MoveOutcome>
  onRename?: (id: string, newName: string) => void | Promise<void>
  /** Reads the file tree and the database catalog again. */
  onCreativeChanged?: () => void | Promise<void>
  /** Makes the lists read the databases again. */
  onChanged: () => void
}

export interface NotebookActions {
  /** What the last action could not do, in words; shown above the notebooks. */
  error: string | null
  clearError: () => void
  /** Shows a failure of something the caller ran itself. */
  report: (message: string) => void
  /** Makes a notebook named `name` inside `parent` (the root for `[]`); rejects with the reason. */
  createNotebook: (parent: readonly string[], name: string) => Promise<void>
  /** Renames a notebook in place; rejects with the reason. */
  renameNotebook: (node: NotebookNode, name: string) => Promise<void>
  /** Takes the notes out into the parent, then puts the empty folder in the trash. */
  deleteNotebook: (node: NotebookNode) => Promise<void>
  /** Moves a note into a notebook (`null`: out of every notebook). */
  moveNote: (noteId: string, target: readonly string[] | null) => Promise<void>
}

/**
 * Notebooks are folders, so every change goes through the vault's own file operations: the
 * tree's move and rename (links rewritten, open tabs kept), the folder creation and the trash.
 * Nothing here writes a file of its own. What can be checked first is checked before the first
 * write, and a step that cannot be undone never runs after one that failed.
 */
export function useNotebookActions({
  catalog,
  reload,
  notes,
  notesComplete,
  vault,
  onMoveItem,
  onRename,
  onCreativeChanged,
  onChanged,
}: Params): NotebookActions {
  const { t } = useTranslation()
  const [error, setError] = React.useState<string | null>(null)
  const clearError = React.useCallback(() => setError(null), [])

  const nameProblemText = (problem: NonNullable<ReturnType<typeof notebookNameProblem>>) =>
    problem === "duplicate"
      ? t("creative.notebooks.errors.duplicate")
      : t(`creative.errors.nameReason.${problem}`)
  const settle = async () => {
    await onCreativeChanged?.()
    onChanged()
    await reload()
  }

  const createNotebook = async (parent: readonly string[], name: string) => {
    setError(null)
    const fresh = (await reload()) ?? catalog
    if (!fresh || !vault) throw new Error(t("creative.notebooks.errors.unavailable"))
    const trimmed = name.trim()
    const problem = notebookNameProblem(trimmed, siblingNames(fresh.notebooks, parent))
    if (problem) throw new Error(nameProblemText(problem))
    const parentPath = absolutePathOf(fresh, parent)
    if (!parentPath) throw new Error(t("creative.notebooks.errors.unknownFolder"))
    let failure: string | null = null
    try {
      await createFolder(parentPath, trimmed)
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught)
    }
    if (failure !== null) {
      throw new Error(t("creative.notebooks.errors.createFailed", { message: failure }))
    }
    await settle()
  }

  const renameNotebook = async (node: NotebookNode, name: string) => {
    setError(null)
    const trimmed = name.trim()
    if (trimmed === node.name) return
    const fresh = (await reload()) ?? catalog
    const parent = node.segments.slice(0, -1)
    const current = fresh?.notebooks.find((entry) => sameSegments(entry.segments, node.segments))
    if (!fresh || !current || !onRename) {
      throw new Error(t("creative.notebooks.errors.unavailable"))
    }
    const problem = notebookNameProblem(trimmed, siblingNames(fresh.notebooks, parent), node.name)
    if (problem) throw new Error(nameProblemText(problem))
    await onRename(current.path, trimmed)
    // The tree's rename reports nothing back, so what the folder is called now is read.
    const after = await reload()
    const renamed = after?.notebooks.some((entry) =>
      sameSegments(entry.segments, [...parent, trimmed]),
    )
    await onCreativeChanged?.()
    onChanged()
    if (!renamed) throw new Error(t("creative.notebooks.errors.renameFailed"))
  }

  const moveNote = async (noteId: string, target: readonly string[] | null) => {
    setError(null)
    const note = notes.find((entry) => entry.noteId === noteId)
    const place = target ?? []
    if (!note || sameSegments(note.categoryPath, place)) return
    const fresh = (await reload()) ?? catalog
    const targetPath = fresh ? absolutePathOf(fresh, place) : null
    if (!fresh || !targetPath || !onMoveItem) {
      setError(t("creative.notebooks.errors.unavailable"))
      return
    }
    const clash = moveCollision(note, place, fresh.notebooks, notes)
    if (clash !== null) {
      setError(
        t("creative.notebooks.errors.moveCollision", {
          note: note.title,
          where: place.length > 0 ? place.join(" / ") : t("creative.notebooks.root"),
          other: clash,
        }),
      )
      return
    }
    const outcome = await onMoveItem([noteId], targetPath)
    if (outcome === "failed") setError(t("creative.notebooks.errors.moveFailed"))
    await settle()
  }

  const deleteNotebook = async (node: NotebookNode) => {
    setError(null)
    const fresh = await reload()
    if (!fresh || !vault || !onMoveItem) {
      setError(t("creative.notebooks.errors.unavailable"))
      return
    }
    const plan = planNotebookDelete(
      node.segments,
      fresh.notebooks,
      notes,
      notesComplete,
      !fresh.truncated,
    )
    if (plan.kind === "unsafe") {
      setError(t(`creative.notebooks.errors.unsafe.${plan.reason}`, { name: node.name }))
      return
    }
    const parent = node.segments.slice(0, -1)
    const where = parent.length > 0 ? parent.join(" / ") : t("creative.notebooks.root")
    if (plan.kind === "collisions") {
      setError(
        t("creative.notebooks.errors.deleteCollisions", {
          name: node.name,
          where,
          titles: plan.titles.join(", "),
        }),
      )
      return
    }
    const current = fresh.notebooks.find((entry) => sameSegments(entry.segments, node.segments))
    if (!current) {
      setError(t("creative.notebooks.errors.unavailable"))
      return
    }
    const confirmed = await confirmAction(
      t("creative.notebooks.deleteConfirm", {
        name: node.name,
        count: plan.moves.length,
        where,
      }),
    )
    if (!confirmed) return

    // 1. The notes go up, with their links and open tabs, by the tree's own move.
    if (plan.moves.length > 0) {
      const targetPath = absolutePathOf(fresh, parent)
      if (!targetPath) {
        setError(t("creative.notebooks.errors.unknownFolder"))
        return
      }
      const outcome = await onMoveItem(
        plan.moves.map((move) => move.noteId),
        targetPath,
      )
      if (outcome !== "moved") {
        // Some notes may already be in the parent, the rest are still here: none is lost and
        // the folder stays, so the author can look and try again.
        setError(t("creative.notebooks.errors.deleteInterrupted", { name: node.name, where }))
        await settle()
        return
      }
    }

    // 2. Only a folder that is read as empty goes to the trash.
    const after = await reload()
    if (!after || !subtreeIsEmpty(after.notebooks, node.segments)) {
      setError(t("creative.notebooks.errors.notEmptyAfter", { name: node.name }))
      await settle()
      return
    }
    try {
      // The trash the author chose, but never a permanent deletion: it must be restorable.
      // Read when it is needed: the settings store reaches this module through the module
      // catalog, so a static import would make a cycle.
      const { useSettingsStore } = await import("../../use-settings-store")
      const chosen = useSettingsStore.getState().prefs.files.deleteMode
      await deleteItem(vault, current.path, chosen === "permanent" ? "vault" : chosen)
    } catch (caught) {
      setError(
        t("creative.notebooks.errors.trashFailed", {
          name: node.name,
          message: caught instanceof Error ? caught.message : String(caught),
        }),
      )
    }
    await settle()
  }

  return {
    error,
    clearError,
    report: setError,
    createNotebook,
    renameNotebook,
    deleteNotebook,
    moveNote,
  }
}
