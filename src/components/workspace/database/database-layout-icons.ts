import { BarChart3, Kanban, LayoutGrid, List, Table2, type LucideIcon } from "lucide-react"

export function getViewLayoutIcon(layout: string): LucideIcon {
  switch (layout) {
    case "board":
      return Kanban
    case "gallery":
      return LayoutGrid
    case "list":
      return List
    case "chart":
      return BarChart3
    default:
      return Table2
  }
}
