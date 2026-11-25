import type { TextLevelSummary, TextPageStat } from "@/lib/storage"
import type { MovePlan, TextNode } from "../workshop/text-tree-model"

export function StoryBoard(_props: {
  roots: TextNode[]
  levels: TextLevelSummary[]
  statusOptions: { id: string; name: string; color: string; group: string }[]
  stats: Record<string, TextPageStat>
  hintsOf: (noteId: string) => string[]
  loadSynopsis: (noteId: string) => Promise<string>
  canWrite: boolean
  onOpenNote: (noteId: string) => void
  onMovePage: (pageId: string, plan: MovePlan) => void
}) {
  return null
}
