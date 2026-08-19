import type React from "react"
import { Database, FileText, LayoutGrid, PenLine } from "lucide-react"

export type EditorLayer = "editor" | "canvas" | "database" | "sketch"
export type DocumentViewMode = "source" | "live" | "read"

export const LAYER_OPTIONS: Array<{
  id: EditorLayer
  labelKey: string
  icon: React.ElementType
}> = [
  { id: "editor", labelKey: "docEditor.markdownEditor", icon: FileText },
  { id: "canvas", labelKey: "docEditor.canvasLayer", icon: LayoutGrid },
  {
    id: "database",
    labelKey: "docEditor.databaseLayer",
    icon: Database,
  },
  { id: "sketch", labelKey: "docEditor.sketchLayer", icon: PenLine },
]
