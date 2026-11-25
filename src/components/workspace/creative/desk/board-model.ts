import type { MoveRefusal, MovePlan, TextNode } from "../workshop/text-tree-model"

export interface BoardColumn {
  /** The page whose pages are the cards; `null` for the top pages with nothing inside. */
  id: string | null
  title: string | null
  cards: TextNode[]
}

export function boardColumns(_roots: TextNode[]): BoardColumn[] {
  throw new Error("not implemented")
}

export function boardDropPlan(
  _roots: TextNode[],
  _levels: { id: string }[],
  _draggedId: string,
  _target: { card: string } | { column: string | null },
): { plan: MovePlan } | { reason: MoveRefusal } {
  throw new Error("not implemented")
}

export function synopsisOf(_markdown: string): string {
  throw new Error("not implemented")
}
