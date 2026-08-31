import type * as React from "react"
import type { AutosaveCoordinator, AutosaveKey } from "../autosave/autosave-coordinator"
import type { Document } from "../use-doc-store"
import type { TreeItem } from "../sidebar-tree"
import type { FsMutationResult } from "@/lib/storage"

export interface UseFileActionsParams {
  vault: string | null
  treeItems: TreeItem[]
  setTreeItems: React.Dispatch<React.SetStateAction<TreeItem[]>>
  refreshTree: (path?: string | null) => Promise<TreeItem[]>
  applyMutationResult: (result: FsMutationResult) => void
  loadCanvas: (path: string) => Promise<void>
  setOpenCanvases: React.Dispatch<React.SetStateAction<Record<string, string>>>
  setPendingRenameId: React.Dispatch<React.SetStateAction<string | null>>
  autosaveGeneration: number
  backendGeneration: number | null
  windowLabel: string
}

export interface MarkdownAutosavePayload {
  fileId: string
  path: string
  content: string
  backendGeneration: number | null
  expectedRevision?: string
}

export interface MarkdownAutosaveActions {
  autosave: AutosaveCoordinator<MarkdownAutosavePayload>
  autosaveKey: (fileId: string) => AutosaveKey
  handleApplyMutation: (result: FsMutationResult) => void
  handleContentChange: (fileId: string, content: string) => void
  releaseUnusedDocumentBuffers: () => Promise<void>
}

export type LoadedDocument = Document
